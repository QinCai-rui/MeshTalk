import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path

from meshtalk.database import Database
from meshtalk.identity import Identity
from meshtalk.friends import FriendManager
from meshtalk.message_router import MessageRouter
from meshtalk.peer_manager import PeerManager
from meshtalk.protocol import (
    FriendRequestCancelledPayload,
    FriendRequestPayload,
    FriendRequestResponsePayload,
    MessageBlockedPayload,
    Packet,
    PacketType,
)


class FriendManagerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        self.db_a_path, self.db_b_path = root / "a.db", root / "b.db"
        self.identity_a = Identity.generate("Alice")
        self.identity_b = Identity.generate("Bob")
        self.mallory = Identity.generate("Mallory")
        self.db_a, self.db_b = Database(self.db_a_path), Database(self.db_b_path)
        await self.db_a.connect()
        await self.db_b.connect()
        self.received = asyncio.Queue()
        self.friend_request_events = []
        self.friend_response_events = []
        self.friend_cancelled_events = []
        self.message_blocked_events = []
        self.manager_a = PeerManager(self.identity_a, self.db_a, lambda *_: None, tcp_port=34991)
        self.manager_b = PeerManager(self.identity_b, self.db_b, lambda *_: None, tcp_port=34992)
        self.friend_a = FriendManager(self.identity_a, self.manager_a, self.db_a)
        self.friend_b = FriendManager(self.identity_b, self.manager_b, self.db_b)

        async def collect_friend_requests(event):
            self.friend_request_events.append(event)

        async def collect_friend_responses(event):
            self.friend_response_events.append(event)

        async def collect_friend_cancelled(event):
            self.friend_cancelled_events.append(event)

        async def collect_message_blocked(event):
            self.message_blocked_events.append(event)

        self.friend_a.on_friend_request = collect_friend_requests
        self.friend_b.on_friend_request = collect_friend_requests
        self.friend_a.on_friend_response = collect_friend_responses
        self.friend_b.on_friend_response = collect_friend_responses
        self.friend_a.on_friend_cancelled = collect_friend_cancelled
        self.friend_b.on_friend_cancelled = collect_friend_cancelled
        self.friend_a.on_message_blocked = collect_message_blocked
        self.friend_b.on_message_blocked = collect_message_blocked
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

    async def _become_friends(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id, "hi bob")
        await self._wait_for_request(request_id, self.friend_b.db)
        await self.friend_b.respond_to_friend_request(request_id, accept=True)
        await asyncio.sleep(0.05)
        return request_id

    async def _wait_for_request(self, request_id: str, db: Database):
        for _ in range(100):
            request = await db.get_friend_request(request_id)
            if request is not None:
                return request
            await asyncio.sleep(0.02)
        return None

    async def _wait_for_blocked(self):
        for _ in range(100):
            if self.message_blocked_events:
                return self.message_blocked_events[-1]
            await asyncio.sleep(0.02)
        return None

    def _peer_from(self, manager, identity):
        return manager.get_connected_peer(identity.peer_id)

    def _signed_request(self, request_id, sender, note, signer):
        payload = FriendRequestPayload(request_id, sender.peer_id, note, time.time(), b"")
        payload.signature = signer.signing_private_key.sign(payload.signed_bytes())
        return payload

    def _signed_response(self, request_id, responder, accept, signer):
        payload = FriendRequestResponsePayload(request_id, responder.peer_id, accept, b"")
        payload.signature = signer.signing_private_key.sign(payload.signed_bytes())
        return payload

    def _signed_blocked(self, message_id, blocked_by, signer):
        payload = MessageBlockedPayload(message_id, blocked_by.peer_id, b"")
        payload.signature = signer.signing_private_key.sign(payload.signed_bytes())
        return payload

    def _signed_cancel(self, request_id, sender, signer):
        payload = FriendRequestCancelledPayload(request_id, sender.peer_id, b"")
        payload.signature = signer.signing_private_key.sign(payload.signed_bytes())
        return payload

    # ---- request / response validation -------------------------------------------------

    def test_friend_request_decode_validation(self):
        def encode(**overrides):
            data = {
                "request_id": "req-1",
                "sender_id": "a" * 32,
                "note": "hello",
                "created_at": time.time(),
                "signature": "ab" * 64,
            }
            data.update(overrides)
            return json.dumps(data).encode()

        self.assertEqual(FriendRequestPayload.decode(encode()).request_id, "req-1")
        for bad in (
            {"signature": "ab"},
            {"signature": "zz" * 64},
            {"note": 123},
            {"note": "x" * 1025},
            {"created_at": "now"},
            {"created_at": -1},
            {"created_at": True},
            {"request_id": ""},
            {"sender_id": ""},
            {"sender_id": 123},
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    FriendRequestPayload.decode(encode(**bad))

    def test_friend_response_decode_validation(self):
        def encode(**overrides):
            data = {
                "request_id": "req-1",
                "responder_id": "b" * 32,
                "accept": True,
                "signature": "ab" * 64,
            }
            data.update(overrides)
            return json.dumps(data).encode()

        self.assertEqual(FriendRequestResponsePayload.decode(encode()).accept, True)
        for bad in (
            {"signature": "ab"},
            {"signature": "zz" * 64},
            {"accept": "yes"},
            {"accept": 1},
            {"request_id": ""},
            {"responder_id": ""},
            {"responder_id": 123},
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    FriendRequestResponsePayload.decode(encode(**bad))

    def test_message_blocked_decode_validation(self):
        def encode(**overrides):
            data = {
                "message_id": "msg-1",
                "blocked_by": "b" * 32,
                "signature": "ab" * 64,
            }
            data.update(overrides)
            return json.dumps(data).encode()

        self.assertEqual(MessageBlockedPayload.decode(encode()).message_id, "msg-1")
        for bad in (
            {"signature": "ab"},
            {"signature": "zz" * 64},
            {"message_id": ""},
            {"blocked_by": ""},
            {"blocked_by": 123},
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    MessageBlockedPayload.decode(encode(**bad))

    def test_friend_cancelled_decode_validation(self):
        def encode(**overrides):
            data = {
                "request_id": "req-1",
                "sender_id": "a" * 32,
                "signature": "ab" * 64,
            }
            data.update(overrides)
            return json.dumps(data).encode()

        self.assertEqual(FriendRequestCancelledPayload.decode(encode()).request_id, "req-1")
        for bad in (
            {"signature": "ab"},
            {"signature": "zz" * 64},
            {"request_id": ""},
            {"sender_id": ""},
            {"sender_id": 123},
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    FriendRequestCancelledPayload.decode(encode(**bad))

    def test_payload_roundtrip(self):
        payloads = (
            FriendRequestPayload("req-1", "a" * 32, "hello", time.time(), b"\x00" * 64),
            FriendRequestResponsePayload("req-1", "b" * 32, True, b"\x00" * 64),
            FriendRequestResponsePayload("req-1", "b" * 32, False, b"\x00" * 64),
            MessageBlockedPayload("msg-1", "b" * 32, b"\x00" * 64),
            FriendRequestCancelledPayload("req-1", "a" * 32, b"\x00" * 64),
        )
        for payload in payloads:
            with self.subTest(payload=type(payload).__name__):
                self.assertEqual(payload, type(payload).decode(payload.encode()))

    # ---- sending -----------------------------------------------------------------------

    async def test_cannot_send_friend_request_to_self(self):
        with self.assertRaises(ValueError):
            await self.friend_a.send_friend_request(self.identity_a.peer_id)

    async def test_send_friend_request_requires_connected_peer(self):
        with self.assertRaises(ValueError):
            await self.friend_a.send_friend_request(self.identity_b.peer_id)

    async def test_oversized_note_is_rejected(self):
        with self.assertRaises(ValueError):
            await self.friend_a.send_friend_request(self.identity_b.peer_id, "x" * 1025)

    async def test_duplicate_outgoing_request_raises(self):
        await self._connect_peers()
        await self.friend_a.send_friend_request(self.identity_b.peer_id)
        with self.assertRaises(ValueError):
            await self.friend_a.send_friend_request(self.identity_b.peer_id)

    async def test_send_friend_request_to_existing_friend_raises(self):
        await self._become_friends()
        with self.assertRaises(ValueError):
            await self.friend_a.send_friend_request(self.identity_b.peer_id)

    # ---- inbound request handling ------------------------------------------------------

    async def test_forged_incoming_request_signature_is_rejected(self):
        await self._connect_peers()
        payload = self._signed_request("req-forged", self.identity_a, "", self.mallory)
        with self.assertRaises(ValueError):
            await self.friend_b.handle_packet(
                self._peer_from(self.manager_b, self.identity_a),
                Packet(PacketType.FRIEND_REQUEST, payload.encode()),
            )
        self.assertEqual(await self.friend_b.db.get_pending_friend_requests(), [])
        self.assertEqual(self.friend_request_events, [])

    async def test_incoming_request_sender_must_match_authenticated_peer(self):
        await self._connect_peers()
        payload = self._signed_request("req-spoofed", self.mallory, "", self.identity_a)
        with self.assertRaises(ValueError):
            await self.friend_b.handle_packet(
                self._peer_from(self.manager_b, self.identity_a),
                Packet(PacketType.FRIEND_REQUEST, payload.encode()),
            )
        self.assertEqual(self.friend_request_events, [])

    async def test_duplicate_request_id_is_ignored(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id, "note")
        await asyncio.sleep(0.05)
        stored = await self.friend_b.db.get_friend_request(request_id)
        payload = self._signed_request(request_id, self.identity_a, stored["note"] or "", self.identity_a)
        payload.created_at = stored["created_at"]
        payload.signature = self.identity_a.signing_private_key.sign(payload.signed_bytes())
        await self.friend_b.handle_packet(
            self._peer_from(self.manager_b, self.identity_a),
            Packet(PacketType.FRIEND_REQUEST, payload.encode()),
        )
        await asyncio.sleep(0.05)
        requests = await self.friend_b.db.get_pending_friend_requests()
        self.assertEqual([r["request_id"] for r in requests], [request_id])
        self.assertEqual(len(self.friend_request_events), 1)

    async def test_second_pending_request_from_same_sender_is_ignored(self):
        await self._connect_peers()
        first_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        second = self._signed_request("req-second", self.identity_a, "", self.identity_a)
        await self.friend_b.handle_packet(
            self._peer_from(self.manager_b, self.identity_a),
            Packet(PacketType.FRIEND_REQUEST, second.encode()),
        )
        await asyncio.sleep(0.05)
        requests = await self.friend_b.db.get_pending_friend_requests()
        self.assertEqual([r["request_id"] for r in requests], [first_id])
        self.assertEqual(len(self.friend_request_events), 1)

    async def test_new_request_from_existing_friend_is_auto_accepted(self):
        await self._become_friends()
        await self.friend_a.unfriend(self.identity_b.peer_id)
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        self.assertTrue(await self.friend_a.is_friend(self.identity_b.peer_id))
        self.assertTrue(await self.friend_b.is_friend(self.identity_a.peer_id))
        self.assertEqual(await self.friend_b.db.get_pending_friend_requests(), [])
        self.assertEqual((await self.friend_a.db.get_friend_request(request_id))["status"], "accepted")

    async def test_friend_request_event_contains_expected_fields(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id, "be my friend")
        await asyncio.sleep(0.05)
        event = self.friend_request_events[0]
        self.assertEqual(event["request_id"], request_id)
        self.assertEqual(event["sender_id"], self.identity_a.peer_id)
        self.assertEqual(event["sender_name"], "Alice")
        self.assertEqual(event["note"], "be my friend")
        self.assertGreater(event["created_at"], 0)

    # ---- responding --------------------------------------------------------------------

    async def test_respond_to_unknown_request_raises(self):
        with self.assertRaises(ValueError):
            await self.friend_a.respond_to_friend_request("no-such-request", True)

    async def test_respond_to_already_answered_request_raises(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        await self.friend_b.respond_to_friend_request(request_id, accept=True)
        with self.assertRaises(ValueError):
            await self.friend_b.respond_to_friend_request(request_id, accept=True)

    async def test_respond_when_requester_offline_raises(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        self._peer_from(self.manager_b, self.identity_a).writer.close()
        await asyncio.sleep(0.05)
        with self.assertRaises(ValueError):
            await self.friend_b.respond_to_friend_request(request_id, accept=True)
        self.assertEqual((await self.friend_b.db.get_friend_request(request_id))["status"], "pending")

    async def test_friend_response_event_contains_expected_fields(self):
        request_id = await self._become_friends()
        event = self.friend_response_events[-1]
        self.assertEqual(event["request_id"], request_id)
        self.assertEqual(event["peer_id"], self.identity_b.peer_id)
        self.assertEqual(event["display_name"], "Bob")
        self.assertTrue(event["accepted"])

    async def test_forged_accept_response_is_rejected(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        payload = self._signed_response(request_id, self.identity_b, True, self.mallory)
        with self.assertRaises(ValueError):
            await self.friend_a.handle_packet(
                self._peer_from(self.manager_a, self.identity_b),
                Packet(PacketType.FRIEND_REQUEST_RESPONSE, payload.encode()),
            )
        self.assertFalse(await self.friend_a.is_friend(self.identity_b.peer_id))
        self.assertEqual((await self.friend_a.db.get_friend_request(request_id))["status"], "pending")

    async def test_accept_response_responder_must_match_authenticated_peer(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        payload = self._signed_response(request_id, self.mallory, True, self.identity_b)
        with self.assertRaises(ValueError):
            await self.friend_a.handle_packet(
                self._peer_from(self.manager_a, self.identity_b),
                Packet(PacketType.FRIEND_REQUEST_RESPONSE, payload.encode()),
            )
        self.assertFalse(await self.friend_a.is_friend(self.identity_b.peer_id))

    async def test_response_for_unknown_outgoing_request_is_ignored(self):
        await self._connect_peers()
        payload = self._signed_response("unknown-request", self.identity_b, True, self.identity_b)
        await self.friend_a.handle_packet(
            self._peer_from(self.manager_a, self.identity_b),
            Packet(PacketType.FRIEND_REQUEST_RESPONSE, payload.encode()),
        )
        self.assertEqual(self.friend_response_events, [])
        self.assertFalse(await self.friend_a.is_friend(self.identity_b.peer_id))

    async def test_duplicate_accept_response_is_ignored(self):
        request_id = await self._become_friends()
        payload = self._signed_response(request_id, self.identity_b, True, self.identity_b)
        await self.friend_a.handle_packet(
            self._peer_from(self.manager_a, self.identity_b),
            Packet(PacketType.FRIEND_REQUEST_RESPONSE, payload.encode()),
        )
        self.assertEqual(len(self.friend_response_events), 1)
        self.assertEqual((await self.friend_a.db.get_friend_request(request_id))["status"], "accepted")

    async def test_declined_response_does_not_add_friend(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        await self.friend_b.respond_to_friend_request(request_id, accept=False)
        await asyncio.sleep(0.05)
        self.assertFalse(await self.friend_a.is_friend(self.identity_b.peer_id))
        self.assertEqual((await self.friend_a.db.get_friend_request(request_id))["status"], "declined")

    # ---- unfriend ----------------------------------------------------------------------

    async def test_unfriend_non_friend_raises(self):
        with self.assertRaises(ValueError):
            await self.friend_a.unfriend(self.identity_b.peer_id)

    async def test_unfriend_removes_from_friends_list(self):
        await self._become_friends()
        await self.friend_a.unfriend(self.identity_b.peer_id)
        self.assertFalse(await self.friend_a.is_friend(self.identity_b.peer_id))
        self.assertEqual(await self.db_a.get_friends(), [])
        self.assertTrue(await self.friend_b.is_friend(self.identity_a.peer_id))

    # ---- blocked notices ---------------------------------------------------------------

    async def test_forged_blocked_notice_is_rejected(self):
        await self._connect_peers()
        payload = self._signed_blocked("any-message", self.identity_b, self.mallory)
        with self.assertRaises(ValueError):
            await self.friend_a.handle_packet(
                self._peer_from(self.manager_a, self.identity_b),
                Packet(PacketType.MESSAGE_BLOCKED, payload.encode()),
            )
        self.assertEqual(self.message_blocked_events, [])

    async def test_blocked_notice_must_name_the_authenticated_peer(self):
        await self._connect_peers()
        payload = self._signed_blocked("any-message", self.mallory, self.identity_b)
        with self.assertRaises(ValueError):
            await self.friend_a.handle_packet(
                self._peer_from(self.manager_a, self.identity_b),
                Packet(PacketType.MESSAGE_BLOCKED, payload.encode()),
            )
        self.assertEqual(self.message_blocked_events, [])

    async def test_valid_blocked_notice_marks_outgoing_message_blocked(self):
        await self._connect_peers()
        message_id = await self.router_a.send_message(self.identity_b.peer_id, b"hello")
        payload = self._signed_blocked(message_id, self.identity_b, self.identity_b)
        await self.friend_a.handle_packet(
            self._peer_from(self.manager_a, self.identity_b),
            Packet(PacketType.MESSAGE_BLOCKED, payload.encode()),
        )
        await asyncio.sleep(0.05)
        event = self.message_blocked_events[0]
        self.assertEqual(event["message_id"], message_id)
        self.assertEqual(event["peer_id"], self.identity_b.peer_id)
        async with self.db_a._db.execute(
            "SELECT blocked FROM messages WHERE message_id = ?", (message_id,)
        ) as cursor:
            self.assertEqual((await cursor.fetchone())[0], 1)

    async def test_blocked_notice_for_unknown_message_is_harmless(self):
        await self._connect_peers()
        payload = self._signed_blocked("never-existed", self.identity_b, self.identity_b)
        await self.friend_a.handle_packet(
            self._peer_from(self.manager_a, self.identity_b),
            Packet(PacketType.MESSAGE_BLOCKED, payload.encode()),
        )
        self.assertEqual(self.message_blocked_events[0]["message_id"], "never-existed")

    async def test_blocked_notice_drops_local_friend(self):
        await self._become_friends()
        await self.friend_b.unfriend(self.identity_a.peer_id)
        message_id = await self.router_a.send_message(self.identity_b.peer_id, b"hello again")
        event = await self._wait_for_blocked()
        self.assertIsNotNone(event)
        self.assertEqual(event["message_id"], message_id)
        self.assertTrue(event["removed_friend"])
        self.assertFalse(await self.friend_a.is_friend(self.identity_b.peer_id))
        self.assertEqual(await self.db_a.get_friends(), [])
        self.assertFalse(await self.friend_b.is_friend(self.identity_a.peer_id))

    async def test_blocked_notice_for_never_friend_does_not_flag_removal(self):
        await self._connect_peers()
        message_id = await self.router_a.send_message(self.identity_b.peer_id, b"hello stranger")
        event = await self._wait_for_blocked()
        self.assertIsNotNone(event)
        self.assertEqual(event["message_id"], message_id)
        self.assertFalse(event["removed_friend"])
        self.assertFalse(await self.friend_a.is_friend(self.identity_b.peer_id))

    async def test_peer_can_resend_request_after_blocked_notice(self):
        await self._become_friends()
        await self.friend_b.unfriend(self.identity_a.peer_id)
        await self.router_a.send_message(self.identity_b.peer_id, b"hello again")
        await self._wait_for_blocked()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id, "can we talk?")
        request = await self._wait_for_request(request_id, self.friend_b.db)
        self.assertIsNotNone(request)

    # ---- multiple parties --------------------------------------------------------------

    async def test_simultaneous_requests_are_both_resolved(self):
        await self._connect_peers()
        request_a = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.02)
        request_b = await self.friend_b.send_friend_request(self.identity_a.peer_id)
        await asyncio.sleep(0.05)
        # B accepts A's request — B auto-cancels its own outgoing (request_b)
        # and sends the cancel to A. Both become friends.
        await self.friend_b.respond_to_friend_request(request_a, accept=True)
        await asyncio.sleep(0.05)
        self.assertTrue(await self.friend_a.is_friend(self.identity_b.peer_id))
        self.assertTrue(await self.friend_b.is_friend(self.identity_a.peer_id))
        self.assertEqual((await self.friend_a.db.get_friend_request(request_a))["status"], "accepted")
        self.assertEqual((await self.friend_b.db.get_friend_request(request_a))["status"], "accepted")

    # ---- persistence -------------------------------------------------------------------

    async def test_pending_request_records_recipient(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        outgoing = await self.friend_a.db.get_friend_request(request_id)
        self.assertEqual(outgoing["recipient_id"], self.identity_b.peer_id)
        self.assertEqual(outgoing["recipient_name"], "Bob")
        incoming = await self.friend_b.db.get_friend_request(request_id)
        self.assertEqual(incoming["recipient_id"], self.identity_b.peer_id)
        self.assertEqual(incoming["recipient_name"], "Bob")

    async def test_pending_request_persists_across_reload(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id, "persist me")
        await asyncio.sleep(0.05)
        reopened = Database(self.db_b_path)
        await reopened.connect()
        request = await reopened.get_friend_request(request_id)
        self.assertEqual(request["status"], "pending")
        self.assertEqual(request["direction"], "incoming")
        self.assertEqual(request["note"], "persist me")
        await reopened.close()

    async def test_declined_request_status_persists(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        await self.friend_b.respond_to_friend_request(request_id, accept=False)
        reopened = Database(self.db_b_path)
        await reopened.connect()
        self.assertEqual((await reopened.get_friend_request(request_id))["status"], "declined")
        await reopened.close()

    async def test_friends_list_contains_accepted_friend(self):
        await self._become_friends()
        friends = await self.db_a.get_friends()
        self.assertEqual([f["peer_id"] for f in friends], [self.identity_b.peer_id])
        self.assertEqual(friends[0]["display_name"], "Bob")

    # ---- blocking ----------------------------------------------------------------------

    async def test_cannot_block_self(self):
        with self.assertRaises(ValueError):
            await self.friend_a.block_peer(self.identity_a.peer_id)

    async def test_blocking_peer_ignores_incoming_friend_requests(self):
        await self._connect_peers()
        await self.friend_a.block_peer(self.identity_b.peer_id)
        request_id = await self.friend_b.send_friend_request(self.identity_a.peer_id, "hello?")
        await asyncio.sleep(0.05)
        self.assertIsNone(await self.friend_a.db.get_friend_request(request_id))
        self.assertEqual(self.friend_request_events, [])
        self.assertFalse(await self.friend_a.is_peer_blocked(self.identity_a.peer_id))

    async def test_cannot_send_friend_request_to_blocked_peer(self):
        await self._connect_peers()
        await self.friend_a.block_peer(self.identity_b.peer_id)
        with self.assertRaises(ValueError):
            await self.friend_a.send_friend_request(self.identity_b.peer_id)

    async def test_unblocking_allows_requests_again(self):
        await self._connect_peers()
        await self.friend_a.block_peer(self.identity_b.peer_id)
        await self.friend_a.unblock_peer(self.identity_b.peer_id)
        self.assertFalse(await self.friend_a.is_peer_blocked(self.identity_b.peer_id))
        request_id = await self.friend_b.send_friend_request(self.identity_a.peer_id)
        request = await self._wait_for_request(request_id, self.friend_a.db)
        self.assertIsNotNone(request)
        self.assertEqual(request["status"], "pending")

    async def test_blocking_peer_unfriends_and_declines_pending_requests(self):
        await self._connect_peers()
        request_id = await self.friend_b.send_friend_request(self.identity_a.peer_id)
        await self._wait_for_request(request_id, self.friend_a.db)
        await self.friend_a.block_peer(self.identity_b.peer_id)
        self.assertEqual((await self.friend_a.db.get_friend_request(request_id))["status"], "declined")
        self.assertTrue(await self.friend_a.is_peer_blocked(self.identity_b.peer_id))
        self.assertFalse(await self.friend_a.is_friend(self.identity_b.peer_id))

    async def test_blocking_an_existing_friend_removes_friendship(self):
        await self._become_friends()
        await self.friend_a.block_peer(self.identity_b.peer_id)
        self.assertFalse(await self.friend_a.is_friend(self.identity_b.peer_id))
        self.assertTrue(await self.friend_b.is_friend(self.identity_a.peer_id))
        self.assertEqual([peer["peer_id"] for peer in await self.friend_a.get_blocked_peers()], [self.identity_b.peer_id])

    async def test_blocking_twice_raises(self):
        await self.friend_a.block_peer(self.identity_b.peer_id)
        with self.assertRaises(ValueError):
            await self.friend_a.block_peer(self.identity_b.peer_id)

    async def test_unblocking_not_blocked_peer_raises(self):
        with self.assertRaises(ValueError):
            await self.friend_a.unblock_peer(self.identity_b.peer_id)

    async def test_blocked_peer_remains_blocked_for_friendships(self):
        await self._connect_peers()
        await self.friend_a.block_peer(self.identity_b.peer_id)
        self.assertTrue(await self.friend_a.is_peer_blocked(self.identity_b.peer_id))
        await self.friend_a.unblock_peer(self.identity_b.peer_id)
        self.assertEqual(await self.friend_a.get_blocked_peers(), [])

    # ---- cancel ------------------------------------------------------------------------

    async def test_cancel_outgoing_friend_request(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        await self.friend_a.cancel_friend_request(request_id)
        await asyncio.sleep(0.05)
        self.assertEqual((await self.friend_a.db.get_friend_request(request_id))["status"], "cancelled")
        self.assertEqual((await self.friend_b.db.get_friend_request(request_id))["status"], "cancelled")
        self.assertFalse(await self.friend_a.is_friend(self.identity_b.peer_id))

    async def test_cancel_nonexistent_request_raises(self):
        with self.assertRaises(ValueError):
            await self.friend_a.cancel_friend_request("no-such-request")

    async def test_cancel_incoming_request_raises(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        with self.assertRaises(ValueError):
            await self.friend_b.cancel_friend_request(request_id)

    async def test_cancel_already_answered_request_raises(self):
        await self._become_friends()
        request = await self.friend_a.db.get_pending_request_with(self.identity_b.peer_id, "outgoing")
        if request:
            with self.assertRaises(ValueError):
                await self.friend_a.cancel_friend_request(request["request_id"])

    async def test_cancel_event_received_by_remote_peer(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        await self.friend_a.cancel_friend_request(request_id)
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.friend_cancelled_events), 1)
        event = self.friend_cancelled_events[0]
        self.assertEqual(event["request_id"], request_id)
        self.assertEqual(event["peer_id"], self.identity_a.peer_id)
        self.assertEqual(event["display_name"], "Alice")

    async def test_forged_cancel_notice_is_rejected(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        payload = self._signed_cancel(request_id, self.identity_a, self.mallory)
        with self.assertRaises(ValueError):
            await self.friend_b.handle_packet(
                self._peer_from(self.manager_b, self.identity_a),
                Packet(PacketType.FRIEND_REQUEST_CANCELLED, payload.encode()),
            )
        self.assertEqual(self.friend_cancelled_events, [])
        self.assertEqual((await self.friend_b.db.get_friend_request(request_id))["status"], "pending")

    async def test_cancel_notice_sender_must_match_authenticated_peer(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        payload = self._signed_cancel(request_id, self.mallory, self.identity_a)
        with self.assertRaises(ValueError):
            await self.friend_b.handle_packet(
                self._peer_from(self.manager_b, self.identity_a),
                Packet(PacketType.FRIEND_REQUEST_CANCELLED, payload.encode()),
            )
        self.assertEqual(self.friend_cancelled_events, [])

    async def test_cancel_for_unknown_request_is_harmless(self):
        await self._connect_peers()
        payload = self._signed_cancel("unknown-request", self.identity_a, self.identity_a)
        await self.friend_b.handle_packet(
            self._peer_from(self.manager_b, self.identity_a),
            Packet(PacketType.FRIEND_REQUEST_CANCELLED, payload.encode()),
        )
        self.assertEqual(self.friend_cancelled_events, [])

    async def test_cancel_when_recipient_offline_raises(self):
        await self._connect_peers()
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.05)
        self._peer_from(self.manager_a, self.identity_b).writer.close()
        await asyncio.sleep(0.05)
        with self.assertRaises(ValueError):
            await self.friend_a.cancel_friend_request(request_id)

    async def test_mutual_request_auto_cancelled_on_accept(self):
        await self._connect_peers()
        request_a = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        await asyncio.sleep(0.02)
        request_b = await self.friend_b.send_friend_request(self.identity_a.peer_id)
        await asyncio.sleep(0.05)
        await self.friend_a.respond_to_friend_request(request_b, accept=True)
        await asyncio.sleep(0.05)
        self.assertTrue(await self.friend_a.is_friend(self.identity_b.peer_id))
        self.assertEqual((await self.friend_a.db.get_friend_request(request_a))["status"], "cancelled")
        self.assertEqual((await self.friend_a.db.get_friend_request(request_b))["status"], "accepted")
        self.assertTrue(await self.friend_b.is_friend(self.identity_a.peer_id))
