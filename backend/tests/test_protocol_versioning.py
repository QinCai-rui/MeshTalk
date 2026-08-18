import asyncio
import json
import unittest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from meshtalk.identity import Identity
from meshtalk.protocol import (
    CAP_BLOCK_REPORTS,
    CAP_DELIVERY_RECEIPTS,
    CAP_FRIEND_REQUESTS,
    CAP_PROFILE_SYNC,
    CAP_TEXT_CHAT,
    DEFAULT_CAPABILITIES,
    DiscoveryPacket,
    HandshakePayload,
    IncompatibleProtocolError,
    intersect_capabilities,
    negotiate_protocol_version,
    validate_capabilities,
)
from meshtalk.peer_manager import PeerConnection, PeerManager, PeerState
from meshtalk.udp_transport import UdpTransport


class NegotiationTest(unittest.TestCase):
    def test_negotiate_matching(self):
        self.assertEqual(negotiate_protocol_version(1, 1, 1, 1), 1)

    def test_negotiate_overlap(self):
        # Highest mutually supported version wins.
        self.assertEqual(negotiate_protocol_version(2, 1, 3, 2), 2)

    def test_negotiate_incompatible(self):
        # Local only speaks v1; remote demands >= v3.
        self.assertIsNone(negotiate_protocol_version(1, 1, 3, 2))

    def test_negotiate_boundary_min(self):
        # agreed == max(min) is still acceptable.
        self.assertEqual(negotiate_protocol_version(2, 1, 2, 2), 2)
        self.assertEqual(negotiate_protocol_version(2, 2, 2, 1), 2)

    def test_negotiate_asymmetric_min(self):
        # One side with a higher floor must still converge on the overlap.
        self.assertEqual(negotiate_protocol_version(5, 3, 4, 1), 4)
        self.assertIsNone(negotiate_protocol_version(5, 4, 3, 1))


class CapabilityTest(unittest.TestCase):
    def test_intersect_full(self):
        self.assertEqual(
            intersect_capabilities(DEFAULT_CAPABILITIES, list(DEFAULT_CAPABILITIES)),
            sorted(DEFAULT_CAPABILITIES),
        )

    def test_intersect_partial(self):
        remote = [CAP_TEXT_CHAT, CAP_PROFILE_SYNC]
        self.assertEqual(
            intersect_capabilities(DEFAULT_CAPABILITIES, remote),
            sorted(remote),
        )

    def test_intersect_none(self):
        self.assertEqual(intersect_capabilities(DEFAULT_CAPABILITIES, ["future_cap"]), [])

    def test_intersect_ignores_unknown_and_duplicates(self):
        remote = [CAP_TEXT_CHAT, "made_up", CAP_TEXT_CHAT]
        self.assertEqual(intersect_capabilities(DEFAULT_CAPABILITIES, remote), [CAP_TEXT_CHAT])

    def test_validate_filters_unknown(self):
        self.assertEqual(validate_capabilities(["text_chat", 123, "nope"]), [CAP_TEXT_CHAT])

    def test_validate_empty_falls_back_to_default(self):
        self.assertEqual(set(validate_capabilities([])), set(DEFAULT_CAPABILITIES))
        self.assertEqual(set(validate_capabilities("not-a-list")), set(DEFAULT_CAPABILITIES))


