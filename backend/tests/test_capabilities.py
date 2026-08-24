import asyncio
import json
import time
import unittest

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from meshtalk.encryption import decrypt_as_recipient, encrypt_for_recipient
from meshtalk.identity import Identity
from meshtalk.peer_manager import PeerConnection, PeerManager, PeerState
from meshtalk.protocol import (
    CAP_FILE_TRANSFER,
    CAP_PROFILE_SYNC,
    CAP_TEXT_CHAT,
    DEFAULT_CAPABILITIES,
    DiscoveryPacket,
    HandshakePayload,
    Packet,
    PacketType,
    TypingPayload,
    capability_for_packet,
    intersect_capabilities,
    validate_capabilities,
)

FUTURE_CAPABILITY = "CAP_ADASDASD_NEW_TEST"


class CapabilityTest(unittest.TestCase):
    def test_intersection_enables_only_shared_capabilities(self):
        self.assertEqual(
            intersect_capabilities(
                [CAP_TEXT_CHAT, CAP_PROFILE_SYNC, FUTURE_CAPABILITY],
                [CAP_TEXT_CHAT, CAP_FILE_TRANSFER],
            ),
            [CAP_TEXT_CHAT],
        )

    def test_unknown_capabilities_are_retained_for_gap_reporting(self):
        self.assertEqual(
            validate_capabilities([CAP_TEXT_CHAT, FUTURE_CAPABILITY]),
            [CAP_TEXT_CHAT, FUTURE_CAPABILITY],
        )

    def test_missing_or_invalid_capability_list_is_rejected(self):
        for value in (None, "text_chat", ["bad capability"], [CAP_TEXT_CHAT, CAP_TEXT_CHAT]):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_capabilities(value)

    def test_every_optional_packet_family_has_a_capability(self):
        mandatory = {
            PacketType.HANDSHAKE,
            PacketType.HANDSHAKE_ACK,
            PacketType.HANDSHAKE_CONFIRM,
            PacketType.PING,
            PacketType.PONG,
            PacketType.GOODBYE,
        }
        for packet_type in PacketType:
            if packet_type in mandatory:
                self.assertIsNone(capability_for_packet(packet_type))
            else:
                self.assertIsNotNone(capability_for_packet(packet_type))


class TypingPayloadTest(unittest.TestCase):
    def test_roundtrip_encrypts_context_and_verifies_signature(self):
        sender = Identity.generate("Alice")
        recipient = Identity.generate("Bob")
        payload = TypingPayload(sender.peer_id, recipient.peer_id, time.time(), b"")
        plaintext = b'{"group_id":null,"is_typing":true}'
        payload.encrypted_content = encrypt_for_recipient(
            recipient.encryption_public_key_bytes(), plaintext, payload.associated_data()
        )
        payload.signature = sender.signing_private_key.sign(payload.signed_bytes())

        decoded = TypingPayload.decode(payload.encode())
        Ed25519PublicKey.from_public_bytes(sender.signing_public_key_bytes()).verify(
            decoded.signature, decoded.signed_bytes()
        )
        self.assertEqual(
            decrypt_as_recipient(
                recipient.encryption_private_key,
                decoded.encrypted_content,
                decoded.associated_data(),
            ),
            plaintext,
        )


class HandshakePayloadTest(unittest.TestCase):
    def test_roundtrip_authenticates_capabilities_without_versions(self):
        identity = Identity.generate("Alice")
        payload = HandshakePayload(
            peer_id=identity.peer_id,
            signing_public_key=identity.signing_public_key_bytes(),
            encryption_public_key=identity.encryption_public_key_bytes(),
            display_name=identity.display_name,
            nonce=b"1" * 32,
            challenge=b"",
            signature=b"",
            capabilities=[CAP_TEXT_CHAT, FUTURE_CAPABILITY],
        )
        payload.signature = identity.signing_private_key.sign(payload.signed_bytes())
        encoded = json.loads(payload.encode())
        self.assertNotIn("protocol_version", encoded)
        self.assertNotIn("min_protocol_version", encoded)

        decoded = HandshakePayload.decode(payload.encode())
        self.assertEqual(decoded.capabilities, [CAP_TEXT_CHAT, FUTURE_CAPABILITY])
        Ed25519PublicKey.from_public_bytes(identity.signing_public_key_bytes()).verify(
            decoded.signature, decoded.signed_bytes()
        )

    def test_capability_tampering_breaks_signature(self):
        identity = Identity.generate("Alice")
        payload = HandshakePayload(
            identity.peer_id,
            identity.signing_public_key_bytes(),
            identity.encryption_public_key_bytes(),
            identity.display_name,
            b"2" * 32,
            b"",
            b"",
            [CAP_TEXT_CHAT],
        )
        payload.signature = identity.signing_private_key.sign(payload.signed_bytes())
        payload.capabilities.append(FUTURE_CAPABILITY)
        with self.assertRaises(InvalidSignature):
            Ed25519PublicKey.from_public_bytes(identity.signing_public_key_bytes()).verify(
                payload.signature, payload.signed_bytes()
            )

    def test_omitted_capabilities_are_rejected(self):
        identity = Identity.generate("Alice")
        raw = json.dumps({
            "peer_id": identity.peer_id,
            "signing_public_key": identity.signing_public_key_bytes().hex(),
            "encryption_public_key": identity.encryption_public_key_bytes().hex(),
            "display_name": identity.display_name,
            "nonce": (b"3" * 32).hex(),
            "challenge": "",
            "signature": (b"0" * 64).hex(),
        }).encode()
        with self.assertRaises(ValueError):
            HandshakePayload.decode(raw)


