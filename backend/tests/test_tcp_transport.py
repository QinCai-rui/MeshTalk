import asyncio
import json
import struct
import unittest

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from meshtalk.identity import Identity
from meshtalk.peer_manager import PeerManager
from meshtalk.protocol import (
    DEFAULT_CAPABILITIES,
    MAX_PACKET_SIZE,
    HandshakePayload,
    Packet,
    PacketType,
)
from meshtalk.tcp_transport import (
    TCP_MAX_RECORD_SIZE,
    TCP_MAX_SEQUENCE,
    TCP_RECORD_HEADER_FORMAT,
    TCP_RECORD_HEADER_SIZE,
    TcpSession,
    TcpTransportError,
)


def _public_bytes(private_key: X25519PrivateKey) -> bytes:
    """Extract the raw 32-byte public key from an X25519 private key."""
    return private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


def _signed_handshake(
    identity: Identity,
    private_key: X25519PrivateKey,
    nonce: bytes,
    challenge: bytes = b"",
) -> HandshakePayload:
    """Create and sign a handshake payload with the given identity, session key, and nonce."""
    payload = HandshakePayload(
        peer_id=identity.peer_id,
        signing_public_key=identity.signing_public_key_bytes(),
        encryption_public_key=identity.encryption_public_key_bytes(),
        display_name=identity.display_name,
        nonce=nonce,
        challenge=challenge,
        signature=b"",
        capabilities=list(DEFAULT_CAPABILITIES),
        session_public_key=_public_bytes(private_key),
    )
    payload.signature = identity.signing_private_key.sign(payload.signed_bytes())
    return payload


