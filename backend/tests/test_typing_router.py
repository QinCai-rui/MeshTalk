import unittest
from types import SimpleNamespace

from meshtalk.identity import Identity
from meshtalk.protocol import CAP_GROUP_CHAT, CAP_TYPING_INDICATORS, PacketType
from meshtalk.typing_router import TypingRouter


class _Database:
    def __init__(self, members=None):
        self.members = members or {}

    async def is_peer_blocked(self, peer_id):
        return False

    async def get_group_members(self, group_id):
        return self.members.get(group_id, [])

    async def get_group_member(self, group_id, peer_id):
        return next((member for member in self.members.get(group_id, []) if member["peer_id"] == peer_id), None)


class _Friends:
    async def is_friend(self, peer_id):
        return True


class _Peer:
    def __init__(self, identity):
        self.peer_id = identity.peer_id
        self.display_name = identity.display_name
        self.encryption_public_key = identity.encryption_public_key_bytes()
        self.signing_public_key = identity.signing_public_key_bytes()

    def supports(self, capability):
        return capability in (CAP_GROUP_CHAT, CAP_TYPING_INDICATORS)


class _PeerManager:
    def __init__(self, *peers):
        self.peers = {peer.peer_id: peer for peer in peers}
        self.sent = []

    def get_connected_peer(self, peer_id):
        return self.peers.get(peer_id)

    async def send_packet(self, peer, packet):
        self.sent.append((peer, packet))


class TypingRouterTest(unittest.IsolatedAsyncioTestCase):
    async def test_direct_typing_is_encrypted_and_emitted_to_local_clients(self):
        alice = Identity.generate("Alice")
        bob = Identity.generate("Bob")
        alice_to_bob = _Peer(bob)
        sender_manager = _PeerManager(alice_to_bob)
        sender = TypingRouter(alice, sender_manager, _Database(), object(), _Friends())

        self.assertTrue(await sender.send_direct(bob.peer_id, True))
        self.assertEqual(len(sender_manager.sent), 1)
        _, packet = sender_manager.sent[0]
        self.assertEqual(packet.type, PacketType.TYPING)
        self.assertNotIn(b'"is_typing":true', packet.payload)

        events = []

        async def on_event(event):
            events.append(event)

        bob_to_alice = _Peer(alice)
        receiver = TypingRouter(bob, _PeerManager(bob_to_alice), _Database(), object(), _Friends(), on_event)
        self.assertTrue(await receiver.handle_packet(bob_to_alice, packet))
        self.assertEqual({key: value for key, value in events[0].items() if key != "created_at"}, {
            "event": "typing", "sender_id": alice.peer_id,
            "display_name": "Alice", "group_id": None, "is_typing": True,
        })
        self.assertIsInstance(events[0]["created_at"], float)

    async def test_offline_direct_typing_is_not_queued(self):
        alice = Identity.generate("Alice")
        bob = Identity.generate("Bob")
        manager = _PeerManager()
        router = TypingRouter(alice, manager, _Database(), object(), _Friends())

        self.assertFalse(await router.send_direct(bob.peer_id, True))
        self.assertEqual(manager.sent, [])

    async def test_group_typing_fans_out_to_two_members(self):
        group_id = "a" * 32
        alice = Identity.generate("Alice")
        bob = Identity.generate("Bob")
        carol = Identity.generate("Carol")
        members = [
            {"peer_id": alice.peer_id, "active": 1},
            {"peer_id": bob.peer_id, "active": 1},
            {"peer_id": carol.peer_id, "active": 1},
        ]
        settings = SimpleNamespace(rooms={group_id: SimpleNamespace(group_name="Team")})
        sender_manager = _PeerManager(_Peer(bob), _Peer(carol))
        sender = TypingRouter(alice, sender_manager, _Database({group_id: members}), settings, _Friends())

        self.assertEqual(await sender.send_group(group_id, True), 2)
        self.assertEqual(len(sender_manager.sent), 2)

        for recipient, packet in sender_manager.sent:
            recipient_identity = bob if recipient.peer_id == bob.peer_id else carol
            events = []

            async def on_event(event):
                events.append(event)

            receiver = TypingRouter(
                recipient_identity, _PeerManager(_Peer(alice)),
                _Database({group_id: members}), settings, _Friends(), on_event,
            )
            self.assertTrue(await receiver.handle_packet(_Peer(alice), packet))
            self.assertEqual(events[0]["group_id"], group_id)
            self.assertTrue(events[0]["is_typing"])