class DiscoveryPacketTest(unittest.TestCase):
    def test_roundtrip_has_no_protocol_version(self):
        packet = DiscoveryPacket(discovery_id="a" * 32, tcp_port=24891)
        encoded = json.loads(packet.encode())
        self.assertEqual(set(encoded), {"discovery_id", "tcp_port"})
        self.assertEqual(DiscoveryPacket.decode(packet.encode()), packet)


class CapabilityGapTest(unittest.TestCase):
    class DummyDB:
        async def upsert_peer(self, *args, **kwargs):
            pass

        async def set_peer_online(self, *args, **kwargs):
            pass

    def _manager(self, name: str, capabilities: list[str]):
        return PeerManager(
            Identity.generate(name),
            self.DummyDB(),
            on_packet=lambda *_: None,
            capabilities=capabilities,
        )

    @staticmethod
    def _signed_payload(manager: PeerManager) -> HandshakePayload:
        identity = manager.identity
        payload = HandshakePayload(
            identity.peer_id,
            identity.signing_public_key_bytes(),
            identity.encryption_public_key_bytes(),
            identity.display_name,
            b"4" * 32,
            b"",
            b"",
            list(manager.capabilities),
        )
        payload.signature = identity.signing_private_key.sign(payload.signed_bytes())
        return HandshakePayload.decode(payload.encode())

    def test_future_capability_warns_both_sides_without_disabling_shared_features(self):
        caps_a = [CAP_TEXT_CHAT, CAP_PROFILE_SYNC, FUTURE_CAPABILITY]
        caps_b = [CAP_TEXT_CHAT, CAP_PROFILE_SYNC]
        manager_a = self._manager("A", caps_a)
        manager_b = self._manager("B", caps_b)
        peer_b = PeerConnection(manager_b.identity.peer_id, "127.0.0.1", 1, PeerState.CONNECTING)
        peer_a = PeerConnection(manager_a.identity.peer_id, "127.0.0.1", 1, PeerState.CONNECTING)

        manager_a._apply_handshake(peer_b, self._signed_payload(manager_b), expected_challenge=b"")
        manager_b._apply_handshake(peer_a, self._signed_payload(manager_a), expected_challenge=b"")

        self.assertEqual(peer_b.capabilities, [CAP_PROFILE_SYNC, CAP_TEXT_CHAT])
        self.assertEqual(peer_a.capabilities, [CAP_PROFILE_SYNC, CAP_TEXT_CHAT])
        self.assertEqual(peer_b.peer_missing_capabilities, [FUTURE_CAPABILITY])
        self.assertEqual(peer_b.local_missing_capabilities, [])
        self.assertEqual(peer_a.peer_missing_capabilities, [])
        self.assertEqual(peer_a.local_missing_capabilities, [FUTURE_CAPABILITY])
        self.assertTrue(peer_a.has_capability_gap)
        self.assertTrue(peer_b.has_capability_gap)
        self.assertTrue(peer_a.supports(CAP_TEXT_CHAT))
        self.assertTrue(peer_b.supports(CAP_TEXT_CHAT))

    def test_packet_gating_blocks_only_its_required_capability(self):
        async def run():
            manager = self._manager("A", [CAP_TEXT_CHAT])
            peer = PeerConnection("peer", "127.0.0.1", 1, PeerState.CONNECTED)
            peer.capabilities = [CAP_TEXT_CHAT]
            sent = []

            class Writer:
                def write(self, data):
                    sent.append(data)

                async def drain(self):
                    pass

            peer.writer = Writer()
            await manager.send_packet(peer, Packet(PacketType.MESSAGE, b"works"))
            with self.assertRaisesRegex(ValueError, CAP_FILE_TRANSFER):
                await manager.send_packet(peer, Packet(PacketType.FILE_OFFER, b"blocked"))
            self.assertEqual(len(sent), 1)

        asyncio.run(run())

    def test_unnegotiated_inbound_packet_is_ignored_without_disconnect(self):
        manager = self._manager("A", [CAP_TEXT_CHAT])
        peer = PeerConnection("peer", "127.0.0.1", 1, PeerState.CONNECTED)
        peer.capabilities = [CAP_TEXT_CHAT]
        self.assertTrue(manager._accept_packet(peer, Packet(PacketType.MESSAGE)))
        self.assertFalse(manager._accept_packet(peer, Packet(PacketType.FILE_OFFER)))
        self.assertEqual(peer.state, PeerState.CONNECTED)

    def test_tcp_handshake_advertises_configured_capabilities(self):
        """Regression: _handshake_payload must pass self.capabilities to ensure
        TCP handshakes advertise the manager's configured capability list rather
        than defaults."""
        reduced_caps = [CAP_TEXT_CHAT, CAP_PROFILE_SYNC]
        manager = self._manager("TestPeer", reduced_caps)
        handshake = manager._handshake_payload()
        self.assertEqual(sorted(handshake.capabilities), sorted(reduced_caps))
        # Verify the handshake is correctly signed with these capabilities
        Ed25519PublicKey.from_public_bytes(manager.identity.signing_public_key_bytes()).verify(
            handshake.signature, handshake.signed_bytes()
        )


if __name__ == "__main__":
    unittest.main()