class TcpSessionTest(unittest.TestCase):
    def setUp(self):
        self.local = Identity.generate("Local")
        self.remote = Identity.generate("Remote")
        self.local_private = X25519PrivateKey.generate()
        self.remote_private = X25519PrivateKey.generate()
        self.local_payload = _signed_handshake(self.local, self.local_private, b"l" * 32)
        self.remote_payload = _signed_handshake(
            self.remote, self.remote_private, b"r" * 32, self.local_payload.nonce
        )
        self.local_session = TcpSession.derive(
            self.local.peer_id,
            self.remote.peer_id,
            self.local_private,
            self.local_payload,
            self.remote_payload,
        )
        self.remote_session = TcpSession.derive(
            self.remote.peer_id,
            self.local.peer_id,
            self.remote_private,
            self.remote_payload,
            self.local_payload,
        )

    def test_key_derivation_is_directional_and_transcript_bound(self):
        self.assertEqual(self.local_session.session_id, self.remote_session.session_id)
        self.assertEqual(
            self.local_session.transmit_encryption_key,
            self.remote_session.receive_encryption_key,
        )
        self.assertEqual(
            self.local_session.receive_encryption_key,
            self.remote_session.transmit_encryption_key,
        )
        self.assertNotEqual(
            self.local_session.transmit_encryption_key,
            self.local_session.receive_encryption_key,
        )

        fresh_private = X25519PrivateKey.generate()
        fresh_payload = _signed_handshake(self.local, fresh_private, b"n" * 32)
        fresh_session = TcpSession.derive(
            self.local.peer_id,
            self.remote.peer_id,
            fresh_private,
            fresh_payload,
            self.remote_payload,
        )
        self.assertNotEqual(self.local_session.session_id, fresh_session.session_id)

    def test_records_encrypt_application_packets_and_round_trip(self):
        packet = Packet(PacketType.MESSAGE, b"routing metadata and secret content")
        record = self.local_session.encrypt_packet(packet)
        header, ciphertext = record[:TCP_RECORD_HEADER_SIZE], record[TCP_RECORD_HEADER_SIZE:]

        length, sequence = TcpSession.validate_record_header(header)
        self.assertEqual(length, len(ciphertext))
        self.assertEqual(sequence, 0)
        self.assertNotIn(packet.encode(), record)
        self.assertNotIn(packet.payload, record)
        self.assertEqual(self.remote_session.decrypt_record(header, ciphertext), packet)

        reply = Packet(PacketType.PONG)
        reply_record = self.remote_session.encrypt_packet(reply)
        self.assertEqual(
            self.local_session.decrypt_record(
                reply_record[:TCP_RECORD_HEADER_SIZE], reply_record[TCP_RECORD_HEADER_SIZE:]
            ),
            reply,
        )

    def test_ciphertext_and_associated_data_tampering_is_rejected(self):
        record = self.local_session.encrypt_packet(Packet(PacketType.PROFILE, b"profile"))
        header, ciphertext = record[:TCP_RECORD_HEADER_SIZE], record[TCP_RECORD_HEADER_SIZE:]

        tampered_ciphertext = bytearray(ciphertext)
        tampered_ciphertext[-1] ^= 1
        with self.assertRaises(TcpTransportError):
            self.remote_session.decrypt_record(header, bytes(tampered_ciphertext))

        # Move the receiver to the modified sequence so the changed header is
        # tested as AEAD associated data rather than rejected by ordering first.
        self.remote_session.receive_sequence = 1
        tampered_header = struct.pack(TCP_RECORD_HEADER_FORMAT, len(ciphertext), 1)
        with self.assertRaises(TcpTransportError):
            self.remote_session.decrypt_record(tampered_header, ciphertext)

    def test_replayed_and_out_of_order_records_are_rejected(self):
        first = self.local_session.encrypt_packet(Packet(PacketType.PING))
        second = self.local_session.encrypt_packet(Packet(PacketType.PONG))
        first_header, first_body = first[:TCP_RECORD_HEADER_SIZE], first[TCP_RECORD_HEADER_SIZE:]
        second_header, second_body = second[:TCP_RECORD_HEADER_SIZE], second[TCP_RECORD_HEADER_SIZE:]

        self.remote_session.decrypt_record(first_header, first_body)
        with self.assertRaises(TcpTransportError):
            self.remote_session.decrypt_record(first_header, first_body)

        other_remote = TcpSession.derive(
            self.remote.peer_id,
            self.local.peer_id,
            self.remote_private,
            self.remote_payload,
            self.local_payload,
        )
        with self.assertRaises(TcpTransportError):
            other_remote.decrypt_record(second_header, second_body)

    def test_invalid_lengths_and_sequence_exhaustion_fail_safely(self):
        for length in (0, TCP_MAX_RECORD_SIZE + 1):
            with self.subTest(length=length), self.assertRaises(TcpTransportError):
                TcpSession.validate_record_header(struct.pack(TCP_RECORD_HEADER_FORMAT, length, 0))
        with self.assertRaises(TcpTransportError):
            TcpSession.validate_record_header(
                struct.pack(TCP_RECORD_HEADER_FORMAT, 16, TCP_MAX_SEQUENCE)
            )

        record = self.local_session.encrypt_packet(Packet(PacketType.PING))
        with self.assertRaises(TcpTransportError):
            self.remote_session.decrypt_record(
                record[:TCP_RECORD_HEADER_SIZE], record[TCP_RECORD_HEADER_SIZE:-1]
            )

        self.local_session.send_sequence = TCP_MAX_SEQUENCE
        with self.assertRaises(TcpTransportError):
            self.local_session.encrypt_packet(Packet(PacketType.PING))

    def test_oversized_application_packet_is_rejected(self):
        with self.assertRaises(ValueError):
            self.local_session.encrypt_packet(
                Packet(PacketType.FILE_CHUNK, b"x" * (MAX_PACKET_SIZE + 1))
            )


class _DummyDatabase:
    async def upsert_peer(self, *args, **kwargs):
        pass

    async def set_peer_online(self, *args, **kwargs):
        pass

    async def save_peer_endpoint(self, *args, **kwargs):
        pass


class TcpPeerManagerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.identity_a = Identity.generate("Alice")
        self.identity_b = Identity.generate("Bob")
        self.received = asyncio.Queue()
        self.manager_a = PeerManager(
            self.identity_a, _DummyDatabase(), self.received.put, tcp_port=0
        )
        self.manager_b = PeerManager(
            self.identity_b, _DummyDatabase(), self.received.put, tcp_port=0
        )
        await self.manager_a.start()
        await self.manager_b.start()

    async def asyncTearDown(self):
        await self.manager_a.stop()
        await self.manager_b.stop()

    async def test_legacy_handshake_is_rejected_without_plaintext_fallback(self):
        port = self.manager_b._server.sockets[0].getsockname()[1]
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        identity = self.identity_a
        value = {
            "peer_id": identity.peer_id,
            "signing_public_key": identity.signing_public_key_bytes().hex(),
            "encryption_public_key": identity.encryption_public_key_bytes().hex(),
            "display_name": identity.display_name,
            "nonce": (b"l" * 32).hex(),
            "challenge": "",
            "capabilities": list(DEFAULT_CAPABILITIES),
        }
        value["signature"] = identity.signing_private_key.sign(
            json.dumps(
                {key: value[key] for key in value if key != "signature"},
                separators=(",", ":"),
                sort_keys=True,
            ).encode()
        ).hex()
        writer.write(Packet(PacketType.HANDSHAKE, json.dumps(value).encode()).encode())
        await writer.drain()

        self.assertEqual(await asyncio.wait_for(reader.read(1), 1), b"")
        writer.close()
        await asyncio.wait_for(writer.wait_closed(), 1)
        await asyncio.sleep(0.05)
        self.assertEqual(self.manager_b.get_connected_peers(), [])
        self.assertEqual(self.manager_b._incoming_handshakes, 0)
        self.assertFalse(self.manager_b._receive_tasks)
        self.assertTrue(self.received.empty())

    async def test_stop_cancels_pending_handshake_tasks(self):
        manager = PeerManager(Identity.generate("Pending"), _DummyDatabase(), lambda *_: None, tcp_port=0)
        await manager.start()
        port = manager._server.sockets[0].getsockname()[1]
        _, writer = await asyncio.open_connection("127.0.0.1", port)
        await asyncio.sleep(0.02)

        await asyncio.wait_for(manager.stop(), 2)
        writer.close()
        await asyncio.wait_for(writer.wait_closed(), 1)
        self.assertEqual(manager._incoming_handshakes, 0)
        self.assertFalse(manager._handshake_tasks)
        self.assertFalse(manager._connection_tasks)
        self.assertEqual(manager.get_connected_peers(), [])

    async def test_simultaneous_connections_converge_on_one_lower_id_direction(self):
        port_a = self.manager_a._server.sockets[0].getsockname()[1]
        port_b = self.manager_b._server.sockets[0].getsockname()[1]
        await asyncio.gather(
            self.manager_a.connect_to_peer(None, "127.0.0.1", port_b),
            self.manager_b.connect_to_peer(None, "127.0.0.1", port_a),
        )

        async with asyncio.timeout(2):
            while not (
                self.manager_a.get_connected_peer(self.identity_b.peer_id)
                and self.manager_b.get_connected_peer(self.identity_a.peer_id)
            ):
                await asyncio.sleep(0.01)

        self.assertEqual(len(self.manager_a.get_connected_peers()), 1)
        self.assertEqual(len(self.manager_b.get_connected_peers()), 1)
        self.assertEqual(
            self.manager_a.get_connected_peer(self.identity_b.peer_id).tcp_session.session_id,
            self.manager_b.get_connected_peer(self.identity_a.peer_id).tcp_session.session_id,
        )

    async def test_tampered_record_disconnects_without_dispatching_application_data(self):
        port_a = self.manager_a._server.sockets[0].getsockname()[1]
        port_b = self.manager_b._server.sockets[0].getsockname()[1]
        initiator = self.manager_a if self.identity_a.peer_id < self.identity_b.peer_id else self.manager_b
        target_port = port_b if initiator is self.manager_a else port_a
        await initiator.connect_to_peer(
            self.identity_b.peer_id if initiator is self.manager_a else self.identity_a.peer_id,
            "127.0.0.1",
            target_port,
        )
        async with asyncio.timeout(2):
            while not (
                self.manager_a.get_connected_peer(self.identity_b.peer_id)
                and self.manager_b.get_connected_peer(self.identity_a.peer_id)
            ):
                await asyncio.sleep(0.01)

        sender = self.manager_a.get_connected_peer(self.identity_b.peer_id)
        record = bytearray(sender.tcp_session.encrypt_packet(Packet(PacketType.MESSAGE, b"tampered")))
        record[-1] ^= 1
        sender.writer.write(record)
        await sender.writer.drain()

        async with asyncio.timeout(2):
            while self.manager_b.get_connected_peer(self.identity_a.peer_id) is not None:
                await asyncio.sleep(0.01)
        self.assertTrue(self.received.empty())
