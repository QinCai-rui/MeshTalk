import asyncio
import json
import socket
import struct
import tempfile
import unittest
from pathlib import Path

from websockets.asyncio.server import serve

from meshtalk.database import Database
from meshtalk.identity import Identity
from meshtalk.message_router import MessageRouter
from meshtalk.peer_manager import PeerManager
from meshtalk.rendezvous import RendezvousService
from meshtalk.settings import Settings
from meshtalk.udp_transport import STUN_COOKIE


class LocalStunProtocol(asyncio.DatagramProtocol):
    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        if len(data) != 20 or data[:2] != b"\x00\x01":
            return
        transaction_id = data[8:20]
        cookie = struct.pack("!I", STUN_COOKIE)
        address = socket.inet_aton(addr[0])
        encoded_address = bytes(byte ^ cookie[index] for index, byte in enumerate(address))
        value = b"\x00\x01" + struct.pack("!H", addr[1] ^ (STUN_COOKIE >> 16)) + encoded_address
        attribute = struct.pack("!HH", 0x0020, len(value)) + value
        response = struct.pack("!HHI12s", 0x0101, len(attribute), STUN_COOKIE, transaction_id) + attribute
        self.transport.sendto(response, addr)


class LocalOpaqueControl:
    def __init__(self):
        self.rooms = {}
        self.signals = {}

    async def handler(self, websocket):
        joined = set()
        try:
            async for raw in websocket:
                message = json.loads(raw)
                room_id = message["room_id"]
                members = self.rooms.setdefault(room_id, set())
                if message["type"] == "join":
                    for member in members:
                        payload = self.signals.get((member, room_id))
                        if payload:
                            await websocket.send(json.dumps({"type": "signal", "room_id": room_id, "payload": payload}))
                    members.add(websocket)
                    joined.add(room_id)
                    await websocket.send(json.dumps({"type": "joined", "room_id": room_id, "member_count": len(members)}))
                    for member in list(members):
                        await member.send(json.dumps({"type": "refresh", "room_id": room_id, "member_count": len(members)}))
                elif message["type"] == "signal" and room_id in joined:
                    self.signals[(websocket, room_id)] = message["payload"]
                    for member in list(members):
                        if member is not websocket:
                            await member.send(json.dumps(message))
        finally:
            for room_id in joined:
                self.rooms[room_id].discard(websocket)
                self.signals.pop((websocket, room_id), None)


class RendezvousIntegrationTest(unittest.IsolatedAsyncioTestCase):
    async def test_control_and_stun_establish_direct_udp_message_path(self):
        loop = asyncio.get_running_loop()
        stun_transport, _ = await loop.create_datagram_endpoint(
            LocalStunProtocol, local_addr=("127.0.0.1", 0)
        )
        self.addCleanup(stun_transport.close)
        stun_port = stun_transport.get_extra_info("sockname")[1]
        control_impl = LocalOpaqueControl()
        control_server = await serve(control_impl.handler, "127.0.0.1", 0)
        async def close_control():
            control_server.close()
            await control_server.wait_closed()
        self.addAsyncCleanup(close_control)
        control_port = control_server.sockets[0].getsockname()[1]

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            identity_a, identity_b = Identity.generate("Alice"), Identity.generate("Bob")
            db_a, db_b = Database(root / "a.db"), Database(root / "b.db")
            await db_a.connect()
            await db_b.connect()
            manager_a = PeerManager(identity_a, db_a, lambda *_: None, tcp_port=0)
            manager_b = PeerManager(identity_b, db_b, lambda *_: None, tcp_port=0)
            received = asyncio.Queue()
            router_a = MessageRouter(identity_a, manager_a, db_a, received.put)
            router_b = MessageRouter(identity_b, manager_b, db_b, received.put)
            manager_a.on_packet = router_a.handle_packet
            manager_b.on_packet = router_b.handle_packet
            settings_a = Settings(root / "a-settings.json")
            settings_b = Settings(root / "b-settings.json")
            settings_a.set_control_url(f"ws://127.0.0.1:{control_port}")
            settings_b.set_control_url(f"ws://127.0.0.1:{control_port}")
            settings_a._stun_host, settings_a._stun_port = "127.0.0.1", stun_port
            settings_b._stun_host, settings_b._stun_port = "127.0.0.1", stun_port
            room = settings_a.create_room()
            settings_b.join_room(room.invite)
            rendezvous_a = RendezvousService(
                identity_a, settings_a, manager_a.udp, manager_a.record_remote_candidate, allow_loopback=True
            )
            rendezvous_b = RendezvousService(
                identity_b, settings_b, manager_b.udp, manager_b.record_remote_candidate, allow_loopback=True
            )

            await manager_a.start()
            await manager_b.start()
            await rendezvous_a.start()
            await rendezvous_b.start()
            try:
                async with asyncio.timeout(5):
                    while not manager_a.get_connected_peer(identity_b.peer_id):
                        await asyncio.sleep(0.02)
                    while not manager_b.get_connected_peer(identity_a.peer_id):
                        await asyncio.sleep(0.02)
                message_id = await router_a.send_message(identity_b.peer_id, b"rendezvous secret")
                message = await asyncio.wait_for(received.get(), 2)
                self.assertEqual(message["message_id"], message_id)
                self.assertEqual(message["content"], "rendezvous secret")
                self.assertEqual(manager_a.get_network_info(identity_b.peer_id)["active_transport"], "remote_udp")
            finally:
                await rendezvous_a.stop()
                await rendezvous_b.stop()
                await manager_a.stop()
                await manager_b.stop()
                await db_a.close()
                await db_b.close()
