import asyncio
import tempfile
import unittest
from pathlib import Path

from meshtalk.database import Database
from meshtalk.identity import Identity
from meshtalk.message_router import MessageRouter
from meshtalk.peer_manager import PeerManager
from meshtalk.protocol import HEADER_SIZE, Packet, PacketType


class DirectMessageTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        self.identity_a = Identity.generate("Alice")
        self.identity_b = Identity.generate("Bob")
        self.db_a, self.db_b = Database(root / "a.db"), Database(root / "b.db")
        await self.db_a.connect()
        await self.db_b.connect()
        self.received = asyncio.Queue()
        self.manager_a = PeerManager(self.identity_a, self.db_a, lambda *_: None, tcp_port=34991)
        self.manager_b = PeerManager(self.identity_b, self.db_b, lambda *_: None, tcp_port=34992)
        self.router_a = MessageRouter(self.identity_a, self.manager_a, self.db_a, self.received.put)
        self.router_b = MessageRouter(self.identity_b, self.manager_b, self.db_b, self.received.put)
        self.manager_a.on_packet = self.router_a.handle_packet
        self.manager_b.on_packet = self.router_b.handle_packet
        await self.manager_a.start()
        await self.manager_b.start()

    async def asyncTearDown(self):
        await self.manager_a.stop()
        await self.manager_b.stop()
        await self.db_a.close()
        await self.db_b.close()
        self.tempdir.cleanup()

    async def test_direct_message_is_authenticated_and_decrypted(self):
        initiator, recipient, port = (
            (self.manager_a, self.identity_b, 34992)
            if self.identity_a.peer_id < self.identity_b.peer_id
            else (self.manager_b, self.identity_a, 34991)
        )
        await initiator.connect_to_peer(recipient.peer_id, "127.0.0.1", port)
        await asyncio.sleep(0.05)

        sender_router = self.router_a if initiator is self.manager_a else self.router_b
        sender_identity = self.identity_a if initiator is self.manager_a else self.identity_b
        message_id = await sender_router.send_message(recipient.peer_id, b"secret hello")
        received = await asyncio.wait_for(self.received.get(), 1)

        self.assertEqual(received["message_id"], message_id)
        self.assertEqual(received["sender_id"], sender_identity.peer_id)
        self.assertEqual(received["content"], "secret hello")
        await asyncio.sleep(0.05)
        async with sender_router.db._db.execute(
            "SELECT delivered FROM messages WHERE message_id = ?", (message_id,)
        ) as cursor:
            row = await cursor.fetchone()
        self.assertEqual(row[0], 1)

    async def test_remove_peer_deletes_saved_peer(self):
        await self.db_a.upsert_peer(
            self.identity_b.peer_id,
            self.identity_b.display_name,
            self.identity_b.encryption_public_key_bytes(),
            self.identity_b.signing_public_key_bytes(),
        )
        await self.db_a.remove_peer(self.identity_b.peer_id)

        self.assertIsNone(await self.db_a.get_peer(self.identity_b.peer_id))

    async def test_authenticated_profile_update_is_persisted(self):
        initiator, recipient, port = (
            (self.manager_a, self.identity_b, 34992)
            if self.identity_a.peer_id < self.identity_b.peer_id
            else (self.manager_b, self.identity_a, 34991)
        )
        await initiator.connect_to_peer(recipient.peer_id, "127.0.0.1", port)
        await asyncio.sleep(0.05)

        local_identity = self.identity_a if initiator is self.manager_a else self.identity_b
        remote_manager = self.manager_b if initiator is self.manager_a else self.manager_a
        remote_db = self.db_b if initiator is self.manager_a else self.db_a
        local_identity.display_name = "Updated Name"
        await initiator.broadcast_profile_update()
        await asyncio.sleep(0.05)

        peer = remote_manager.get_connected_peer(local_identity.peer_id)
        self.assertIsNotNone(peer)
        self.assertEqual(peer.display_name, "Updated Name")
        stored_peer = await remote_db.get_peer(local_identity.peer_id)
        self.assertEqual(stored_peer["display_name"], "Updated Name")

    async def test_lan_peer_is_not_connected_before_challenge_confirmation(self):
        reader, writer = await asyncio.open_connection("127.0.0.1", 34992)
        initial = self.manager_a._handshake_payload()
        writer.write(Packet(PacketType.HANDSHAKE, initial.encode()).encode())
        await writer.drain()
        header = await asyncio.wait_for(reader.readexactly(HEADER_SIZE), 1)
        length, packet_type = Packet.decode_header(header)
        await reader.readexactly(length)

        self.assertEqual(packet_type, PacketType.HANDSHAKE_ACK)
        self.assertIsNone(self.manager_b.get_connected_peer(self.identity_a.peer_id))
        writer.close()
        await writer.wait_closed()
