"""Authenticated TCP peer connections for direct messaging."""

from __future__ import annotations

import asyncio
import enum
import hashlib
import logging
import time
from typing import Awaitable, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .database import Database
from .identity import Identity
from .protocol import HEADER_SIZE, HandshakePayload, Packet, PacketType, TCP_PORT

logger = logging.getLogger(__name__)
HANDSHAKE_TIMEOUT = 10


class PeerState(enum.Enum):
    UNKNOWN = "unknown"
    DISCOVERED = "discovered"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    DISCONNECTED = "disconnected"


class PeerConnection:
    def __init__(self, peer_id: str, address: str, tcp_port: int, state: PeerState = PeerState.DISCOVERED) -> None:
        self.peer_id, self.address, self.tcp_port, self.state = peer_id, address, tcp_port, state
        self.reader: asyncio.StreamReader | None = None
        self.writer: asyncio.StreamWriter | None = None
        self.display_name = "Anonymous"
        self.signing_public_key: bytes | None = None
        self.encryption_public_key: bytes | None = None
        self.last_seen = time.time()


class PeerManager:
    def __init__(self, identity: Identity, db: Database, on_packet: Callable[[PeerConnection, Packet], Awaitable[None]], tcp_port: int = TCP_PORT) -> None:
        self.identity, self.db, self.on_packet, self.tcp_port = identity, db, on_packet, tcp_port
        self.peers: dict[str, PeerConnection] = {}
        self._server: asyncio.Server | None = None
        self._running = False
        self._receive_tasks: set[asyncio.Task] = set()

    async def start(self) -> None:
        self._running = True
        self._server = await asyncio.start_server(self._handle_incoming, "0.0.0.0", self.tcp_port)
        logger.info("TCP server listening on port %d", self.tcp_port)

    async def stop(self) -> None:
        self._running = False
        for peer in list(self.peers.values()):
            if peer.writer:
                peer.writer.close()
                await peer.writer.wait_closed()
        if self._receive_tasks:
            await asyncio.gather(*self._receive_tasks, return_exceptions=True)
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    def _should_initiate(self, remote_peer_id: str) -> bool:
        return self.identity.peer_id < remote_peer_id

    async def connect_to_peer(self, peer_id: str, address: str, tcp_port: int) -> None:
        existing = self.peers.get(peer_id)
        if existing and existing.state in (PeerState.CONNECTING, PeerState.CONNECTED):
            return
        if not self._should_initiate(peer_id):
            return
        peer = PeerConnection(peer_id, address, tcp_port, PeerState.CONNECTING)
        self.peers[peer_id] = peer
        try:
            peer.reader, peer.writer = await asyncio.open_connection(address, tcp_port)
            await asyncio.wait_for(self._outbound_handshake(peer), HANDSHAKE_TIMEOUT)
            peer.state = PeerState.CONNECTED
            await self.db.upsert_peer(peer.peer_id, peer.display_name, peer.encryption_public_key, peer.signing_public_key)
            self._start_receive_loop(peer)
            logger.info("Authenticated connection to %s", peer.peer_id)
        except Exception as exc:
            peer.state = PeerState.DISCONNECTED
            if peer.writer:
                peer.writer.close()
            logger.warning("Connection to %s failed: %s", peer_id, exc)

    async def _handle_incoming(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        address, port = writer.get_extra_info("peername")[:2]
        peer = PeerConnection("", address, port, PeerState.CONNECTING)
        peer.reader, peer.writer = reader, writer
        try:
            await asyncio.wait_for(self._inbound_handshake(peer), HANDSHAKE_TIMEOUT)
            peer.state = PeerState.CONNECTED
            old = self.peers.get(peer.peer_id)
            if old and old.state == PeerState.CONNECTED:
                writer.close()
                return
            self.peers[peer.peer_id] = peer
            await self.db.upsert_peer(peer.peer_id, peer.display_name, peer.encryption_public_key, peer.signing_public_key)
            self._start_receive_loop(peer)
            logger.info("Authenticated incoming connection from %s", peer.peer_id)
        except Exception as exc:
            logger.warning("Rejected incoming connection from %s: %s", address, exc)
            writer.close()

    def _handshake_payload(self) -> HandshakePayload:
        payload = HandshakePayload(
            peer_id=self.identity.peer_id,
            signing_public_key=self.identity.signing_public_key_bytes(),
            encryption_public_key=self.identity.encryption_public_key_bytes(),
            display_name=self.identity.display_name,
            nonce=__import__("secrets").token_bytes(32),
            signature=b"",
        )
        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
        return payload

    async def _outbound_handshake(self, peer: PeerConnection) -> None:
        await self._send_packet(peer, Packet(PacketType.HANDSHAKE, self._handshake_payload().encode()))
        packet = await self._recv_packet(peer)
        if packet is None or packet.type != PacketType.HANDSHAKE_ACK:
            raise ValueError("Expected handshake acknowledgement")
        self._apply_handshake(peer, HandshakePayload.decode(packet.payload), expected_peer_id=peer.peer_id)

    async def _inbound_handshake(self, peer: PeerConnection) -> None:
        packet = await self._recv_packet(peer)
        if packet is None or packet.type != PacketType.HANDSHAKE:
            raise ValueError("Expected handshake")
        self._apply_handshake(peer, HandshakePayload.decode(packet.payload))
        await self._send_packet(peer, Packet(PacketType.HANDSHAKE_ACK, self._handshake_payload().encode()))

    def _apply_handshake(self, peer: PeerConnection, payload: HandshakePayload, expected_peer_id: str | None = None) -> None:
        peer_id = hashlib.sha256(payload.signing_public_key).hexdigest()
        if payload.peer_id != peer_id or (expected_peer_id and peer_id != expected_peer_id):
            raise ValueError("Handshake peer ID does not match signing key")
        try:
            Ed25519PublicKey.from_public_bytes(payload.signing_public_key).verify(payload.signature, payload.signed_bytes())
        except InvalidSignature as exc:
            raise ValueError("Invalid handshake signature") from exc
        peer.peer_id = peer_id
        peer.display_name = payload.display_name
        peer.signing_public_key = payload.signing_public_key
        peer.encryption_public_key = payload.encryption_public_key

    def _start_receive_loop(self, peer: PeerConnection) -> None:
        task = asyncio.create_task(self._receive_loop(peer))
        self._receive_tasks.add(task)
        task.add_done_callback(self._receive_tasks.discard)

    async def _receive_loop(self, peer: PeerConnection) -> None:
        try:
            while self._running and peer.state == PeerState.CONNECTED:
                packet = await self._recv_packet(peer)
                if packet is None:
                    break
                peer.last_seen = time.time()
                if packet.type == PacketType.PING:
                    await self._send_packet(peer, Packet(PacketType.PONG))
                elif packet.type == PacketType.GOODBYE:
                    break
                else:
                    await self.on_packet(peer, packet)
        finally:
            peer.state = PeerState.DISCONNECTED
            if peer.peer_id:
                await self.db.set_peer_online(peer.peer_id, False)

    async def send_packet(self, peer: PeerConnection, packet: Packet) -> None:
        await self._send_packet(peer, packet)

    async def _send_packet(self, peer: PeerConnection, packet: Packet) -> None:
        if peer.writer is None:
            raise ConnectionError("Peer is not connected")
        peer.writer.write(packet.encode())
        await peer.writer.drain()

    async def _recv_packet(self, peer: PeerConnection) -> Packet | None:
        if peer.reader is None:
            return None
        try:
            header = await peer.reader.readexactly(HEADER_SIZE)
            length, _ = Packet.decode_header(header)
            return Packet.decode(header, await peer.reader.readexactly(length))
        except (asyncio.IncompleteReadError, ConnectionError):
            return None

    def get_connected_peer(self, peer_id: str) -> PeerConnection | None:
        peer = self.peers.get(peer_id)
        return peer if peer and peer.state == PeerState.CONNECTED else None

    def get_connected_peers(self) -> list[PeerConnection]:
        return [peer for peer in self.peers.values() if peer.state == PeerState.CONNECTED]
