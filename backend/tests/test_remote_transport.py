import asyncio
import tempfile
import unittest
from pathlib import Path

from cryptography.exceptions import InvalidTag

from meshtalk.database import Database
from meshtalk.identity import Identity
from meshtalk.friends import FriendManager
from meshtalk.message_router import MessageRouter
from meshtalk.peer_manager import PeerConnection, PeerManager, PeerState
from meshtalk.rendezvous import RendezvousService, decrypt_endpoint_card, encrypt_endpoint_card
from meshtalk.settings import Room, Settings
from meshtalk.udp_transport import Attempt, READY, UdpTransport


class RemoteTransportTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        self.identity_a = Identity.generate("Alice")
        self.identity_b = Identity.generate("Bob")
        self.db_a, self.db_b = Database(root / "a.db"), Database(root / "b.db")
        await self.db_a.connect()
        await self.db_b.connect()
        self.received = asyncio.Queue()
        self.manager_a = PeerManager(self.identity_a, self.db_a, lambda *_: None, tcp_port=0)
        self.manager_b = PeerManager(self.identity_b, self.db_b, lambda *_: None, tcp_port=0)
        self.friend_a = FriendManager(self.identity_a, self.manager_a, self.db_a)
        self.friend_b = FriendManager(self.identity_b, self.manager_b, self.db_b)
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

    async def _become_friends(self):
        request_id = await self.friend_a.send_friend_request(self.identity_b.peer_id)
        async with asyncio.timeout(2):
            while await self.db_b.get_friend_request(request_id) is None:
                await asyncio.sleep(0.02)
        await self.friend_b.respond_to_friend_request(request_id, accept=True)
        await asyncio.sleep(0.05)

    async def test_encrypted_message_over_reliable_udp(self):
        endpoint_a = ("127.0.0.1", self.manager_a.udp.local_endpoint[1])
        endpoint_b = ("127.0.0.1", self.manager_b.udp.local_endpoint[1])
        self.manager_a.udp.expect_peer(self.identity_b.peer_id, endpoint_b)
        self.manager_b.udp.expect_peer(self.identity_a.peer_id, endpoint_a)

        async with asyncio.timeout(3):
            while not self.manager_a.get_connected_peer(self.identity_b.peer_id):
                await asyncio.sleep(0.02)
            while not self.manager_b.get_connected_peer(self.identity_a.peer_id):
                await asyncio.sleep(0.02)

        await self._become_friends()
        message_id, _ = await self.router_a.send_message(self.identity_b.peer_id, b"remote secret")
        received = await asyncio.wait_for(self.received.get(), 2)
        self.assertEqual(received["message_id"], message_id)
        self.assertEqual(received["content"], "remote secret")
        network = self.manager_a.get_network_info(self.identity_b.peer_id)
        self.assertEqual(network["active_transport"], "remote_udp")
        self.assertEqual(network["active_endpoint"], f"127.0.0.1:{endpoint_b[1]}")

    async def test_lan_network_info_uses_advertised_port_not_inbound_source_port(self):
        peer = PeerConnection(
            self.identity_b.peer_id, "192.168.1.20", 45982, PeerState.CONNECTED
        )
        self.manager_a.peers[peer.peer_id] = peer
        self.manager_a.record_lan_candidate(peer.peer_id, "192.168.1.20", 24891)

        network = self.manager_a.get_network_info(peer.peer_id)

        self.assertEqual(network["active_endpoint"], "192.168.1.20:24891")
        self.assertEqual(network["endpoints"], [{
            "transport": "lan_tcp",
            "endpoint": "192.168.1.20:24891",
            "active": True,
        }])


class PrivateRoomTest(unittest.TestCase):
    def test_invite_round_trip_and_endpoint_card_privacy(self):
        room = Room.create()
        parsed = Room.from_invite(room.invite)
        self.assertEqual(parsed, room)

        identity = Identity.generate("Alice")
        payload = encrypt_endpoint_card(identity, room, ("203.0.113.7", 42424))
        self.assertNotIn(identity.peer_id, payload)
        self.assertNotIn("203.0.113.7", payload)
        card = decrypt_endpoint_card(room, payload)
        self.assertEqual(card["peer_id"], identity.peer_id)
        self.assertEqual(card["candidate"], {"host": "203.0.113.7", "port": 42424})
        with self.assertRaises(InvalidTag):
            decrypt_endpoint_card(Room.create(), payload)

    def test_room_member_card_can_omit_public_endpoint(self):
        room = Room.create("LAN Group")
        identity = Identity.generate("Alice")

        card = decrypt_endpoint_card(room, encrypt_endpoint_card(identity, room, None))

        self.assertEqual(card["peer_id"], identity.peer_id)
        self.assertIsNone(card["candidate"])

    def test_settings_persist_private_rooms(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "settings.json"
            settings = Settings(path)
            room = settings.create_room()
            settings.dismiss_control_setup()
            loaded = Settings(path)
            self.assertEqual(loaded.rooms[room.id], room)
            self.assertTrue(loaded.control_setup_dismissed)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


class CandidateValidationTest(unittest.IsolatedAsyncioTestCase):
    async def test_private_target_is_rejected_before_punching_or_display(self):
        with tempfile.TemporaryDirectory() as temporary:
            local_identity = Identity.generate("Local")
            remote_identity = Identity.generate("Remote")
            settings = Settings(Path(temporary) / "settings.json")
            room = settings.create_room()
            expected = []
            recorded = []

            class FakeUdp:
                def expect_peer(self, peer_id, endpoint):
                    expected.append((peer_id, endpoint))

            async def record(peer_id, endpoint):
                recorded.append((peer_id, endpoint))

            service = RendezvousService(local_identity, settings, FakeUdp(), record)
            payload = encrypt_endpoint_card(remote_identity, room, ("192.168.1.20", 42424))
            with self.assertRaises(ValueError):
                await service._handle_card(room, payload)
            self.assertEqual(expected, [])
            self.assertEqual(recorded, [])


class UdpKeyConfirmationTest(unittest.IsolatedAsyncioTestCase):
    async def test_reflected_ready_does_not_confirm_session(self):
        local = Identity.generate("Local")
        remote = Identity.generate("Remote")
        connected = []

        async def on_connected(*args):
            connected.append(args)

        async def ignore(*args):
            pass

        transport = UdpTransport(local, on_connected, ignore, ignore)
        remote_transport = UdpTransport(remote, ignore, ignore, ignore)
        endpoint = ("127.0.0.1", 45454)
        sent = []
        transport._sendto = lambda data, address: sent.append((data, address))
        transport.expect_peer(remote.peer_id, endpoint)
        remote_attempt = Attempt(local.peer_id, ("127.0.0.1", 35353))
        hello = remote_transport._make_hello(remote_attempt)

        transport.datagram_received(hello, endpoint)
        reflected_ready = next(data for data, _ in sent if data[4] == READY)
        transport.datagram_received(reflected_ready, endpoint)

        self.assertFalse(transport._sessions[remote.peer_id].confirmed)
        self.assertEqual(connected, [])
        await transport.stop()