class HandshakeSignatureCompatTest(unittest.TestCase):
    """Signed canonical must stay byte-compatible with v1 for rolling upgrades."""

    def _payload(self, identity, **overrides):
        fields = dict(
            peer_id=identity.peer_id,
            signing_public_key=identity.signing_public_key_bytes(),
            encryption_public_key=identity.encryption_public_key_bytes(),
            display_name=identity.display_name,
            nonce=b"1" * 32,
            challenge=b"",
            signature=b"",
            protocol_version=1,
            min_protocol_version=1,
            capabilities=list(DEFAULT_CAPABILITIES),
        )
        fields.update(overrides)
        return HandshakePayload(**fields)

    def test_v1_signed_bytes_excludes_version_fields(self):
        identity = Identity.generate("Alice")
        payload = self._payload(identity)
        canonical = json.loads(payload.signed_bytes())
        self.assertNotIn("protocol_version", canonical)
        self.assertNotIn("min_protocol_version", canonical)
        self.assertNotIn("capabilities", canonical)
        # Identical to the explicit legacy form.
        self.assertEqual(payload.signed_bytes(), payload.signed_bytes(legacy=True))

    def test_old_peer_handshake_verifies_on_new_code(self):
        # An older release signed only the six base fields (legacy form).
        identity = Identity.generate("Bob")
        payload = self._payload(identity)
        payload.signature = identity.signing_private_key.sign(payload.signed_bytes(legacy=True))
        pub = Ed25519PublicKey.from_public_bytes(identity.signing_public_key_bytes())
        # New code verifies with the v1 canonical -> must accept.
        pub.verify(payload.signature, payload.signed_bytes())
        # And the explicit legacy fallback also accepts it.
        pub.verify(payload.signature, payload.signed_bytes(legacy=True))

    def test_new_v1_handshake_verifies_under_old_canonical(self):
        # Proves a new v1 peer is accepted by an old peer (which only knows the
        # six-field canonical).
        identity = Identity.generate("Carol")
        payload = self._payload(identity)
        payload.signature = identity.signing_private_key.sign(payload.signed_bytes())
        old_canonical = json.dumps(
            {
                "peer_id": payload.peer_id,
                "signing_public_key": payload.signing_public_key.hex(),
                "encryption_public_key": payload.encryption_public_key.hex(),
                "display_name": payload.display_name,
                "nonce": payload.nonce.hex(),
                "challenge": payload.challenge.hex(),
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        pub = Ed25519PublicKey.from_public_bytes(identity.signing_public_key_bytes())
        pub.verify(payload.signature, old_canonical)

    def test_v2_folds_version_fields_into_signature(self):
        identity = Identity.generate("Dave")
        payload = self._payload(identity, protocol_version=2, capabilities=[CAP_TEXT_CHAT])
        payload.signature = identity.signing_private_key.sign(payload.signed_bytes())
        canonical = json.loads(payload.signed_bytes())
        self.assertEqual(canonical["protocol_version"], 2)
        self.assertEqual(canonical["capabilities"], [CAP_TEXT_CHAT])
        # A v1 (or legacy) verifier would reject the v2 signature, as expected.
        with self.assertRaises(Exception):
            Ed25519PublicKey.from_public_bytes(identity.signing_public_key_bytes()).verify(
                payload.signature, payload.signed_bytes(legacy=True)
            )


class HandshakePayloadTest(unittest.TestCase):
    def test_roundtrip_with_version_and_caps(self):
        identity = Identity.generate("Eve")
        payload = HandshakePayload(
            peer_id=identity.peer_id,
            signing_public_key=identity.signing_public_key_bytes(),
            encryption_public_key=identity.encryption_public_key_bytes(),
            display_name=identity.display_name,
            nonce=b"2" * 32,
            challenge=b"",
            signature=b"",
            protocol_version=2,
            min_protocol_version=1,
            capabilities=["text_chat", "custom_feat"],
        )
        payload.signature = identity.signing_private_key.sign(payload.signed_bytes())
        decoded = HandshakePayload.decode(payload.encode())
        self.assertEqual(decoded.protocol_version, 2)
        self.assertEqual(decoded.min_protocol_version, 1)
        # Unknown capabilities are dropped on decode.
        self.assertEqual(decoded.capabilities, [CAP_TEXT_CHAT])

    def test_decode_old_packet_defaults_to_v1(self):
        # A handshake from a pre-versioning peer has no version/capability fields.
        identity = Identity.generate("Frank")
        raw = json.dumps({
            "peer_id": identity.peer_id,
            "signing_public_key": identity.signing_public_key_bytes().hex(),
            "encryption_public_key": identity.encryption_public_key_bytes().hex(),
            "display_name": identity.display_name,
            "nonce": (b"3" * 32).hex(),
            "challenge": b"".hex(),
            "signature": (b"0" * 64).hex(),
        }).encode()
        decoded = HandshakePayload.decode(raw)
        self.assertEqual(decoded.protocol_version, 0)
        self.assertEqual(decoded.min_protocol_version, 0)
        self.assertEqual(set(decoded.capabilities), set(DEFAULT_CAPABILITIES))


class DiscoveryPacketTest(unittest.TestCase):
    def test_version_range_roundtrip(self):
        packet = DiscoveryPacket(
            protocol=2, min_protocol=1, discovery_id="a" * 32, tcp_port=24891
        )
        decoded = DiscoveryPacket.decode(packet.encode())
        self.assertEqual(decoded.protocol, 2)
        self.assertEqual(decoded.min_protocol, 1)

    def test_old_discovery_defaults_min_to_protocol(self):
        raw = json.dumps({
            "protocol": 1,
            "discovery_id": "b" * 32,
            "tcp_port": 24891,
        }).encode()
        decoded = DiscoveryPacket.decode(raw)
        self.assertEqual(decoded.min_protocol, 0)


class ApplyHandshakeTest(unittest.TestCase):
    def _manager(self):
        class DummyDB:
            async def upsert_peer(self, *args, **kwargs):
                pass

            async def set_peer_online(self, *args, **kwargs):
                pass

        return PeerManager(Identity.generate("Local"), DummyDB(), on_packet=lambda p, pkt: None)

    def _signed_payload(self, identity, **overrides):
        fields = dict(
            peer_id=identity.peer_id,
            signing_public_key=identity.signing_public_key_bytes(),
            encryption_public_key=identity.encryption_public_key_bytes(),
            display_name=identity.display_name,
            nonce=b"4" * 32,
            challenge=b"",
            signature=b"",
            protocol_version=2,
            min_protocol_version=2,
            capabilities=list(DEFAULT_CAPABILITIES),
        )
        fields.update(overrides)
        payload = HandshakePayload(**fields)
        payload.signature = identity.signing_private_key.sign(payload.signed_bytes())
        return payload

    def test_apply_stores_intersection_not_remote_raw(self):
        async def run():
            local = self._manager()
            remote = Identity.generate("Remote")
            # Remote advertises a strict subset plus an unknown capability.
            payload = self._signed_payload(
                remote, capabilities=[CAP_TEXT_CHAT, CAP_PROFILE_SYNC, "future_cap"]
            )
            peer = PeerConnection(remote.peer_id, "127.0.0.1", 24891, PeerState.CONNECTING)
            local._apply_handshake(peer, payload, expected_challenge=b"")
            self.assertEqual(peer.protocol_version, 2)
            self.assertEqual(peer.capabilities, sorted([CAP_TEXT_CHAT, CAP_PROFILE_SYNC]))
            self.assertTrue(peer.supports(CAP_TEXT_CHAT))
            self.assertFalse(peer.supports(CAP_FRIEND_REQUESTS))
            self.assertEqual(
                peer.negotiated(),
                {
                    "protocol_version": 2,
                    "remote_protocol_version": 2,
                    "min_protocol_version": 2,
                    "capabilities": sorted([CAP_TEXT_CHAT, CAP_PROFILE_SYNC]),
                },
            )

        asyncio.run(run())

    def test_apply_warns_and_allows_incompatible_version(self):
        async def run():
            local = self._manager()
            remote = Identity.generate("Remote")
            mismatched = []

            async def on_mismatch(peer_id, rv, rmin):
                mismatched.append((peer_id, rv, rmin))

            local.on_version_mismatch = on_mismatch
            payload = self._signed_payload(remote, protocol_version=3, min_protocol_version=3)
            peer = PeerConnection(remote.peer_id, "127.0.0.1", 24891, PeerState.CONNECTING)
            local._apply_handshake(peer, payload, expected_challenge=b"")
            await asyncio.sleep(0.01)
            self.assertEqual(mismatched, [(remote.peer_id, 3, 3)])

        asyncio.run(run())

    def test_apply_allows_v1_legacy_handshake_with_warning(self):
        async def run():
            local = self._manager()
            remote = Identity.generate("Legacy")
            payload = self._signed_payload(remote, protocol_version=1, min_protocol_version=1)
            # Strip version fields the way an old peer would (legacy signature).
            payload.signature = remote.signing_private_key.sign(payload.signed_bytes(legacy=True))
            peer = PeerConnection(remote.peer_id, "127.0.0.1", 24891, PeerState.CONNECTING)
            local._apply_handshake(peer, payload, expected_challenge=b"")

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
