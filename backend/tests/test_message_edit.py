import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from meshtalk.database import Database
from meshtalk.encryption import encrypt_for_recipient
from meshtalk.friends import FriendManager
from meshtalk.group_router import GroupRouter
from meshtalk.identity import Identity
from meshtalk.message_router import MessageRouter
from meshtalk.protocol import (
    CAP_GROUP_CHAT,
    CAP_MESSAGE_EDITS,
    MessageEditPayload,
    GroupMessageEditPayload,
    Packet,
    PacketType,
    capability_for_packet,
)


class MessageEditProtocolTest(unittest.TestCase):
    def test_edit_packet_types_and_capability(self):
        self.assertEqual(PacketType.MESSAGE_EDIT, 0x15)
        self.assertEqual(PacketType.GROUP_MESSAGE_EDIT, 0x16)
        self.assertEqual(CAP_MESSAGE_EDITS, "message_edits")
        self.assertEqual(capability_for_packet(PacketType.MESSAGE_EDIT), CAP_MESSAGE_EDITS)
        self.assertEqual(capability_for_packet(PacketType.GROUP_MESSAGE_EDIT), CAP_MESSAGE_EDITS)

    def test_direct_edit_payload_round_trip(self):
        payload = MessageEditPayload("m1", "alice", "bob", 1000.0, b"cipher")
        payload.signature = b"s" * 64
        decoded = MessageEditPayload.decode(payload.encode())
        self.assertEqual(decoded.message_id, "m1")
        self.assertEqual(decoded.sender_id, "alice")
        self.assertEqual(decoded.recipient_id, "bob")
        self.assertEqual(decoded.created_at, 1000.0)
        self.assertEqual(decoded.encrypted_content, b"cipher")
        self.assertIn(b"m1", payload.associated_data())
        self.assertIn(b"edit", payload.associated_data())

    def test_group_edit_payload_round_trip(self):
        payload = GroupMessageEditPayload("m1", "a" * 32, "alice", "bob", 1000.0, b"cipher")
        payload.signature = b"s" * 64
        decoded = GroupMessageEditPayload.decode(payload.encode())
        self.assertEqual(decoded.message_id, "m1")
        self.assertEqual(decoded.group_id, "a" * 32)
        self.assertEqual(decoded.sender_id, "alice")
        self.assertIn(b"edit", payload.associated_data())

    def test_edit_payload_rejects_bad_ids(self):
        bad = b'{"message_id": "", "sender_id": "alice", "recipient_id": "bob", "created_at": 1, "encrypted_content": "", "signature": "' + (b"s" * 64).hex().encode() + b'"}'
        with self.assertRaises(ValueError):
            MessageEditPayload.decode(bad)


class MessageEditDatabaseTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.tempdir.name) / "edit.db")
        await self.db.connect()

    async def asyncTearDown(self):
        await self.db.close()
        self.tempdir.cleanup()

    async def _save_direct(self, message_id="m1", content="original"):
        await self.db.save_message({
            "message_id": message_id, "sender_id": "alice", "recipient_id": "bob",
            "content": content, "encrypted_content": b"raw",
            "created_at": 1000.0, "hop_count": 0, "max_hops": 0,
        })

    async def test_update_message_content_sets_edited_at(self):
        await self._save_direct()
        self.assertTrue(await self.db.update_message_content("m1", "corrected"))
        stored = await self.db.get_message("m1")
        self.assertEqual(stored["content"], "corrected")
        self.assertGreater(stored["edited_at"], 0)
        conversation = await self.db.get_conversation("alice", "bob")
        self.assertEqual(conversation[0]["content"], "corrected")
        self.assertGreater(conversation[0]["edited_at"], 0)

    async def test_update_missing_message_returns_false(self):
        self.assertFalse(await self.db.update_message_content("nope", "x"))
        self.assertIsNone(await self.db.get_message("nope"))

    async def test_update_group_message_content_sets_edited_at(self):
        await self.db.save_group_message({
            "message_id": "g1", "group_id": "a" * 32, "sender_id": "alice",
            "content": "original", "created_at": 1000.0,
        })
        self.assertTrue(await self.db.update_group_message_content("g1", "corrected"))
        stored = await self.db.get_group_message("g1")
        self.assertGreater(stored["edited_at"], 0)
        history = await self.db.get_group_messages("a" * 32)
        self.assertEqual(history[0]["content"], "corrected")
        self.assertGreater(history[0]["edited_at"], 0)


