import asyncio
import hmac
import json
import tempfile
import time
import unittest
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from meshtalk.database import Database
from meshtalk.identity import Identity
from meshtalk.friends import FriendManager
from meshtalk.message_router import MessageRouter
from meshtalk.peer_manager import PeerConnection, PeerManager, PeerState
from meshtalk.protocol import CAP_DIRECT_ROUTE_RECOVERY, CAP_TEXT_CHAT, Packet, PacketType
from meshtalk.rendezvous import RendezvousService, _encode, _room_key, decrypt_endpoint_card, encrypt_endpoint_card
from meshtalk.settings import Room, Settings
from meshtalk.udp_transport import AUTH_HEADER, Attempt, GOODBYE, HELLO, MAGIC, READY, Session, UdpTransport


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

    async def test_lan_tcp_takes_over_from_relay(self):
        """Verify that LAN TCP replaces DERP relay even without direct route recovery capability."""
        # A peer without the new recovery capability still receives the
        # established LAN TCP takeover behavior.
        self.manager_b.capabilities = [CAP_TEXT_CHAT]
        self.manager_b.udp.capabilities = [CAP_TEXT_CHAT]
        relay_a = PeerConnection(
            self.identity_b.peer_id, "derp:" + self.identity_b.peer_id, 0,
            PeerState.CONNECTED, "remote_derp"
        )
        relay_b = PeerConnection(
            self.identity_a.peer_id, "derp:" + self.identity_a.peer_id, 0,
            PeerState.CONNECTED, "remote_derp"
        )
        self.manager_a._udp_peers[self.identity_b.peer_id] = relay_a
        self.manager_b._udp_peers[self.identity_a.peer_id] = relay_b
        self.manager_a.peers[self.identity_b.peer_id] = relay_a
        self.manager_b.peers[self.identity_a.peer_id] = relay_b

        if self.identity_a.peer_id < self.identity_b.peer_id:
            initiator, target, target_id = self.manager_a, self.manager_b, self.identity_b.peer_id
        else:
            initiator, target, target_id = self.manager_b, self.manager_a, self.identity_a.peer_id
        target_port = target._server.sockets[0].getsockname()[1]
        await initiator.connect_to_peer(None, "127.0.0.1", target_port)

        async with asyncio.timeout(2):
            while (
                initiator.get_connected_peer(target_id) is None
                or initiator.get_connected_peer(target_id).transport != "lan_tcp"
            ):
                await asyncio.sleep(0.01)

        self.assertEqual(initiator.get_connected_peer(target_id).transport, "lan_tcp")
        self.assertEqual(initiator._udp_peers[target_id].transport, "remote_derp")

    async def test_force_relay_does_not_start_direct_attempts(self):
        transport = UdpTransport(self.identity_a, lambda *_: None, lambda *_: None, lambda *_: None, force_relay=True)

        transport.expect_peer(self.identity_b.peer_id, ("203.0.113.1", 24890))

        self.assertIn(self.identity_b.peer_id, transport._direct_candidates)
        self.assertNotIn(self.identity_b.peer_id, transport._attempts)

    async def test_force_relay_waits_for_a_derp_sender(self):
        transport = UdpTransport(self.identity_a, lambda *_: None, lambda *_: None, lambda *_: None, force_relay=True)

        transport.expect_derp_peer(self.identity_b.peer_id)

        self.assertIn(self.identity_b.peer_id, transport._derp_candidates)
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

    def test_accepts_legacy_direct_only_endpoint_card(self):
        room = Room.create()
        identity = Identity.generate("Legacy")
        endpoint = {"host": "203.0.113.7", "port": 42424}
        value = {
            "kind": "endpoint", "peer_id": identity.peer_id,
            "signing_public_key": identity.signing_public_key_bytes().hex(),
            "candidate": endpoint, "created_at": int(time.time()),
            "nonce": "00" * 16,
        }
        value["signature"] = identity.signing_private_key.sign(
            json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
        ).hex()
        nonce = b"\x01" * 12
        payload = _encode(nonce + AESGCM(_room_key(room)).encrypt(
            nonce, json.dumps(value).encode(), room.room_id
        ))

        card = decrypt_endpoint_card(room, payload)

        self.assertEqual(card["candidates"], [{"type": "direct", **endpoint}])

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
    async def test_direct_udp_recovery_requires_shared_capability(self):
        """Verify that direct UDP recovery from DERP only occurs when both peers support it."""
        local = Identity.generate("Local")
        remote = Identity.generate("Remote")
        local_endpoint = ("127.0.0.1", 45001)
        remote_endpoint = ("127.0.0.1", 45002)

        async def ignore(*_):
            pass

        local_transport = UdpTransport(local, ignore, ignore, ignore)
        remote_transport = UdpTransport(
            remote, ignore, ignore, ignore, capabilities=[CAP_TEXT_CHAT]
        )

        async def send_from_local(peer_id, data):
            remote_transport.derp_datagram_received(local.peer_id, data)

        async def send_from_remote(peer_id, data):
            local_transport.derp_datagram_received(remote.peer_id, data)

        local_transport.configure_derp(send_from_local)
        remote_transport.configure_derp(send_from_remote)
        local_transport.expect_derp_peer(remote.peer_id)
        remote_transport.expect_derp_peer(local.peer_id)

        async with asyncio.timeout(2):
            while not local_transport._sessions.get(remote.peer_id):
                await asyncio.sleep(0.01)
            while not remote_transport._sessions.get(local.peer_id):
                await asyncio.sleep(0.01)

        self.assertNotIn(CAP_DIRECT_ROUTE_RECOVERY, local_transport.get_capabilities(remote.peer_id))
        local_transport.expect_peer(remote.peer_id, remote_endpoint)
        remote_transport.expect_peer(local.peer_id, local_endpoint)
        await asyncio.sleep(0.05)

        self.assertNotIn(remote.peer_id, local_transport._attempts)
        self.assertNotIn(local.peer_id, remote_transport._attempts)
        self.assertTrue(local_transport._sessions[remote.peer_id].via_relay)
        self.assertTrue(remote_transport._sessions[local.peer_id].via_relay)
        remote_attempt = Attempt(local.peer_id, local_endpoint)
        local_transport.datagram_received(
            remote_transport._make_hello(remote_attempt), remote_endpoint
        )
        self.assertNotIn(
            (remote_endpoint, False), local_transport._pending_sessions.get(remote.peer_id, {})
        )
        await local_transport.stop()
        await remote_transport.stop()

    async def test_direct_udp_replaces_derp_without_disconnect(self):
        """Verify seamless direct UDP route recovery from DERP relay without connection loss."""
        local = Identity.generate("Local")
        remote = Identity.generate("Remote")
        local_endpoint = ("127.0.0.1", 45001)
        remote_endpoint = ("127.0.0.1", 45002)
        connected = {local.peer_id: [], remote.peer_id: []}
        disconnected = []
        received = asyncio.Queue()

        async def on_local_connected(*args):
            connected[local.peer_id].append(args)

        async def on_remote_connected(*args):
            connected[remote.peer_id].append(args)

        async def on_disconnected(peer_id, session_id):
            disconnected.append((peer_id, session_id))

        async def on_local_packet(peer_id, packet):
            await received.put((peer_id, packet))

        async def ignore(*_):
            pass

        local_transport = UdpTransport(local, on_local_connected, on_local_packet, on_disconnected)
        remote_transport = UdpTransport(remote, on_remote_connected, ignore, on_disconnected)

        async def send_from_local(peer_id, data):
            self.assertEqual(peer_id, remote.peer_id)
            remote_transport.derp_datagram_received(local.peer_id, data)

        async def send_from_remote(peer_id, data):
            self.assertEqual(peer_id, local.peer_id)
            local_transport.derp_datagram_received(remote.peer_id, data)

        class DirectSocket:
            def __init__(self, owner, peer, source):
                self.owner = owner
                self.peer = peer
                self.source = source

            def sendto(self, data, endpoint):
                expected = remote_endpoint if self.owner is local_transport else local_endpoint
                if endpoint != expected:
                    raise AssertionError(endpoint)
                asyncio.get_running_loop().call_soon(
                    self.peer.datagram_received, data, self.source
                )

            def close(self):
                pass

        local_transport._transport = DirectSocket(local_transport, remote_transport, local_endpoint)
        remote_transport._transport = DirectSocket(remote_transport, local_transport, remote_endpoint)
        local_transport.configure_derp(send_from_local)
        remote_transport.configure_derp(send_from_remote)
        local_transport.expect_derp_peer(remote.peer_id)
        remote_transport.expect_derp_peer(local.peer_id)

        async with asyncio.timeout(2):
            while not local_transport._sessions.get(remote.peer_id):
                await asyncio.sleep(0.01)
            while not remote_transport._sessions.get(local.peer_id):
                await asyncio.sleep(0.01)

        self.assertTrue(local_transport._sessions[remote.peer_id].via_relay)
        self.assertTrue(remote_transport._sessions[local.peer_id].via_relay)

        local_transport.expect_peer(remote.peer_id, remote_endpoint)
        remote_transport.expect_peer(local.peer_id, local_endpoint)

        async with asyncio.timeout(2):
            while local_transport._sessions[remote.peer_id].via_relay:
                await asyncio.sleep(0.01)
            while remote_transport._sessions[local.peer_id].via_relay:
                await asyncio.sleep(0.01)

        await asyncio.sleep(0.05)
        self.assertFalse(disconnected)
        self.assertFalse(local_transport._sessions[remote.peer_id].via_relay)
        self.assertFalse(remote_transport._sessions[local.peer_id].via_relay)
        self.assertTrue(any(not args[6] for args in connected[local.peer_id]))
        self.assertTrue(any(not args[6] for args in connected[remote.peer_id]))
        await remote_transport.send_packet(local.peer_id, Packet(PacketType.MESSAGE, b"after handoff"))
        peer_id, packet = await asyncio.wait_for(received.get(), 1)
        self.assertEqual(peer_id, remote.peer_id)
        self.assertEqual(packet.payload, b"after handoff")
        await local_transport.stop()
        await remote_transport.stop()

    async def test_two_derp_only_peers_connect(self):
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

        local_transport = UdpTransport(local, on_local_connected, ignore, ignore, force_relay=True)
        remote_transport = UdpTransport(remote, on_remote_connected, ignore, ignore, force_relay=True)

        async def send_from_local(peer_id, data):
            self.assertEqual(peer_id, remote.peer_id)
            remote_transport.derp_datagram_received(local.peer_id, data)

        async def send_from_remote(peer_id, data):
            self.assertEqual(peer_id, local.peer_id)
            local_transport.derp_datagram_received(remote.peer_id, data)

        local_transport.configure_derp(send_from_local)
        remote_transport.configure_derp(send_from_remote)
        local_transport.expect_derp_peer(remote.peer_id)
        remote_transport.expect_derp_peer(local.peer_id)

        async with asyncio.timeout(2):
            await asyncio.gather(*[event.wait() for event in connected.values()])
        self.assertTrue(local_transport._sessions[remote.peer_id].via_relay)
        self.assertTrue(remote_transport._sessions[local.peer_id].via_relay)
        await local_transport.stop()
        await remote_transport.stop()

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

    async def test_stale_peer_disconnect_does_not_remove_replacement(self):
        """Verify that disconnecting a stale session does not remove its active replacement."""
        manager = PeerManager(Identity.generate("Local"), object(), lambda *_: None, tcp_port=0)
        old = PeerConnection("peer", "derp:peer", 0, PeerState.CONNECTED, "remote_derp")
        replacement = PeerConnection("peer", "127.0.0.1", 45002, PeerState.CONNECTED, "remote_udp")
        old.udp_session_id = b"old-session"
        replacement.udp_session_id = b"replacement-session"
        manager._udp_peers["peer"] = replacement
        manager.peers["peer"] = replacement

        await manager._on_udp_disconnected("peer", old.udp_session_id)

        self.assertIs(manager._udp_peers["peer"], replacement)
        self.assertIs(manager.peers["peer"], replacement)

    async def test_stale_goodbye_does_not_remove_replacement(self):
        """Verify that a GOODBYE from a stale session does not remove the replacement connection."""
        manager = PeerManager(Identity.generate("Local"), object(), lambda *_: None, tcp_port=0)
        old = PeerConnection("peer", "derp:peer", 0, PeerState.CONNECTED, "remote_derp")
        replacement = PeerConnection("peer", "127.0.0.1", 45002, PeerState.CONNECTED, "remote_udp")
        old.udp_session_id = b"old-session"
        replacement.udp_session_id = b"replacement-session"
        manager._udp_peers["peer"] = old
        manager.peers["peer"] = old

        async def disconnect(peer_id, expected_session_id=None):
            self.assertIs(peer_id, old.peer_id)
            self.assertEqual(expected_session_id, old.udp_session_id)
            manager._udp_peers[peer_id] = replacement
            manager.peers[peer_id] = replacement
            await PeerManager._on_udp_disconnected(manager, peer_id, expected_session_id)

        manager._on_udp_disconnected = disconnect
        await manager._on_udp_packet("peer", Packet(PacketType.GOODBYE))

        self.assertIs(manager._udp_peers["peer"], replacement)
        self.assertIs(manager.peers["peer"], replacement)

    async def test_udp_disconnect_callback_includes_session_id(self):
        """Verify that UDP disconnect callbacks identify the disconnected session."""
        disconnected = []

        async def on_disconnected(peer_id, session_id):
            disconnected.append((peer_id, session_id))

        async def ignore(*_):
            pass

        transport = UdpTransport(Identity.generate("Local"), ignore, ignore, on_disconnected)
        session = Session(
            peer_id="peer",
            endpoint=("127.0.0.1", 45002),
            via_relay=False,
            session_id=b"session1",
            transmit_encryption_key=b"t" * 32,
            receive_encryption_key=b"r" * 32,
            transmit_authentication_key=b"a" * 32,
            receive_authentication_key=b"b" * 32,
            display_name="Peer",
            encryption_public_key=b"e" * 32,
            signing_public_key=b"s" * 32,
            local_hello=b"",
            remote_nonce=b"n" * 32,
            remote_session_public_key=b"p" * 32,
            confirmed=True,
        )
        transport._sessions[session.peer_id] = session
        transport._sessions_by_id[session.session_id] = session
        header = AUTH_HEADER.pack(MAGIC, GOODBYE, session.session_id, 0)

        transport._handle_keepalive(
            header + hmac.digest(session.receive_authentication_key, header, "sha256")[:16],
            session.endpoint,
            session.via_relay,
        )
        await asyncio.sleep(0)

        self.assertEqual(disconnected, [(session.peer_id, session.session_id)])

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
            force_relay = False

            def expect_peer(self, peer_id, endpoint):
                calls.append(("direct", peer_id, endpoint))

            def clear_direct_candidate(self, peer_id):
                calls.append(("clear", peer_id))

            def expect_derp_peer(self, peer_id):
                calls.append(("derp", peer_id))

        async def record_candidate(peer_id, endpoint):
            calls.append(("record", peer_id, endpoint))

        with tempfile.TemporaryDirectory() as temporary:
            settings = Settings(Path(temporary) / "settings.json")
            room = settings.create_room()
            rendezvous = RendezvousService(local, settings, FakeUdp(), record_candidate, allow_loopback=True)
            await rendezvous._handle_card(room, encrypt_endpoint_card(remote, room, ("127.0.0.1", 12345)))
            await rendezvous._handle_card(room, encrypt_endpoint_card(remote, room, None))

        self.assertIn(("clear", remote.peer_id), calls)
        self.assertIn(("derp", remote.peer_id), calls)
