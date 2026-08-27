import asyncio
import tempfile
import unittest
from pathlib import Path

from meshtalk.database import Database
from meshtalk.group_router import GroupRouter
from meshtalk.identity import Identity
from meshtalk.message_router import MessageRouter
from meshtalk.peer_manager import PeerManager
from meshtalk.settings import Settings


class GroupChatTest(unittest.IsolatedAsyncioTestCase):
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
        for manager, router, group in zip(self.managers, self.routers, self.groups):
            manager.on_packet = router.handle_packet
            await group.sync_groups()
            await manager.start()
        self.tcp_ports = [manager._server.sockets[0].getsockname()[1] for manager in self.managers]
        for first in range(3):
            for second in range(first + 1, 3):
                initiator, target = (
                    (first, second)
                    if self.identities[first].peer_id < self.identities[second].peer_id
                    else (second, first)
                )
                await self.managers[initiator].connect_to_peer(
                    self.identities[target].peer_id, "127.0.0.1", self.tcp_ports[target]
                )
        async with asyncio.timeout(3):
            while any(len(manager.get_connected_peers()) < 2 for manager in self.managers):
                await asyncio.sleep(0.02)
        for group in self.groups:
            for identity in self.identities:
                await group.record_room_member(self.group_id, identity.peer_id, announce_join=True)

    async def asyncTearDown(self):
        for manager in self.managers:
            await manager.stop()
        for database in self.databases:
            await database.close()
        self.temporary.cleanup()

    async def test_group_message_fans_out_without_friendship(self):
        message_id, deliveries = await self.groups[0].send_message(self.group_id, b"hello group")

        self.assertEqual({item["status"] for item in deliveries}, {"sent"})
        received = []
        async with asyncio.timeout(3):
            while len(received) < 2:
                for queue in self.events[1:]:
                    while not queue.empty():
                        event = queue.get_nowait()
                        if event["event"] == "group_message":
                            received.append(event)
                await asyncio.sleep(0.02)
        self.assertEqual({event["message_id"] for event in received}, {message_id})
        self.assertEqual({event["content"] for event in received}, {"hello group"})
        async with asyncio.timeout(3):
            while True:
                deliveries = await self.databases[0].get_group_deliveries(message_id)
                if all(item["status"] == "delivered" for item in deliveries):
                    break
                await asyncio.sleep(0.02)

    async def test_group_reply_references_original_message(self):
        original_id, _ = await self.groups[0].send_message(self.group_id, b"original")
        for index in (1, 2):
            await self.events[index].get()
        reply_id, _ = await self.groups[1].send_message(self.group_id, b"reply", original_id)
        received = []
        async with asyncio.timeout(3):
            while len(received) < 2:
                for index in (0, 2):
                    while not self.events[index].empty():
                        event = self.events[index].get_nowait()
                        if event["event"] == "group_message" and event["message_id"] == reply_id:
                            received.append(event)
                await asyncio.sleep(0.02)
        self.assertEqual({event["reply_to_message_id"] for event in received}, {original_id})
        messages = await self.databases[0].get_group_messages(self.group_id)
        self.assertEqual(next(message for message in messages if message["message_id"] == reply_id)["reply_to_message_id"], original_id)

    async def test_join_event_waits_for_handshake_name_and_is_deduplicated(self):
        group = self.groups[0]
        peer_id = self.identities[1].peer_id
        await self.databases[0].remove_group(self.group_id)
        await self.databases[0].upsert_group(self.group_id, "Core Team")
        before = await self.databases[0].get_group_messages(self.group_id)
        await self.databases[0].upsert_group_member(self.group_id, peer_id, "Anonymous")
        self.assertEqual(len(await self.databases[0].get_group_messages(self.group_id)), len(before))

        await group.peer_connected(peer_id)
        await group.peer_connected(peer_id)
        messages = await self.databases[0].get_group_messages(self.group_id)
        joins = [message for message in messages if message["kind"] == "join"]
        self.assertEqual(len(joins), len([message for message in before if message["kind"] == "join"]) + 1)
        self.assertIn(peer_id, joins[0]["content"])

    async def test_roster_snapshot_does_not_emit_a_join_event(self):
        group = self.groups[0]
        peer_id = self.identities[1].peer_id
        await self.databases[0].remove_group(self.group_id)
        await self.databases[0].upsert_group(self.group_id, "Core Team")
        before = await self.databases[0].get_group_messages(self.group_id)

        await group.record_room_member(self.group_id, peer_id, announce_join=False)
        await group.peer_connected(peer_id)

        messages = await self.databases[0].get_group_messages(self.group_id)
        self.assertEqual(len(messages), len(before))

    async def test_local_join_and_leave_are_persisted(self):
        await self.groups[0].record_local_join(self.group_id)
        await self.groups[0].leave_group(self.group_id)

        messages = await self.databases[0].get_group_messages(self.group_id)
        local_events = [
            message["content"] for message in messages
            if message["sender_id"] == self.identities[0].peer_id
        ]
        self.assertIn("You joined the group", local_events)
        self.assertIn("You left the group", local_events)

    async def test_repeated_local_rejoins_do_not_announce_existing_members(self):
        group = self.groups[0]
        invite = self.settings[0].rooms[self.group_id].invite
        before = await self.databases[0].get_group_messages(self.group_id)

        for _ in range(3):
            self.settings[0].leave_room(self.group_id)
            await self.databases[0].remove_group(self.group_id)
            self.settings[0].join_room(invite)
            await group.sync_groups()
            for identity in self.identities[1:]:
                await group.record_room_member(
                    self.group_id, identity.peer_id, announce_join=False
                )
                await group.peer_connected(identity.peer_id)

        after = await self.databases[0].get_group_messages(self.group_id)
        self.assertEqual(len(after), len(before))

    async def test_offline_known_member_is_queued(self):
        peer = self.managers[0].get_connected_peer(self.identities[2].peer_id)
        self.assertIsNotNone(peer)
        peer.writer.close()
        async with asyncio.timeout(2):
            while self.managers[0].get_connected_peer(self.identities[2].peer_id):
                await asyncio.sleep(0.02)

        message_id, deliveries = await self.groups[0].send_message(self.group_id, b"later")

        statuses = {item["recipient_id"]: item["status"] for item in deliveries}
        self.assertEqual(statuses[self.identities[2].peer_id], "queued")
        queued = await self.databases[0].get_pending_outgoing(self.identities[2].peer_id)
        self.assertEqual(queued[0]["message_id"], message_id)
        self.assertEqual(queued[0]["group_id"], self.group_id)

    async def test_signed_leave_removes_member(self):
        await self.groups[2].leave_group(self.group_id)
        async with asyncio.timeout(2):
            while True:
                member = await self.databases[0].get_group_member(
                    self.group_id, self.identities[2].peer_id
                )
                if member and not member["active"]:
                    break
                await asyncio.sleep(0.02)
        events = await self.databases[0].get_group_messages(self.group_id)
        self.assertIn(
            f"{self.identities[2].peer_id} left the group",
            [event["content"] for event in events],
        )

    async def test_blocked_member_is_excluded_from_fanout(self):
        await self.databases[0].block_peer(self.identities[2].peer_id, "Cara")

        _, deliveries = await self.groups[0].send_message(self.group_id, b"not for blocked member")

        statuses = {item["recipient_id"]: item["status"] for item in deliveries}
        self.assertEqual(statuses[self.identities[2].peer_id], "unavailable")
        self.assertNotEqual(statuses[self.identities[1].peer_id], "unavailable")

    async def test_delivered_status_does_not_regress(self):
        message_id, _ = await self.groups[0].send_message(self.group_id, b"status")
        recipient_id = self.identities[1].peer_id
        await self.databases[0].set_group_delivery(message_id, recipient_id, "delivered")
        await self.databases[0].set_group_delivery(message_id, recipient_id, "sent")

        statuses = {
            item["recipient_id"]: item["status"]
            for item in await self.databases[0].get_group_deliveries(message_id)
        }
        self.assertEqual(statuses[recipient_id], "delivered")

    async def test_delivery_uses_cached_group_member_name(self):
        peer_id = "f" * 64
        await self.databases[0].upsert_group_member(self.group_id, peer_id, "Offline peer")
        message_id, deliveries = await self.groups[0].send_message(self.group_id, b"status")

        matching = next(delivery for delivery in deliveries if delivery["recipient_id"] == peer_id)
        self.assertEqual(matching["display_name"], "Offline peer")

    async def test_one_recipient_send_failure_does_not_abort_fanout(self):
        failed_id = self.identities[1].peer_id
        original_send = self.managers[0].send_packet

        async def fail_one(peer, packet):
            if peer.peer_id == failed_id:
                raise ConnectionError("simulated failure")
            await original_send(peer, packet)

        self.managers[0].send_packet = fail_one
        _, deliveries = await self.groups[0].send_message(self.group_id, b"partial")

        statuses = {item["recipient_id"]: item["status"] for item in deliveries}
        self.assertEqual(statuses[failed_id], "queued")
        self.assertIn(statuses[self.identities[2].peer_id], ("sent", "delivered"))

    async def test_rejoin_restores_local_history_without_replay(self):
        invite = self.settings[2].rooms[self.group_id].invite
        before = await self.databases[2].get_group_messages(self.group_id)
        await self.groups[2].leave_group(self.group_id)
        after_leave = await self.databases[2].get_group_messages(self.group_id)
        self.assertEqual(len(after_leave), len(before) + 1)
        self.assertEqual(after_leave[-1]["content"], "You left the group")

        self.settings[2].join_room(invite)
        await self.groups[2].sync_groups()
        after = await self.databases[2].get_group_messages(self.group_id)

        self.assertEqual(
            [message["message_id"] for message in after],
            [message["message_id"] for message in after_leave],
        )

    async def test_group_message_fans_out_over_remote_udp(self):
        endpoints = [
            ("127.0.0.1", manager.udp.local_endpoint[1]) for manager in self.managers
        ]
        for first in range(3):
            for second in range(first + 1, 3):
                self.managers[first].udp.expect_peer(self.identities[second].peer_id, endpoints[second])
                self.managers[second].udp.expect_peer(self.identities[first].peer_id, endpoints[first])
        async with asyncio.timeout(4):
            while any(len(manager._udp_peers) < 2 for manager in self.managers):
                await asyncio.sleep(0.02)
        writers = {
            peer.writer
            for manager in self.managers
            for peer in manager.get_connected_peers()
            if peer.writer is not None
        }
        for writer in writers:
            writer.close()
        async with asyncio.timeout(3):
            while any(
                manager.get_network_info(identity.peer_id)["active_transport"] != "remote_udp"
                for manager, identities in zip(self.managers, [self.identities] * 3)
                for identity in identities
                if identity.peer_id != manager.identity.peer_id
            ):
                await asyncio.sleep(0.02)

        message_id, _ = await self.groups[0].send_message(self.group_id, b"remote group")

        received = []
        async with asyncio.timeout(4):
            while len(received) < 2:
                for queue in self.events[1:]:
                    while not queue.empty():
                        event = queue.get_nowait()
                        if event["event"] == "group_message" and event["message_id"] == message_id:
                            received.append(event)
                await asyncio.sleep(0.02)
        self.assertEqual({event["content"] for event in received}, {"remote group"})