FULL_CAPS = {"text_chat", "message_replies", CAP_MESSAGE_EDITS, "delivery_receipts", CAP_GROUP_CHAT}


class _Peer:
    def __init__(self, identity, caps=None):
        self.peer_id = identity.peer_id
        self.display_name = identity.display_name
        self.encryption_public_key = identity.encryption_public_key_bytes()
        self.signing_public_key = identity.signing_public_key_bytes()
        self.caps = set(caps) if caps is not None else set(FULL_CAPS)

    def supports(self, capability):
        return capability in self.caps


class _PeerManager:
    def __init__(self, *peers):
        self.peers = {peer.peer_id: peer for peer in peers}
        self.sent = []

    def get_connected_peer(self, peer_id):
        return self.peers.get(peer_id)

    async def send_packet(self, peer, packet):
        self.sent.append((peer, packet))


class MessageEditRouterTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        self.alice = Identity.generate("Alice")
        self.bob = Identity.generate("Bob")
        self.db_a = Database(root / "a.db")
        self.db_b = Database(root / "b.db")
        await self.db_a.connect()
        await self.db_b.connect()
        await self.db_a.add_friend(self.bob.peer_id, "Bob")
        await self.db_b.add_friend(self.alice.peer_id, "Alice")
        self.mgr_a = _PeerManager(_Peer(self.bob))
        self.mgr_b = _PeerManager(_Peer(self.alice))
        self.edited_a = asyncio.Queue()
        self.edited_b = asyncio.Queue()
        self.router_a = MessageRouter(
            self.alice, self.mgr_a, self.db_a, None,
            friend_manager=FriendManager(self.alice, self.mgr_a, self.db_a),
            on_edited=self.edited_a.put,
        )
        self.router_b = MessageRouter(
            self.bob, self.mgr_b, self.db_b, None,
            friend_manager=FriendManager(self.bob, self.mgr_b, self.db_b),
            on_edited=self.edited_b.put,
        )

    async def asyncTearDown(self):
        await self.db_a.close()
        await self.db_b.close()
        self.tempdir.cleanup()

    async def _save_both(self, message_id="m1", content="original"):
        for db, sender, recipient in (
            (self.db_a, self.alice.peer_id, self.bob.peer_id),
            (self.db_b, self.alice.peer_id, self.bob.peer_id),
        ):
            await db.save_message({
                "message_id": message_id, "sender_id": sender, "recipient_id": recipient,
                "content": content, "encrypted_content": b"raw",
                "created_at": 1000.0, "hop_count": 0, "max_hops": 0,
            })
            await db.mark_message_seen(message_id)

    async def test_edit_propagates_online(self):
        await self._save_both()
        edited_at = await self.router_a.send_edit(self.bob.peer_id, "m1", "corrected")
        self.assertGreater(edited_at, 0)
        self.assertEqual(len(self.mgr_a.sent), 1)
        peer, packet = self.mgr_a.sent[0]
        self.assertEqual(packet.type, PacketType.MESSAGE_EDIT)

        await self.router_b.handle_packet(_Peer(self.alice), packet)
        event = await asyncio.wait_for(self.edited_b.get(), 1)
        self.assertEqual(event["message_id"], "m1")
        self.assertEqual(event["content"], "corrected")
        for db in (self.db_a, self.db_b):
            stored = await db.get_message("m1")
            self.assertEqual(stored["content"], "corrected")
            self.assertGreater(stored["edited_at"], 0)

    async def test_edit_rejects_non_sender_and_unknown_message(self):
        await self._save_both()
        with self.assertRaises(ValueError):
            await self.router_b.send_edit(self.alice.peer_id, "m1", "hijacked")
        with self.assertRaises(ValueError):
            await self.router_a.send_edit(self.bob.peer_id, "nope", "x")

    async def test_edit_rejects_peer_without_capability(self):
        await self._save_both()
        self.mgr_a.peers[self.bob.peer_id].caps.discard(CAP_MESSAGE_EDITS)
        with self.assertRaises(ValueError):
            await self.router_a.send_edit(self.bob.peer_id, "m1", "corrected")

    async def test_edit_rejects_oversize_content(self):
        await self._save_both()
        with self.assertRaises(ValueError):
            await self.router_a.send_edit(self.bob.peer_id, "m1", "x" * (30 * 1024 + 1))

    async def test_stale_edit_is_ignored(self):
        await self._save_both()
        await self.router_a.send_edit(self.bob.peer_id, "m1", "corrected")
        peer, packet = self.mgr_a.sent[0]
        await self.router_b.handle_packet(_Peer(self.alice), packet)
        event = await asyncio.wait_for(self.edited_b.get(), 1)
        self.assertEqual(event["content"], "corrected")

        stale = MessageEditPayload("m1", self.alice.peer_id, self.bob.peer_id, 1000.0 - 50, b"")
        stale.encrypted_content = encrypt_for_recipient(
            self.bob.encryption_public_key_bytes(), b"stale", stale.associated_data())
        stale.signature = self.alice.signing_private_key.sign(stale.signed_bytes())
        await self.router_b.handle_packet(
            _Peer(self.alice), Packet(PacketType.MESSAGE_EDIT, stale.encode()))
        self.assertTrue(self.edited_b.empty())
        self.assertEqual((await self.db_b.get_message("m1"))["content"], "corrected")

    async def test_offline_edit_is_queued(self):
        await self._save_both()
        self.mgr_a.peers.clear()
        await self.db_a.upsert_peer(
            self.bob.peer_id, "Bob", self.bob.encryption_public_key_bytes(),
            self.bob.signing_public_key_bytes(), capabilities=sorted(FULL_CAPS),
        )
        edited_at = await self.router_a.send_edit(self.bob.peer_id, "m1", "corrected")
        self.assertGreater(edited_at, 0)
        self.assertEqual(self.mgr_a.sent, [])
        async with self.db_a._db.execute(
            "SELECT packet_type FROM outgoing_queue WHERE message_id = ?", ("m1",)
        ) as cursor:
            rows = await cursor.fetchall()
        self.assertIn(PacketType.MESSAGE_EDIT.value, [row["packet_type"] for row in rows])


class GroupMessageEditRouterTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        self.group_id = "a" * 32
        self.alice = Identity.generate("Alice")
        self.bob = Identity.generate("Bob")
        self.db_a = Database(root / "a.db")
        self.db_b = Database(root / "b.db")
        await self.db_a.connect()
        await self.db_b.connect()
        self.rooms = {self.group_id: SimpleNamespace(id=self.group_id, group_name="Team")}
        for db, me, other, name in (
            (self.db_a, self.alice, self.bob, "Bob"),
            (self.db_b, self.bob, self.alice, "Alice"),
        ):
            await db.upsert_group_member(self.group_id, me.peer_id, "Me", group_capable=True)
            await db.upsert_group_member(self.group_id, other.peer_id, name, group_capable=True)
        self.mgr_a = _PeerManager(_Peer(self.bob))
        self.mgr_b = _PeerManager(_Peer(self.alice))
        self.events_a = asyncio.Queue()
        self.events_b = asyncio.Queue()
        self.router_a = GroupRouter(
            self.alice, self.mgr_a, self.db_a, SimpleNamespace(rooms=self.rooms), self.events_a.put)
        self.router_b = GroupRouter(
            self.bob, self.mgr_b, self.db_b, SimpleNamespace(rooms=self.rooms), self.events_b.put)

    async def asyncTearDown(self):
        await self.db_a.close()
        await self.db_b.close()
        self.tempdir.cleanup()

    async def _save_both(self, message_id="g1", content="original"):
        for db in (self.db_a, self.db_b):
            await db.save_group_message({
                "message_id": message_id, "group_id": self.group_id,
                "sender_id": self.alice.peer_id, "content": content, "created_at": 1000.0,
            })

    async def test_group_edit_fans_out_and_applies(self):
        await self._save_both()
        edited_at = await self.router_a.send_edit(self.group_id, "g1", "corrected")
        self.assertGreater(edited_at, 0)
        packets = [p for _, p in self.mgr_a.sent if p.type == PacketType.GROUP_MESSAGE_EDIT]
        self.assertEqual(len(packets), 1)

        await self.router_b.handle_packet(_Peer(self.alice), packets[0])
        event = await asyncio.wait_for(self.events_b.get(), 1)
        self.assertEqual(event["event"], "group_message_edited")
        self.assertEqual(event["content"], "corrected")
        for db in (self.db_a, self.db_b):
            history = await db.get_group_messages(self.group_id)
            self.assertEqual(history[0]["content"], "corrected")
            self.assertGreater(history[0]["edited_at"], 0)

    async def test_group_edit_rejects_non_sender(self):
        await self._save_both()
        with self.assertRaises(ValueError):
            await self.router_b.send_edit(self.group_id, "g1", "hijacked")
