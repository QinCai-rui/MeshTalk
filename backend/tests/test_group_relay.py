import asyncio
import hashlib
import tempfile
import unittest
from pathlib import Path

from meshtalk.database import Database
from meshtalk.group_router import GroupRouter
from meshtalk.identity import Identity
from meshtalk.message_router import MessageRouter
from meshtalk.peer_manager import PeerManager
from meshtalk.protocol import GroupMessagePayload, Packet, PacketType, group_origin_signed_bytes
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
