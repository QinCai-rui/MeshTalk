import asyncio
import tempfile
import unittest
from pathlib import Path

from cryptography.exceptions import InvalidTag

from meshtalk.database import Database
from meshtalk.identity import Identity
from meshtalk.message_router import MessageRouter
from meshtalk.peer_manager import PeerManager
from meshtalk.rendezvous import decrypt_endpoint_card, encrypt_endpoint_card
from meshtalk.settings import Room, Settings


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

        message_id = await self.router_a.send_message(self.identity_b.peer_id, b"remote secret")
        received = await asyncio.wait_for(self.received.get(), 2)
        self.assertEqual(received["message_id"], message_id)
        self.assertEqual(received["content"], "remote secret")
        network = self.manager_a.get_network_info(self.identity_b.peer_id)
        self.assertEqual(network["active_transport"], "remote_udp")
        self.assertEqual(network["active_endpoint"], f"127.0.0.1:{endpoint_b[1]}")


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

    def test_settings_persist_private_rooms(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "settings.json"
            settings = Settings(path)
            room = settings.create_room()
            loaded = Settings(path)
            self.assertEqual(loaded.rooms[room.id], room)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
