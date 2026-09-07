import time
import unittest
from types import SimpleNamespace

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from meshtalk.ack_router import AckRouter
from meshtalk.identity import Identity
from meshtalk.protocol import (
    CAP_GROUP_CHAT,
    CAP_MESSAGE_ACKNOWLEDGEMENTS,
    GroupAcknowledgePayload,
    MessageAcknowledgePayload,
    PacketType,
    capability_for_packet,
)


class _Database:
    def __init__(self, members=None):
        self.members = members or {}
        self.message_acks = {}
        self.group_acks = {}
        self.outqueue = []
        self._caps = {}

    async def is_peer_blocked(self, peer_id):
        return False

    async def peer_supports(self, peer_id, capability):
        return self._caps.get((peer_id, capability), True)

    async def get_group_members(self, group_id):
        return self.members.get(group_id, [])

    async def get_group_member(self, group_id, peer_id):
        return next(
            (m for m in self.members.get(group_id, []) if m["peer_id"] == peer_id),
            None,
        )

    async def set_message_ack(self, target_id, acker_id, kind="message", created_at=None):
        self.message_acks[(target_id, acker_id)] = kind
        return {"target_id": target_id, "acker_id": acker_id}

    async def remove_message_ack(self, target_id, acker_id):
        return self.message_acks.pop((target_id, acker_id), None) is not None

    async def set_group_message_ack(self, target_id, group_id, acker_id, kind="message", created_at=None):
        self.group_acks[(target_id, group_id, acker_id)] = kind
        return {"target_id": target_id}

    async def remove_group_message_ack(self, target_id, group_id, acker_id):
        return self.group_acks.pop((target_id, group_id, acker_id), None) is not None

    async def add_to_outqueue(self, recipient_id, packet_type, payload, message_id=None, group_id=None):
        self.outqueue.append((recipient_id, packet_type, message_id, group_id))


class _Friends:
    def __init__(self, friends=True):
        self._friends = friends

    async def is_friend(self, peer_id):
        return self._friends


class _Peer:
    def __init__(self, identity, caps=True):
        self.peer_id = identity.peer_id
        self.display_name = identity.display_name
        self.encryption_public_key = identity.encryption_public_key_bytes()
        self.signing_public_key = identity.signing_public_key_bytes()
        self._caps = caps

    def supports(self, capability):
        if self._caps is False:
            return False
        return capability in (CAP_GROUP_CHAT, CAP_MESSAGE_ACKNOWLEDGEMENTS)


class _PeerManager:
    def __init__(self, *peers):
        self.peers = {peer.peer_id: peer for peer in peers}
        self.sent = []

    def get_connected_peer(self, peer_id):
        return self.peers.get(peer_id)

    async def send_packet(self, peer, packet):
        self.sent.append((peer, packet))


def _settings(group_id=None):
    rooms = {}
    if group_id:
        rooms[group_id] = SimpleNamespace(group_name="Team")
    return SimpleNamespace(rooms=rooms)


class AckPayloadTest(unittest.TestCase):
    def test_message_ack_roundtrip(self):
        alice = Identity.generate("Alice")
        payload = MessageAcknowledgePayload("mid123", "message", alice.peer_id, True, time.time())
        payload.signature = alice.signing_private_key.sign(payload.signed_bytes())
        decoded = MessageAcknowledgePayload.decode(payload.encode())
        Ed25519PublicKey.from_public_bytes(alice.signing_public_key_bytes()).verify(
            decoded.signature, decoded.signed_bytes()
        )
        self.assertEqual(decoded.target_id, "mid123")
        self.assertTrue(decoded.acknowledged)

    def test_group_ack_roundtrip(self):
        alice = Identity.generate("Alice")
        payload = GroupAcknowledgePayload("mid123", "a" * 32, "file", alice.peer_id, False, time.time())
        payload.signature = alice.signing_private_key.sign(payload.signed_bytes())
        decoded = GroupAcknowledgePayload.decode(payload.encode())
        self.assertEqual(decoded.group_id, "a" * 32)
        self.assertFalse(decoded.acknowledged)

    def test_ack_packets_are_capability_gated(self):
        self.assertEqual(capability_for_packet(PacketType.MESSAGE_ACKNOWLEDGE), CAP_MESSAGE_ACKNOWLEDGEMENTS)
        self.assertEqual(capability_for_packet(PacketType.GROUP_ACKNOWLEDGE), CAP_MESSAGE_ACKNOWLEDGEMENTS)
        self.assertIn(CAP_MESSAGE_ACKNOWLEDGEMENTS, __import__("meshtalk.protocol", fromlist=["DEFAULT_CAPABILITIES"]).DEFAULT_CAPABILITIES)

    def test_invalid_ack_payloads_rejected(self):
        alice = Identity.generate("Alice")
        bad = MessageAcknowledgePayload("", "message", alice.peer_id, True, time.time())
        bad.signature = alice.signing_private_key.sign(bad.signed_bytes())
        with self.assertRaises(ValueError):
            MessageAcknowledgePayload.decode(bad.encode())
        bad_kind = MessageAcknowledgePayload("mid", "emoji", alice.peer_id, True, time.time())
        bad_kind.signature = alice.signing_private_key.sign(bad_kind.signed_bytes())
        with self.assertRaises(ValueError):
            MessageAcknowledgePayload.decode(bad_kind.encode())


