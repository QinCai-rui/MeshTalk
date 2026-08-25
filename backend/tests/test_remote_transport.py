import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from cryptography.exceptions import InvalidTag

from meshtalk.database import Database
from meshtalk.identity import Identity
from meshtalk.friends import FriendManager
from meshtalk.message_router import MessageRouter
from meshtalk.peer_manager import PeerConnection, PeerManager, PeerState
from meshtalk.protocol import CAP_TEXT_CHAT
from meshtalk.rendezvous import RendezvousService, decrypt_endpoint_card, encrypt_endpoint_card
from meshtalk.settings import Room, Settings
from meshtalk.udp_transport import Attempt, HELLO, MAGIC, READY, UdpTransport


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

    async def test_force_turn_does_not_start_direct_attempts(self):
        transport = UdpTransport(self.identity_a, lambda *_: None, lambda *_: None, lambda *_: None, force_turn=True)

        transport.expect_peer(self.identity_b.peer_id, ("203.0.113.1", 24890))

        self.assertIn(self.identity_b.peer_id, transport._direct_candidates)
        self.assertNotIn(self.identity_b.peer_id, transport._attempts)

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
    async def test_initial_room_signals_are_roster_snapshots_but_later_signals_are_live(self):
        with tempfile.TemporaryDirectory() as temporary:
            local = Identity.generate("Local")
            remote = Identity.generate("Remote")
            settings = Settings(Path(temporary) / "settings.json")
            room = settings.create_room("Group")
            observed = []

            class FakeUdp:
                def expect_peer(self, *_):
                    pass

            async def record_candidate(*_):
                pass

            async def record_member(group_id, peer_id, announce_join):
                observed.append((group_id, peer_id, announce_join))

            class FakeWebsocket:
                def __init__(self, messages):
                    self.messages = messages

                def __aiter__(self):
                    return self

                async def __anext__(self):
                    if not self.messages:
                        raise StopAsyncIteration
                    return self.messages.pop(0)

            service = RendezvousService(
                local, settings, FakeUdp(), record_candidate, record_member
            )
            service._initializing_rooms.add(room.id)
            websocket = FakeWebsocket([
                json.dumps({
                    "type": "signal", "room_id": room.id,
                    "payload": encrypt_endpoint_card(remote, room, None),
                }),
                json.dumps({"type": "joined", "room_id": room.id, "member_count": 2}),
                json.dumps({
                    "type": "signal", "room_id": room.id,
                    "payload": encrypt_endpoint_card(remote, room, None),
                }),
            ])

            await service._receive_loop(websocket)

            self.assertEqual(
                observed,
                [(room.id, remote.peer_id, False), (room.id, remote.peer_id, True)],
            )

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
    async def test_two_relay_only_peers_connect(self):
        local = Identity.generate("Local")
        remote = Identity.generate("Remote")
        connected = {local.peer_id: asyncio.Event(), remote.peer_id: asyncio.Event()}
        transports = {}

        async def on_local_connected(*_):
            connected[local.peer_id].set()

        async def on_remote_connected(*_):
            connected[remote.peer_id].set()

        async def ignore(*_):
            pass

        local_transport = UdpTransport(local, on_local_connected, ignore, ignore, force_turn=True)
        remote_transport = UdpTransport(remote, on_remote_connected, ignore, ignore, force_turn=True)
        local_endpoint, remote_endpoint = ("127.0.0.1", 41001), ("127.0.0.1", 41002)
        transports[local_endpoint], transports[remote_endpoint] = local_transport, remote_transport

        class FakeRelay:
            transport = object()

            def __init__(self, endpoint):
                self.endpoint = endpoint

            def sendto(self, data, endpoint):
                asyncio.get_running_loop().call_soon(
                    transports[endpoint]._relay_datagram_received, data, self.endpoint
                )

            async def stop(self):
                pass

        local_transport._relays = [FakeRelay(local_endpoint)]
        remote_transport._relays = [FakeRelay(remote_endpoint)]
        local_transport.expect_relay_peer(remote.peer_id, remote_endpoint)
        remote_transport.expect_relay_peer(local.peer_id, local_endpoint)

        async with asyncio.timeout(2):
            await asyncio.gather(*[event.wait() for event in connected.values()])
        self.assertTrue(local_transport._sessions[remote.peer_id].via_relay)
        self.assertTrue(remote_transport._sessions[local.peer_id].via_relay)
        await local_transport.stop()
        await remote_transport.stop()

    async def test_direct_peer_connects_to_relay_only_peer(self):
        relay_identity = Identity.generate("Relay")
        direct_identity = Identity.generate("Direct")
        relay_connected, direct_connected = asyncio.Event(), asyncio.Event()

        async def mark_relay(*_):
            relay_connected.set()

        async def mark_direct(*_):
            direct_connected.set()

        async def ignore(*_):
            pass

        relay_transport = UdpTransport(relay_identity, mark_relay, ignore, ignore, force_turn=True)
        direct_transport = UdpTransport(direct_identity, mark_direct, ignore, ignore)
        relay_endpoint, direct_endpoint = ("127.0.0.1", 42001), ("127.0.0.1", 42002)

        class FakeRelay:
            transport = object()
            endpoint = relay_endpoint

            def sendto(self, data, endpoint):
                self.assert_endpoint(endpoint)
                asyncio.get_running_loop().call_soon(
                    direct_transport.datagram_received, data, relay_endpoint
                )

            def assert_endpoint(self, endpoint):
                if endpoint != direct_endpoint:
                    raise AssertionError(endpoint)

            async def stop(self):
                pass

        class FakeDirectTransport:
            def sendto(self, data, endpoint):
                if endpoint != relay_endpoint:
                    raise AssertionError(endpoint)
                asyncio.get_running_loop().call_soon(
                    relay_transport._relay_datagram_received, data, direct_endpoint
                )

            def close(self):
                pass

        relay_transport._relays = [FakeRelay()]
        direct_transport._transport = FakeDirectTransport()
        relay_transport.expect_peer(direct_identity.peer_id, direct_endpoint)
        direct_transport.expect_relay_peer(relay_identity.peer_id, relay_endpoint)

        async with asyncio.timeout(2):
            await asyncio.gather(relay_connected.wait(), direct_connected.wait())
        self.assertTrue(relay_transport._sessions[direct_identity.peer_id].via_relay)
        self.assertFalse(direct_transport._sessions[relay_identity.peer_id].via_relay)
        await relay_transport.stop()
        await direct_transport.stop()

    async def test_capability_gap_keeps_shared_udp_capabilities_enabled(self):
        local = Identity.generate("Local")
        remote = Identity.generate("Remote")

        async def ignore(*args):
            pass

        transport = UdpTransport(local, ignore, ignore, ignore, capabilities=[CAP_TEXT_CHAT])
        endpoint = ("127.0.0.1", 45454)
        transport._sendto = lambda *_: None
        transport.expect_peer(remote.peer_id, endpoint)
        remote_transport = UdpTransport(
            remote, ignore, ignore, ignore,
            capabilities=[CAP_TEXT_CHAT, "CAP_ADASDASD_NEW_TEST"],
        )
        hello = remote_transport._make_hello(Attempt(local.peer_id, endpoint))
        transport.datagram_received(hello, endpoint)

        self.assertEqual(transport.get_capabilities(remote.peer_id), [CAP_TEXT_CHAT])
        self.assertEqual(
            transport.get_capability_gaps(remote.peer_id),
            (["CAP_ADASDASD_NEW_TEST", CAP_TEXT_CHAT], [], ["CAP_ADASDASD_NEW_TEST"]),
        )
        await transport.stop()

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

    async def test_relay_only_card_clears_stale_direct_state(self):
        local, remote = Identity.generate("Local"), Identity.generate("Remote")
        calls = []

        class FakeUdp:
            force_turn = False

            def expect_peer(self, peer_id, endpoint):
                calls.append(("direct", peer_id, endpoint))

            def clear_direct_candidate(self, peer_id):
                calls.append(("clear", peer_id))

            def expect_relay_peer(self, peer_id, endpoint):
                calls.append(("relay", peer_id, endpoint))

        async def record_candidate(peer_id, endpoint):
            calls.append(("record", peer_id, endpoint))

        with tempfile.TemporaryDirectory() as temporary:
            settings = Settings(Path(temporary) / "settings.json")
            room = settings.create_room()
            rendezvous = RendezvousService(local, settings, FakeUdp(), record_candidate, allow_loopback=True)
            await rendezvous._handle_card(room, encrypt_endpoint_card(remote, room, ("127.0.0.1", 12345)))
            await rendezvous._handle_card(room, encrypt_endpoint_card(remote, room, None, [("127.0.0.1", 54321)]))

        self.assertIn(("clear", remote.peer_id), calls)
        self.assertIn(("relay", remote.peer_id, ("127.0.0.1", 54321)), calls)
