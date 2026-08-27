import asyncio
import tempfile
import unittest
from pathlib import Path

from meshtalk.database import Database
from meshtalk.identity import Identity
from meshtalk.friends import FriendManager
from meshtalk.message_router import MessageRouter
from meshtalk.peer_manager import PeerManager
from meshtalk.protocol import HEADER_SIZE, Packet, PacketType


class DirectMessageTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        self.db_a_path, self.db_b_path = root / "a.db", root / "b.db"
        self.identity_a = Identity.generate("Alice")
        self.identity_b = Identity.generate("Bob")
        self.db_a, self.db_b = Database(self.db_a_path), Database(self.db_b_path)
        await self.db_a.connect()
        await self.db_b.connect()
        self.received = asyncio.Queue()
        self.blocked = asyncio.Queue()
        self.manager_a = PeerManager(self.identity_a, self.db_a, lambda *_: None, tcp_port=34991)
        self.manager_b = PeerManager(self.identity_b, self.db_b, lambda *_: None, tcp_port=34992)
        self.friend_a = FriendManager(self.identity_a, self.manager_a, self.db_a)
        self.friend_b = FriendManager(self.identity_b, self.manager_b, self.db_b)
        self.friend_a.on_message_blocked = self.blocked.put
        self.friend_b.on_message_blocked = self.blocked.put
        self.router_a = MessageRouter(self.identity_a, self.manager_a, self.db_a, self.received.put, friend_manager=self.friend_a)
        self.router_b = MessageRouter(self.identity_b, self.manager_b, self.db_b, self.received.put, friend_manager=self.friend_b)
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

    async def _connect_peers(self):
        initiator, recipient, port = (
            (self.manager_a, self.identity_b, 34992)
            if self.identity_a.peer_id < self.identity_b.peer_id
            else (self.manager_b, self.identity_a, 34991)
        )
        await initiator.connect_to_peer(recipient.peer_id, "127.0.0.1", port)
        await asyncio.sleep(0.05)

    async def _wait_for_request(self, request_id: str, db: Database):
        for _ in range(100):
            request = await db.get_friend_request(request_id)
            if request is not None:
                return request
            await asyncio.sleep(0.02)
        return None

    async def _become_friends(self, note: str = ""):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id, note)
        request = await self._wait_for_request(request_id, self.friend_b.db)
        self.assertIsNotNone(request)
        await self.friend_b.respond_to_friend_request(request_id, accept=True)
        await asyncio.sleep(0.05)
        self.assertTrue(await self.friend_a.is_friend(self.identity_b.peer_id))
        self.assertTrue(await self.friend_b.is_friend(self.identity_a.peer_id))
        return request_id

    async def test_direct_message_is_authenticated_and_decrypted(self):
        await self._become_friends()
        message_id, _ = await self.router_a.send_message(self.identity_b.peer_id, b"secret hello")
        received = await asyncio.wait_for(self.received.get(), 1)

        self.assertEqual(received["message_id"], message_id)
        self.assertEqual(received["sender_id"], self.identity_a.peer_id)
        self.assertEqual(received["content"], "secret hello")
        await asyncio.sleep(0.05)
        async with self.router_a.db._db.execute(
            "SELECT delivered, content FROM messages WHERE message_id = ?", (message_id,)
        ) as cursor:
            row = await cursor.fetchone()
        self.assertEqual(row[0], 1)
        self.assertIsInstance(row[1], bytes)
        self.assertNotIn(b"secret hello", row[1])
        conversation = await self.router_a.db.get_conversation(self.identity_a.peer_id, self.identity_b.peer_id)
        self.assertEqual(conversation[0]["content"], "secret hello")

    async def test_direct_reply_references_original_message(self):
        await self._become_friends()
        original_id, _ = await self.router_a.send_message(self.identity_b.peer_id, b"original")
        await asyncio.wait_for(self.received.get(), 1)
        reply_id, _ = await self.router_b.send_message(self.identity_a.peer_id, b"reply", original_id)
        received = await asyncio.wait_for(self.received.get(), 1)

        self.assertEqual(received["message_id"], reply_id)
        self.assertEqual(received["reply_to_message_id"], original_id)
        conversation = await self.router_a.db.get_conversation(self.identity_a.peer_id, self.identity_b.peer_id)
        self.assertEqual(conversation[-1]["reply_to_message_id"], original_id)

    async def test_local_message_deletion_keeps_a_tombstone(self):
        await self._become_friends()
        message_id, _ = await self.router_a.send_message(self.identity_b.peer_id, b"remove locally")
        await asyncio.wait_for(self.received.get(), 1)

        self.assertTrue(await self.router_a.db.delete_message_locally(message_id))
        conversation = await self.router_a.db.get_conversation(self.identity_a.peer_id, self.identity_b.peer_id)
        message = next(item for item in conversation if item["message_id"] == message_id)
        self.assertEqual(message["content"], "")
        self.assertEqual(message["deleted_by_local"], 1)

    async def test_non_friend_message_is_blocked_with_notice(self):
        await self._connect_peers()
        message_id, _ = await self.router_a.send_message(self.identity_b.peer_id, b"hello stranger")
        blocked = await asyncio.wait_for(self.blocked.get(), 1)

        self.assertEqual(blocked["message_id"], message_id)
        self.assertEqual(blocked["peer_id"], self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        async with self.router_b.db._db.execute(
            "SELECT COUNT(*) FROM messages WHERE message_id = ?", (message_id,)
        ) as cursor:
            row = await cursor.fetchone()
        self.assertEqual(row[0], 0)
        async with self.router_a.db._db.execute(
            "SELECT delivered, blocked FROM messages WHERE message_id = ?", (message_id,)
        ) as cursor:
            row = await cursor.fetchone()
        self.assertEqual(row[0], 0)
        self.assertEqual(row[1], 1)
        self.assertTrue(self.received.empty())

    async def test_friend_request_flow_accept_unlocks_messaging(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id, "hi bob")
        request = await self._wait_for_request(request_id, self.friend_b.db)
        self.assertIsNotNone(request)
        self.assertEqual(request["status"], "pending")
        self.assertEqual(request["direction"], "incoming")
        self.assertFalse(await self.friend_b.is_friend(self.identity_a.peer_id))

        message_id, _ = await self.router_a.send_message(self.identity_b.peer_id, b"blocked hello")
        blocked = await asyncio.wait_for(self.blocked.get(), 1)
        self.assertEqual(blocked["message_id"], message_id)

        await self.friend_b.respond_to_friend_request(request_id, accept=True)
        await asyncio.sleep(0.05)
        self.assertTrue(await self.friend_a.is_friend(self.identity_b.peer_id))
        self.assertTrue(await self.friend_b.is_friend(self.identity_a.peer_id))

        message_id, _ = await self.router_a.send_message(self.identity_b.peer_id, b"friend hello")
        received = await asyncio.wait_for(self.received.get(), 1)
        self.assertEqual(received["content"], "friend hello")

    async def test_declined_friend_request_keeps_messages_blocked_and_allows_resend(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        request = await self._wait_for_request(request_id, self.friend_b.db)
        self.assertIsNotNone(request)
        await self.friend_b.respond_to_friend_request(request_id, accept=False)
        await asyncio.sleep(0.05)
        self.assertFalse(await self.friend_a.is_friend(self.identity_b.peer_id))
        self.assertFalse(await self.friend_b.is_friend(self.identity_a.peer_id))

        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        request = await self._wait_for_request(request_id, self.friend_b.db)
        self.assertEqual(request["status"], "pending")

    async def test_unfriend_blocks_messages_again(self):
        await self._become_friends()
        await self.friend_a.unfriend(self.identity_b.peer_id)
        self.assertFalse(await self.friend_a.is_friend(self.identity_b.peer_id))

        message_id, _ = await self.router_b.send_message(self.identity_a.peer_id, b"after unfriend")
        blocked = await asyncio.wait_for(self.blocked.get(), 1)
        self.assertEqual(blocked["message_id"], message_id)
        self.assertEqual(blocked["peer_id"], self.identity_a.peer_id)

    async def test_offline_message_is_queued_when_peer_key_is_cached(self):
        await self._become_friends()
        # Drop A's live connection to B; B's public key stays cached in A's DB.
        self.manager_a.get_connected_peer(self.identity_b.peer_id).writer.close()
        await asyncio.sleep(0.1)
        self.assertIsNone(self.manager_a.get_connected_peer(self.identity_b.peer_id))

        message_id, queued = await self.router_a.send_message(self.identity_b.peer_id, b"offline hello")
        self.assertTrue(queued)
        async with self.router_a.db._db.execute(
            "SELECT queued FROM messages WHERE message_id = ?", (message_id,)
        ) as cursor:
            self.assertEqual((await cursor.fetchone())[0], 1)
        pending = await self.router_a.db.get_pending_outgoing(self.identity_b.peer_id)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["packet_type"], PacketType.MESSAGE.value)

    async def test_friendship_persists_across_database_reload(self):
        await self._become_friends()
        reopened = Database(self.db_a_path)
        await reopened.connect()
        self.assertTrue(await reopened.is_friend(self.identity_b.peer_id))
        await reopened.close()

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
        await initiator.set_tui_active(True)
        await asyncio.sleep(0.05)

        peer = remote_manager.get_connected_peer(local_identity.peer_id)
        self.assertIsNotNone(peer)
        self.assertEqual(peer.display_name, "Updated Name")
        self.assertTrue(peer.tui_active)
        stored_peer = await remote_db.get_peer(local_identity.peer_id)
        self.assertEqual(stored_peer["display_name"], "Updated Name")
        self.assertEqual(stored_peer["tui_active"], 1)

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