class AckRouterTest(unittest.IsolatedAsyncioTestCase):
    async def test_direct_ack_send_receive_and_toggle_off(self):
        alice = Identity.generate("Alice")
        bob = Identity.generate("Bob")
        sender_db = _Database()
        sender = AckRouter(alice, _PeerManager(_Peer(bob)), sender_db, _settings(), _Friends())
        result = await sender.send_direct(bob.peer_id, "msg-1", "message", True)
        self.assertTrue(result["acknowledged"])

        # Receiver stores + emits
        events = []

        async def on_event(event):
            events.append(event)

        receiver_db = _Database()
        receiver = AckRouter(bob, _PeerManager(_Peer(alice)), receiver_db, _settings(), _Friends(), on_event)
        # Rebuild the exact packet the sender emitted
        self.assertEqual(len(sender.peer_manager.sent), 1)
        _, packet = sender.peer_manager.sent[0]
        self.assertEqual(packet.type, PacketType.MESSAGE_ACKNOWLEDGE)
        self.assertTrue(await receiver.handle_packet(_Peer(alice), packet))
        self.assertEqual(events[0]["event"], "message_acknowledged")
        self.assertEqual(events[0]["target_id"], "msg-1")
        self.assertTrue(events[0]["acknowledged"])
        self.assertIn(("msg-1", alice.peer_id), receiver_db.message_acks)

        # Toggle off removes the row and emits acknowledged=False
        toggle_payload = MessageAcknowledgePayload("msg-1", "message", alice.peer_id, False, time.time())
        toggle_payload.signature = alice.signing_private_key.sign(toggle_payload.signed_bytes())
        from meshtalk.protocol import Packet

        events.clear()
        await receiver.handle_packet(
            _Peer(alice), Packet(PacketType.MESSAGE_ACKNOWLEDGE, toggle_payload.encode())
        )
        self.assertFalse(events[0]["acknowledged"])
        self.assertNotIn(("msg-1", alice.peer_id), receiver_db.message_acks)

    async def test_direct_ack_offline_queues(self):
        alice = Identity.generate("Alice")
        bob = Identity.generate("Bob")
        db = _Database()
        router = AckRouter(alice, _PeerManager(), db, _settings(), _Friends())
        await router.send_direct(bob.peer_id, "msg-9", "message", True)
        self.assertEqual(len(db.outqueue), 1)
        self.assertEqual(db.outqueue[0][1], PacketType.MESSAGE_ACKNOWLEDGE.value)

    async def test_direct_ack_rejected_without_capability(self):
        alice = Identity.generate("Alice")
        bob = Identity.generate("Bob")
        router = AckRouter(alice, _PeerManager(_Peer(bob, caps=False)), _Database(), _settings(), _Friends())
        with self.assertRaisesRegex(ValueError, "support acknowledgement"):
            await router.send_direct(bob.peer_id, "msg-1", "message", True)

    async def test_direct_ack_rejected_for_non_friend(self):
        alice = Identity.generate("Alice")
        bob = Identity.generate("Bob")
        router = AckRouter(
            alice, _PeerManager(_Peer(bob)), _Database(), _settings(), _Friends(friends=False)
        )
        with self.assertRaisesRegex(ValueError, "not a friend"):
            await router.send_direct(bob.peer_id, "msg-1", "message", True)

    async def test_group_ack_fans_out_and_toggle(self):
        group_id = "b" * 32
        alice = Identity.generate("Alice")
        bob = Identity.generate("Bob")
        carol = Identity.generate("Carol")
        members = [
            {"peer_id": alice.peer_id, "active": 1},
            {"peer_id": bob.peer_id, "active": 1},
            {"peer_id": carol.peer_id, "active": 1},
        ]
        settings = _settings(group_id)
        sender = AckRouter(
            alice, _PeerManager(_Peer(bob), _Peer(carol)), _Database({group_id: members}), settings, _Friends()
        )
        result = await sender.send_group(group_id, "gmsg-1", "message", True)
        self.assertEqual(result["sent"], 2)

        for recipient, packet in sender.peer_manager.sent:
            target_identity = bob if recipient.peer_id == bob.peer_id else carol
            events = []

            async def on_event(event):
                events.append(event)

            receiver = AckRouter(
                target_identity, _PeerManager(_Peer(alice)),
                _Database({group_id: members}), settings, _Friends(), on_event,
            )
            self.assertTrue(await receiver.handle_packet(_Peer(alice), packet))
            self.assertEqual(events[0]["event"], "group_message_acknowledged")
            self.assertEqual(events[0]["group_id"], group_id)

    async def test_group_ack_unknown_group_rejected(self):
        alice = Identity.generate("Alice")
        router = AckRouter(alice, _PeerManager(), _Database(), _settings(), _Friends())
        with self.assertRaisesRegex(ValueError, "Unknown group"):
            await router.send_group("c" * 32, "msg-1", "message", True)

    async def test_bad_signature_rejected(self):
        alice = Identity.generate("Alice")
        bob = Identity.generate("Bob")
        mallory = Identity.generate("Mallory")
        payload = MessageAcknowledgePayload("msg-1", "message", alice.peer_id, True, time.time())
        # Signed by the wrong identity
        payload.signature = mallory.signing_private_key.sign(payload.signed_bytes())
        from meshtalk.protocol import Packet

        receiver = AckRouter(bob, _PeerManager(_Peer(alice)), _Database(), _settings(), _Friends())
        with self.assertRaises(ValueError):
            await receiver.handle_packet(
                _Peer(alice), Packet(PacketType.MESSAGE_ACKNOWLEDGE, payload.encode())
            )


if __name__ == "__main__":
    unittest.main()
