import asyncio
import hashlib
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from meshtalk.database import Database
from meshtalk.group_router import GroupRouter
from meshtalk.identity import Identity
from meshtalk.message_router import MessageRouter
from meshtalk.peer_manager import PeerConnection, PeerManager
from meshtalk.protocol import (
    CAP_GROUP_CHAT,
    GroupAckPayload,
    GroupMessagePayload,
    Packet,
    PacketType,
    group_origin_signed_bytes,
)
from meshtalk.encryption import encrypt_for_recipient
from meshtalk.settings import Settings


class GroupRelayTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.identities = [Identity.generate(name) for name in ("Alice", "Bob", "Cara")]
        self.databases = [Database(root / f"{index}.db") for index in range(3)]
        self.settings = [Settings(root / f"{index}.json") for index in range(3)]
        for database in self.databases:
            await database.connect()
        room = self.settings[0].create_room("Core Team")
        self.group_id = room.id
        self.settings[1].join_room(room.invite)
        self.settings[2].join_room(room.invite)
        self.events = [asyncio.Queue() for _ in range(3)]
        self.managers = [
            PeerManager(identity, database, lambda *_: None, tcp_port=0)
            for identity, database in zip(self.identities, self.databases)
        ]
        self.groups = [
            GroupRouter(identity, manager, database, settings, events.put)
            for identity, manager, database, settings, events in zip(
                self.identities, self.managers, self.databases, self.settings, self.events
            )
        ]
        self.routers = [
            MessageRouter(identity, manager, database, group_router=group)
            for identity, manager, database, group in zip(
                self.identities, self.managers, self.databases, self.groups
            )
        ]
        for manager, router in zip(self.managers, self.routers):
            manager.on_packet = router.handle_packet
            await manager.start()
        for group in self.groups:
            await group.sync_groups()
        self.tcp_ports = [manager._server.sockets[0].getsockname()[1] for manager in self.managers]
        await self._connect(0, 1)
        await self._connect(0, 2)
        await self._connect(1, 2)
        async with asyncio.timeout(5):
            while any(len(manager.get_connected_peers()) < 2 for manager in self.managers):
                await asyncio.sleep(0.02)
        for group in self.groups:
            for identity in self.identities:
                await group.record_room_member(self.group_id, identity.peer_id, announce_join=True)
        self._drain_events()

    async def asyncTearDown(self):
        for manager in self.managers:
            await manager.stop()
        for database in self.databases:
            await database.close()
        self.temporary.cleanup()

    def _drain_events(self):
        for queue in self.events:
            while not queue.empty():
                queue.get_nowait()

    async def _connect(self, first, second):
        initiator, target = (
            (first, second)
            if self.identities[first].peer_id < self.identities[second].peer_id
            else (second, first)
        )
        await self.managers[initiator].connect_to_peer(
            self.identities[target].peer_id, "127.0.0.1", self.tcp_ports[target]
        )

    async def _disconnect_pair(self, first, second):
        id_first = self.identities[first].peer_id
        id_second = self.identities[second].peer_id
        for manager, other in ((self.managers[first], id_second), (self.managers[second], id_first)):
            peer = manager.get_connected_peer(other)
            if peer is not None and peer.writer is not None:
                try:
                    peer.writer.close()
                except Exception:
                    pass
        async with asyncio.timeout(3):
            while (
                self.managers[first].get_connected_peer(id_second) is not None
                or self.managers[second].get_connected_peer(id_first) is not None
            ):
                await asyncio.sleep(0.02)

    async def _wait_event(self, index, message_id, timeout=4):
        async with asyncio.timeout(timeout):
            while True:
                event = await self.events[index].get()
                if event.get("event") == "group_message" and event.get("message_id") == message_id:
                    return event

    async def test_relay_delivers_to_offline_peer_and_forwards_ack(self):
        alice, bob, cara = (identity.peer_id for identity in self.identities)
        await self._disconnect_pair(0, 2)
        self.assertIsNotNone(self.managers[0].get_connected_peer(bob))
        self.assertIsNotNone(self.managers[1].get_connected_peer(cara))

        message_id, _ = await self.groups[0].send_message(self.group_id, b"via mesh relay")
        await self._wait_event(1, message_id)

        statuses = {
            item["recipient_id"]: item["status"]
            for item in await self.databases[0].get_group_deliveries(message_id)
        }
        self.assertEqual(statuses[cara], "queued")

        self._drain_events()
        relayed = await self.groups[1].relay_for_peer(cara)
        self.assertGreaterEqual(relayed, 1)
        received = await self._wait_event(2, message_id)
        self.assertEqual(received["sender_id"], alice)
        self.assertEqual(received["content"], "via mesh relay")

        async with asyncio.timeout(4):
            while True:
                statuses = {
                    item["recipient_id"]: item["status"]
                    for item in await self.databases[0].get_group_deliveries(message_id)
                }
                if statuses.get(cara) == "delivered":
                    break
                await asyncio.sleep(0.02)

    async def test_duplicate_relayed_copies_are_discarded(self):
        alice, bob, cara = (identity.peer_id for identity in self.identities)
        await self._disconnect_pair(0, 2)

        message_id, _ = await self.groups[0].send_message(self.group_id, b"duplicate relay")
        await self._wait_event(1, message_id)
        self._drain_events()

        await self.groups[1].relay_for_peer(cara)
        await self._wait_event(2, message_id)
        # Second sweep re-sends the same message_id; recipient must not emit again.
        await self.groups[1].relay_for_peer(cara)
        await asyncio.sleep(0.3)
        extra = []
        while not self.events[2].empty():
            event = self.events[2].get_nowait()
            if event.get("event") == "group_message" and event.get("message_id") == message_id:
                extra.append(event)
        self.assertEqual(extra, [])
        rows = [
            message for message in await self.databases[2].get_group_messages(self.group_id)
            if message["message_id"] == message_id
        ]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["content"], "duplicate relay")

    async def test_tampered_relay_is_rejected(self):
        bob, cara = self.identities[1].peer_id, self.identities[2].peer_id
        await self._disconnect_pair(0, 2)
        message_id, _ = await self.groups[0].send_message(self.group_id, b"authentic content")
        await self._wait_event(1, message_id)
        self._drain_events()

        stored = await self.databases[1].get_group_message(message_id)
        self.assertIsNotNone(stored)
        peer_on_bob = self.managers[1].get_connected_peer(cara)
        self.assertIsNotNone(peer_on_bob)
        tampered = GroupMessagePayload(
            message_id, self.group_id, self.identities[0].peer_id, cara,
            stored["created_at"], b"", origin_signature=bytes(stored["origin_signature"]),
        )
        tampered.encrypted_content = encrypt_for_recipient(
            peer_on_bob.encryption_public_key, b"tampered content", tampered.associated_data()
        )
        tampered.signature = self.identities[1].signing_private_key.sign(tampered.signed_bytes())
        peer_on_cara = self.managers[2].get_connected_peer(bob)
        with self.assertRaises(ValueError):
            await self.groups[2]._handle_message(peer_on_cara, tampered)
        self.assertIsNone(await self.databases[2].get_group_message(message_id))

    async def test_relay_requires_origin_signature(self):
        bob = self.identities[1].peer_id
        peer_on_cara = self.managers[2].get_connected_peer(bob)
        legacy = GroupMessagePayload(
            "legacy-message", self.group_id, self.identities[0].peer_id,
            self.identities[2].peer_id, 1700000000.0, b"x" * 60,
        )
        legacy.signature = self.identities[1].signing_private_key.sign(legacy.signed_bytes())
        with self.assertRaises(ValueError):
            await self.groups[2]._handle_message(peer_on_cara, legacy)

    async def test_origin_signature_binds_content(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        plaintext = b"binding check"
        message_id = "bind-1"
        digest = hashlib.sha256(plaintext).hexdigest()
        signed = group_origin_signed_bytes(
            message_id, self.group_id, self.identities[0].peer_id, 1700000000.0, None, digest
        )
        signature = self.identities[0].signing_private_key.sign(signed)
        Ed25519PublicKey.from_public_bytes(
            self.identities[0].signing_public_key_bytes()
        ).verify(signature, signed)
        tampered = group_origin_signed_bytes(
            message_id, self.group_id, self.identities[0].peer_id, 1700000000.0, None,
            hashlib.sha256(b"other content").hexdigest(),
        )
        with self.assertRaises(Exception):
            Ed25519PublicKey.from_public_bytes(
                self.identities[0].signing_public_key_bytes()
            ).verify(signature, tampered)


class StubPeerManager:
    """Minimal peer-manager stand-in: nothing connected, sends must not happen."""

    def get_connected_peer(self, peer_id):
        return None

    async def send_packet(self, peer, packet):
        raise AssertionError("relay test expected an offline sender (queue path)")


class GroupForwardAckQueueTest(unittest.IsolatedAsyncioTestCase):
    """_forward_ack must queue one flush-safe row when the sender is offline."""

    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.sender = Identity.generate("Sender")
        self.recipient = Identity.generate("Recipient")
        self.relay = Identity.generate("Relay")
        self.db = Database(root / "relay.db")
        await self.db.connect()
        self.settings = Settings(root / "relay.json")
        room = self.settings.create_room("Ack Team")
        self.group_id = room.id
        await self.db.upsert_group(self.group_id, "Ack Team")
        for identity in (self.sender, self.relay):
            await self.db.upsert_group_member(
                self.group_id, identity.peer_id, "Member", group_capable=True
            )
        self.router = GroupRouter(self.relay, StubPeerManager(), self.db, self.settings)
        self.message_id = "ack-queue-1"

    async def asyncTearDown(self):
        await self.db.close()
        self.temporary.cleanup()

    async def test_offline_sender_ack_is_queued_flush_safe(self):
        ack = GroupAckPayload(self.message_id, self.group_id, self.recipient.peer_id)
        ack.signature = self.recipient.signing_private_key.sign(ack.signed_bytes())
        transport = PeerConnection(self.recipient.peer_id, "127.0.0.1", 1)
        message = {"message_id": self.message_id, "group_id": self.group_id,
                   "sender_id": self.sender.peer_id}
        await self.router._forward_ack(transport, ack, message)

        queued = await self.db.get_pending_outgoing(self.sender.peer_id)
        self.assertEqual(len(queued), 1)
        row = queued[0]
        self.assertEqual(row["packet_type"], PacketType.GROUP_MESSAGE_ACK.value)
        self.assertIsNone(row["message_id"])
        self.assertEqual(row["group_id"], self.group_id)
        # message_id unset => __main__.flush_outgoing skips delivery bookkeeping.
        self.assertEqual(GroupAckPayload.decode(row["encrypted_payload"]), ack)

        sender_peer = PeerConnection(self.sender.peer_id, "127.0.0.1", 1)
        sender_peer.capabilities = [CAP_GROUP_CHAT]
        self.assertTrue(await self.router.can_flush(sender_peer, dict(row)))

    async def test_replayed_ack_queues_only_once(self):
        ack = GroupAckPayload(self.message_id, self.group_id, self.recipient.peer_id)
        ack.signature = self.recipient.signing_private_key.sign(ack.signed_bytes())
        transport = PeerConnection(self.recipient.peer_id, "127.0.0.1", 1)
        message = {"message_id": self.message_id, "group_id": self.group_id,
                   "sender_id": self.sender.peer_id}
        for _ in range(5):
            await self.router._forward_ack(transport, ack, message)
        queued = await self.db.get_pending_outgoing(self.sender.peer_id)
        self.assertEqual(len(queued), 1)


class CountingPeerManager:
    """Peer manager stand-in with one connected peer; counts live sends."""

    def __init__(self, peer):
        self.peer = peer
        self.sent = 0

    def get_connected_peer(self, peer_id):
        return self.peer if peer_id == self.peer.peer_id else None

    async def send_packet(self, peer, packet):
        self.sent += 1


class GroupRelaySuppressionTest(unittest.IsolatedAsyncioTestCase):
    """Repeat sweeps must not re-send an already-relayed message."""

    async def test_second_sweep_suppresses_resend(self):
        import time as _time

        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        sender, relay, target = (Identity.generate(name) for name in ("S", "R", "T"))
        db = Database(root / "suppress.db")
        await db.connect()
        try:
            settings = Settings(root / "suppress.json")
            room = settings.create_room("Suppress")
            group_id = room.id
            await db.upsert_group(group_id, "Suppress")
            for identity in (relay, sender, target):
                await db.upsert_group_member(group_id, identity.peer_id, "M", group_capable=True)
            created_at = _time.time()
            origin = sender.signing_private_key.sign(
                group_origin_signed_bytes(
                    "m1", group_id, sender.peer_id, created_at, None,
                    hashlib.sha256(b"hello").hexdigest(),
                )
            )
            await db.save_group_message({
                "message_id": "m1", "group_id": group_id, "sender_id": sender.peer_id,
                "content": "hello", "created_at": created_at, "origin_signature": origin,
            })
            peer = PeerConnection(target.peer_id, "127.0.0.1", 1)
            peer.capabilities = [CAP_GROUP_CHAT]
            peer.encryption_public_key = X25519PrivateKey.generate().public_key().public_bytes(
                Encoding.Raw, PublicFormat.Raw)
            manager = CountingPeerManager(peer)
            router = GroupRouter(relay, manager, db, settings)
            first = await router.relay_for_peer(target.peer_id)
            second = await router.relay_for_peer(target.peer_id)
            self.assertEqual((first, second, manager.sent), (1, 0, 1))
        finally:
            await db.close()

    async def test_pre_join_history_is_not_relayed(self):
        import time as _time

        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        sender, relay, target = (Identity.generate(name) for name in ("S", "R", "T"))
        db = Database(root / "history.db")
        await db.connect()
        try:
            settings = Settings(root / "history.json")
            room = settings.create_room("History")
            group_id = room.id
            await db.upsert_group(group_id, "History")
            for identity in (relay, sender, target):
                await db.upsert_group_member(group_id, identity.peer_id, "M", group_capable=True)
            target_joined = (await db.get_group_member(group_id, target.peer_id))["joined_at"]
            old_origin = sender.signing_private_key.sign(
                group_origin_signed_bytes(
                    "old", group_id, sender.peer_id, target_joined - 100, None,
                    hashlib.sha256(b"before you joined").hexdigest(),
                )
            )
            await db.save_group_message({
                "message_id": "old", "group_id": group_id, "sender_id": sender.peer_id,
                "content": "before you joined", "created_at": target_joined - 100,
                "origin_signature": old_origin,
            })
            now = _time.time()
            new_origin = sender.signing_private_key.sign(
                group_origin_signed_bytes(
                    "new", group_id, sender.peer_id, now, None,
                    hashlib.sha256(b"after you joined").hexdigest(),
                )
            )
            await db.save_group_message({
                "message_id": "new", "group_id": group_id, "sender_id": sender.peer_id,
                "content": "after you joined", "created_at": now,
                "origin_signature": new_origin,
            })
            peer = PeerConnection(target.peer_id, "127.0.0.1", 1)
            peer.capabilities = [CAP_GROUP_CHAT]
            peer.encryption_public_key = X25519PrivateKey.generate().public_key().public_bytes(
                Encoding.Raw, PublicFormat.Raw)
            manager = CountingPeerManager(peer)
            router = GroupRouter(relay, manager, db, settings)
            self.assertEqual(await router.relay_for_peer(target.peer_id), 1)
            self.assertEqual(manager.sent, 1)
        finally:
            await db.close()

    async def test_sweep_is_bounded(self):
        import time as _time

        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        sender, relay, target = (Identity.generate(name) for name in ("S", "R", "T"))
        db = Database(root / "bound.db")
        await db.connect()
        try:
            settings = Settings(root / "bound.json")
            room = settings.create_room("Bound")
            group_id = room.id
            await db.upsert_group(group_id, "Bound")
            for identity in (relay, sender, target):
                await db.upsert_group_member(group_id, identity.peer_id, "M", group_capable=True)
            base = _time.time()
            for index in range(60):
                message_id = f"m{index}"
                created_at = base + index
                origin = sender.signing_private_key.sign(
                    group_origin_signed_bytes(
                        message_id, group_id, sender.peer_id, created_at, None,
                        hashlib.sha256(b"x").hexdigest(),
                    )
                )
                await db.save_group_message({
                    "message_id": message_id, "group_id": group_id,
                    "sender_id": sender.peer_id, "content": "x",
                    "created_at": created_at, "origin_signature": origin,
                })
            peer = PeerConnection(target.peer_id, "127.0.0.1", 1)
            peer.capabilities = [CAP_GROUP_CHAT]
            peer.encryption_public_key = X25519PrivateKey.generate().public_key().public_bytes(
                Encoding.Raw, PublicFormat.Raw)
            manager = CountingPeerManager(peer)
            router = GroupRouter(relay, manager, db, settings)
            first = await router.relay_for_peer(target.peer_id)
            second = await router.relay_for_peer(target.peer_id)
            self.assertEqual(first, 50)
            self.assertEqual(second, 10)
            self.assertEqual(manager.sent, 60)
        finally:
            await db.close()


class GroupDoSGuardTest(unittest.IsolatedAsyncioTestCase):
    """Inbound rate limit, history retention, and dead-queue reaping."""

    async def test_inbound_rate_limit_trips(self):
        from meshtalk.group_router import GROUP_INBOUND_BURST

        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        relay = Identity.generate("R")
        db = Database(root / "dos.db")
        await db.connect()
        try:
            router = GroupRouter(relay, StubPeerManager(), db, Settings(root / "dos.json"))
            sender = "s" * 64
            for _ in range(GROUP_INBOUND_BURST):
                self.assertTrue(router._check_inbound_rate(sender))
            self.assertFalse(router._check_inbound_rate(sender))
            self.assertTrue(router._check_inbound_rate("other" * 16))
        finally:
            await db.close()

    async def test_history_retention_prunes(self):
        import meshtalk.database as database_module

        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        db = Database(root / "prune.db")
        await db.connect()
        try:
            await db.upsert_group("g" * 32, "Prune")
            old_limit, database_module.MAX_GROUP_HISTORY_ROWS = database_module.MAX_GROUP_HISTORY_ROWS, 10
            try:
                for index in range(250):
                    await db.save_group_message({
                        "message_id": f"p{index}", "group_id": "g" * 32,
                        "sender_id": "s" * 64, "content": "x", "created_at": float(index),
                    })
            finally:
                database_module.MAX_GROUP_HISTORY_ROWS = old_limit
            remaining = await db.get_group_messages("g" * 32, limit=500)
            # Retention bound holds with hysteresis: far fewer than inserted,
            # oldest rows pruned first.
            self.assertLessEqual(len(remaining), 120)
            self.assertTrue(remaining[0]["message_id"] >= "p100")
        finally:
            await db.close()

    async def test_cleanup_reaps_dead_queue_rows(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        db = Database(root / "purge.db")
        await db.connect()
        try:
            await db.add_to_outqueue("r" * 64, 3, b"payload", "m1")
            queued = await db.get_pending_outgoing("r" * 64)
            self.assertEqual(len(queued), 1)
            for _ in range(5):
                await db.increment_outqueue_attempts(queued[0]["id"])
            self.assertEqual(await db.get_pending_outgoing("r" * 64), [])
            await db.cleanup_expired()
            async with db._db.execute("SELECT COUNT(*) AS n FROM outgoing_queue") as cur:
                self.assertEqual((await cur.fetchone())["n"], 0)
        finally:
            await db.close()
