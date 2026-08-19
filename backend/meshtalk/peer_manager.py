"""Authenticated LAN TCP and NAT-traversed UDP peer connections."""

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
from .protocol import (
    HEADER_SIZE,
    CAP_PROFILE_SYNC,
    HandshakePayload,
    Packet,
    PacketType,
    ProfilePayload,
    TCP_PORT,
    PROTOCOL_VERSION,
    MIN_SUPPORTED_PROTOCOL_VERSION,
    DEFAULT_CAPABILITIES,
    IncompatibleProtocolError,
    intersect_capabilities,
    negotiate_protocol_version,
)
from .udp_transport import Endpoint, UdpTransport

logger = logging.getLogger(__name__)
HANDSHAKE_TIMEOUT = 10
MAX_KNOWN_PEERS = 512
MAX_CONNECTED_PEERS = 256
MAX_PENDING_HANDSHAKES = 64


def _key_fingerprint(key: bytes) -> str:
    return hashlib.sha256(key).hexdigest()[:16]


def _format_endpoint(endpoint: Endpoint) -> str:
    host, port = endpoint
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


class PeerState(enum.Enum):
    UNKNOWN = "unknown"
    DISCOVERED = "discovered"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    DISCONNECTED = "disconnected"


class PeerConnection:
    def __init__(
        self,
        peer_id: str,
        address: str,
        port: int,
        state: PeerState = PeerState.DISCOVERED,
        transport: str = "lan_tcp",
    ) -> None:
        self.peer_id, self.address, self.port, self.state = peer_id, address, port, state
        self.transport = transport
        self.tcp_port = port
        self.reader: asyncio.StreamReader | None = None
        self.writer: asyncio.StreamWriter | None = None
        self.display_name = "Anonymous"
        self.tui_active = False
        self.signing_public_key: bytes | None = None
        self.encryption_public_key: bytes | None = None
        self.protocol_version: int = PROTOCOL_VERSION
        self.remote_protocol_version: int = PROTOCOL_VERSION
        self.remote_min_protocol_version: int = MIN_SUPPORTED_PROTOCOL_VERSION
        self.capabilities: list[str] = list(DEFAULT_CAPABILITIES)
        self.last_seen = time.time()

    @property
    def endpoint(self) -> Endpoint:
        return self.address, self.port

    def supports(self, capability: str) -> bool:
        """Whether the negotiated connection with this peer enables ``capability``."""
        return capability in self.capabilities

    @property
    def version_mismatch(self) -> dict | None:
        """Return incompatibility info for this peer, or ``None`` if compatible.

        Legacy peers (``remote_protocol_version == -1``) have no version
        information, so their compatibility cannot be determined and is treated
        as unknown (not a mismatch).
        """
        if self.remote_protocol_version == -1:
            return None
        agreed = negotiate_protocol_version(
            PROTOCOL_VERSION,
            MIN_SUPPORTED_PROTOCOL_VERSION,
            self.remote_protocol_version,
            self.remote_min_protocol_version,
        )
        if agreed is not None:
            return None
        return {
            "remote_version": self.remote_protocol_version,
            "remote_min": self.remote_min_protocol_version,
            "local_version": PROTOCOL_VERSION,
            "local_min": MIN_SUPPORTED_PROTOCOL_VERSION,
        }

    def negotiated(self) -> dict:
        """Snapshot of the negotiated protocol state for IPC/debug consumers."""
        return {
            "protocol_version": self.protocol_version,
            "remote_protocol_version": self.remote_protocol_version,
            "remote_min_protocol_version": self.remote_min_protocol_version,
            "min_protocol_version": MIN_SUPPORTED_PROTOCOL_VERSION,
            "version_mismatch": self.version_mismatch,
            "capabilities": list(self.capabilities),
        }


class PeerManager:
    def __init__(
        self,
        identity: Identity,
        db: Database,
        on_packet: Callable[[PeerConnection, Packet], Awaitable[None]],
        tcp_port: int = TCP_PORT,
    ) -> None:
        self.identity, self.db, self.on_packet, self.tcp_port = identity, db, on_packet, tcp_port
        self.peers: dict[str, PeerConnection] = {}
        self._udp_peers: dict[str, PeerConnection] = {}
        self._known_endpoints: dict[str, dict[str, Endpoint]] = {}
        self._connecting: set[str] = set()
        self._server: asyncio.Server | None = None
        self._running = False
        self.tui_active = False
        self._receive_tasks: set[asyncio.Task] = set()
        self._incoming_handshakes = 0
        self.on_peer_changed: Callable[[str], Awaitable[None]] | None = None
        self.on_version_mismatch: Callable[[str, int, int], Awaitable[None]] | None = None
        self.udp = UdpTransport(
            identity, self._on_udp_connected, self._on_udp_packet, self._on_udp_disconnected
        )
        self.udp.on_version_mismatch = self._handle_udp_version_mismatch

    def _handle_udp_version_mismatch(self, peer_id: str, remote_version: int, remote_min: int) -> None:
        if self.on_version_mismatch is not None:
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(self.on_version_mismatch(peer_id, remote_version, remote_min))
            except RuntimeError:
                pass

    async def start(self) -> None:
        self._running = True
        self._server = await asyncio.start_server(self._handle_incoming, "0.0.0.0", self.tcp_port)
        await self.udp.start()
        logger.info("LAN TCP server listening on port %d", self.tcp_port)

    async def stop(self) -> None:
        self._running = False
        await self.udp.stop()
        writers = {
            peer.writer for peer in [*self.peers.values(), *self._udp_peers.values()] if peer.writer
        }
        for writer in writers:
            writer.close()
        if writers:
            await asyncio.gather(*(writer.wait_closed() for writer in writers), return_exceptions=True)
        if self._receive_tasks:
            await asyncio.gather(*self._receive_tasks, return_exceptions=True)
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    def _should_initiate(self, remote_peer_id: str) -> bool:
        return self.identity.peer_id < remote_peer_id

    async def _notify_peer_changed(self, peer_id: str) -> None:
        if self.on_peer_changed is not None:
            try:
                await self.on_peer_changed(peer_id)
            except Exception:
                logger.exception("on_peer_changed callback failed")

    def record_lan_candidate(self, peer_id: str, address: str, tcp_port: int) -> None:
        if peer_id not in self._known_endpoints and len(self._known_endpoints) >= MAX_KNOWN_PEERS:
            return
        old = self._known_endpoints.get(peer_id, {}).get("lan_tcp")
        new = (address, tcp_port)
        self._known_endpoints.setdefault(peer_id, {})["lan_tcp"] = new
        if old != new:
            logger.info("LAN endpoint changed for %s: %s -> %s", peer_id, old, new)
        asyncio.ensure_future(self.db.save_peer_endpoint(peer_id, "lan_tcp", new))

    async def record_remote_candidate(self, peer_id: str, endpoint: Endpoint) -> None:
        if peer_id not in self._known_endpoints and len(self._known_endpoints) >= MAX_KNOWN_PEERS:
            raise ValueError("Too many known peers")
        old = self._known_endpoints.get(peer_id, {}).get("remote_udp")
        self._known_endpoints.setdefault(peer_id, {})["remote_udp"] = endpoint
        if old != endpoint:
            logger.info("Remote UDP endpoint changed for %s: %s -> %s", peer_id, old, _format_endpoint(endpoint))
        await self.db.save_peer_endpoint(peer_id, "remote_udp", endpoint)

    async def load_endpoints(self) -> None:
        saved = await self.db.load_peer_endpoints()
        for peer_id, endpoints in saved.items():
            if peer_id not in self._known_endpoints:
                self._known_endpoints[peer_id] = {}
            self._known_endpoints[peer_id].update(endpoints)

    async def connect_to_peer(self, peer_id: str | None, address: str, tcp_port: int) -> None:
        if peer_id:
            self.record_lan_candidate(peer_id, address, tcp_port)
        connection_key = peer_id or f"{address}:{tcp_port}"
        existing = self.peers.get(peer_id) if peer_id else None
        if connection_key in self._connecting or existing and existing.state == PeerState.CONNECTED and existing.transport == "lan_tcp":
            return
        if peer_id and not self._should_initiate(peer_id):
            return
        if peer_id and peer_id not in self.peers and len(self.peers) >= MAX_CONNECTED_PEERS:
            logger.warning("Rejecting LAN connection to %s: peer limit reached", peer_id)
            return
        self._connecting.add(connection_key)
        peer = PeerConnection(peer_id or "", address, tcp_port, PeerState.CONNECTING)
        try:
            peer.reader, peer.writer = await asyncio.open_connection(address, tcp_port)
            await asyncio.wait_for(self._outbound_handshake(peer), HANDSHAKE_TIMEOUT)
            if not self._should_initiate(peer.peer_id):
                # Discovery identifiers are anonymous, so both peers may dial.
                # Once authenticated, retain the deterministic lower-ID direction.
                peer.writer.close()
                return
            old = self.peers.get(peer.peer_id)
            if old and old.state == PeerState.CONNECTED and old.transport == "lan_tcp":
                peer.writer.close()
                return
            if peer.peer_id not in self.peers and len(self.peers) >= MAX_CONNECTED_PEERS:
                raise ValueError("Connected peer limit reached")
            peer.state = PeerState.CONNECTED
            self.peers[peer.peer_id] = peer
            self.record_lan_candidate(peer.peer_id, address, tcp_port)
            await self.db.upsert_peer(peer.peer_id, peer.display_name, peer.encryption_public_key, peer.signing_public_key)
            self._start_receive_loop(peer)
            await self._send_profile_update(peer)
            await self._notify_peer_changed(peer.peer_id)
            logger.info("Authenticated LAN connection to %s at %s", peer.peer_id, _format_endpoint(peer.endpoint))
        except Exception as exc:
            peer.state = PeerState.DISCONNECTED
            if peer.writer:
                peer.writer.close()
            logger.warning("LAN connection to %s failed: %s", peer_id or address, exc)
        finally:
            self._connecting.discard(connection_key)

    async def _handle_incoming(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if self._incoming_handshakes >= MAX_PENDING_HANDSHAKES:
            writer.close()
            return
        self._incoming_handshakes += 1
        address, port = writer.get_extra_info("peername")[:2]
        peer = PeerConnection("", str(address), int(port), PeerState.CONNECTING)
        peer.reader, peer.writer = reader, writer
        try:
            await asyncio.wait_for(self._inbound_handshake(peer), HANDSHAKE_TIMEOUT)
            peer.state = PeerState.CONNECTED
            old = self.peers.get(peer.peer_id)
            if old and old.state == PeerState.CONNECTED and old.transport == "lan_tcp":
                writer.close()
                return
            if peer.peer_id not in self.peers and len(self.peers) >= MAX_CONNECTED_PEERS:
                raise ValueError("Connected peer limit reached")
            self.peers[peer.peer_id] = peer
            await self.db.upsert_peer(peer.peer_id, peer.display_name, peer.encryption_public_key, peer.signing_public_key)
            self._start_receive_loop(peer)
            await self._send_profile_update(peer)
            await self._notify_peer_changed(peer.peer_id)
            logger.info("Authenticated incoming LAN connection from %s", peer.peer_id)
        except Exception as exc:
            logger.warning("Rejected incoming LAN connection from %s: %s", address, exc)
            writer.close()
        finally:
            self._incoming_handshakes -= 1

    async def _on_udp_connected(
        self,
        peer_id: str,
        address: str,
        port: int,
        display_name: str,
        encryption_public_key: bytes,
        signing_public_key: bytes,
    ) -> None:
        if peer_id not in self.peers and len(self.peers) >= MAX_CONNECTED_PEERS:
            logger.warning("Rejecting remote UDP peer %s: peer limit reached", peer_id)
            return
        old = self._udp_peers.get(peer_id)
        old_endpoint = old.endpoint if old else None
        peer = PeerConnection(peer_id, address, port, PeerState.CONNECTED, "remote_udp")
        peer.display_name = display_name
        peer.encryption_public_key = encryption_public_key
        peer.signing_public_key = signing_public_key
        self._udp_peers[peer_id] = peer
        self._known_endpoints.setdefault(peer_id, {})["remote_udp"] = peer.endpoint
        active = self.peers.get(peer_id)
        if not active or active.state != PeerState.CONNECTED or active.transport != "lan_tcp":
            self.peers[peer_id] = peer
        await self.db.upsert_peer(peer_id, display_name, encryption_public_key, signing_public_key)
        await self._send_profile_update(peer)
        await self._notify_peer_changed(peer_id)
        if old_endpoint and old_endpoint != peer.endpoint:
            logger.info("Remote UDP endpoint changed for %s: %s -> %s", peer_id, _format_endpoint(old_endpoint), _format_endpoint(peer.endpoint))
        else:
            logger.info("Authenticated remote UDP connection to %s at %s", peer_id, _format_endpoint(peer.endpoint))

    async def _on_udp_packet(self, peer_id: str, packet: Packet) -> None:
        peer = self._udp_peers.get(peer_id)
        if not peer or peer.state != PeerState.CONNECTED:
            return
        peer.last_seen = time.time()
        if packet.type == PacketType.PING:
            await self._send_packet(peer, Packet(PacketType.PONG))
        elif packet.type == PacketType.GOODBYE:
            await self._on_udp_disconnected(peer_id)
        elif packet.type == PacketType.PROFILE:
            await self._apply_profile_update(peer, packet)
        else:
            await self.on_packet(peer, packet)

    async def _on_udp_disconnected(self, peer_id: str) -> None:
        peer = self._udp_peers.pop(peer_id, None)
        if peer:
            peer.state = PeerState.DISCONNECTED
        active = self.peers.get(peer_id)
        if active is peer:
            await self.db.set_peer_online(peer_id, False)
            self.peers.pop(peer_id, None)
        await self._notify_peer_changed(peer_id)

    def _handshake_payload(self, challenge: bytes = b"") -> HandshakePayload:
        payload = HandshakePayload(
            peer_id=self.identity.peer_id,
            signing_public_key=self.identity.signing_public_key_bytes(),
            encryption_public_key=self.identity.encryption_public_key_bytes(),
            display_name=self.identity.display_name,
            nonce=__import__("secrets").token_bytes(32),
            challenge=challenge,
            signature=b"",
        )
        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
        return payload

    def _profile_payload(self) -> ProfilePayload:
        payload = ProfilePayload(self.identity.peer_id, self.identity.display_name, self.tui_active, b"")
        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
        return payload

    async def set_tui_active(self, active: bool) -> None:
        if self.tui_active == active:
            return
        self.tui_active = active
        await self.broadcast_profile_update()

    async def _send_profile_update(self, peer: PeerConnection) -> None:
        # Presence/display-name synchronisation is opt-in per negotiated capabilities.
        if not peer.supports(CAP_PROFILE_SYNC):
            return
        await self._send_packet(peer, Packet(PacketType.PROFILE, self._profile_payload().encode()))

    async def broadcast_profile_update(self) -> None:
        """Share a signed name change through every active peer path."""
        packet = Packet(PacketType.PROFILE, self._profile_payload().encode())
        sent: set[tuple[str, str]] = set()
        for peer in [*self.get_connected_peers(), *self._udp_peers.values()]:
            key = peer.peer_id, peer.transport
            if key in sent or peer.state != PeerState.CONNECTED:
                continue
            if not peer.supports(CAP_PROFILE_SYNC):
                continue
            sent.add(key)
            try:
                await self._send_packet(peer, packet)
            except ConnectionError:
                logger.warning("Could not send profile update to %s", peer.peer_id)

    async def _outbound_handshake(self, peer: PeerConnection) -> None:
        logger.debug("Starting authenticated LAN key exchange with %s at %s:%d", peer.peer_id, peer.address, peer.port)
        initial = self._handshake_payload()
        await self._send_packet(peer, Packet(PacketType.HANDSHAKE, initial.encode()))
        packet = await self._recv_packet(peer)
        if packet is None or packet.type != PacketType.HANDSHAKE_ACK:
            raise ValueError("Expected handshake acknowledgement")
        acknowledgement = HandshakePayload.decode(packet.payload)
        self._apply_handshake(
            peer, acknowledgement, expected_peer_id=peer.peer_id or None, expected_challenge=initial.nonce
        )
        confirmation = self._handshake_payload(acknowledgement.nonce)
        await self._send_packet(peer, Packet(PacketType.HANDSHAKE_CONFIRM, confirmation.encode()))

    async def _inbound_handshake(self, peer: PeerConnection) -> None:
        logger.debug("Waiting for authenticated LAN key exchange from %s:%d", peer.address, peer.port)
        packet = await self._recv_packet(peer)
        if packet is None or packet.type != PacketType.HANDSHAKE:
            raise ValueError("Expected handshake")
        initial = HandshakePayload.decode(packet.payload)
        self._apply_handshake(peer, initial, expected_challenge=b"")
        acknowledgement = self._handshake_payload(initial.nonce)
        await self._send_packet(peer, Packet(PacketType.HANDSHAKE_ACK, acknowledgement.encode()))
        packet = await self._recv_packet(peer)
        if packet is None or packet.type != PacketType.HANDSHAKE_CONFIRM:
            raise ValueError("Expected handshake confirmation")
        self._apply_handshake(
            peer,
            HandshakePayload.decode(packet.payload),
            expected_peer_id=peer.peer_id,
            expected_challenge=acknowledgement.nonce,
        )

    def _apply_handshake(
        self,
        peer: PeerConnection,
        payload: HandshakePayload,
        expected_peer_id: str | None = None,
        expected_challenge: bytes | None = None,
    ) -> None:
        peer_id = hashlib.sha256(payload.signing_public_key).hexdigest()
        if payload.peer_id != peer_id or expected_peer_id and peer_id != expected_peer_id:
            raise ValueError("Handshake peer ID does not match signing key")
        if expected_challenge is not None and payload.challenge != expected_challenge:
            raise ValueError("Handshake challenge mismatch")
        agreed_version = negotiate_protocol_version(
            PROTOCOL_VERSION,
            MIN_SUPPORTED_PROTOCOL_VERSION,
            payload.protocol_version,
            payload.min_protocol_version,
        )
        if agreed_version is None:
            logger.warning("Incompatible protocol version with peer %s (remote v%d, min v%d); features may not work properly", peer_id, payload.protocol_version, payload.min_protocol_version)
            if self.on_version_mismatch is not None:
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(self.on_version_mismatch(peer_id, payload.protocol_version, payload.min_protocol_version))
                except RuntimeError:
                    pass
            agreed_version = MIN_SUPPORTED_PROTOCOL_VERSION
        try:
            Ed25519PublicKey.from_public_bytes(payload.signing_public_key).verify(payload.signature, payload.signed_bytes())
        except InvalidSignature:
            try:
                Ed25519PublicKey.from_public_bytes(payload.signing_public_key).verify(payload.signature, payload.signed_bytes(legacy=True))
            except InvalidSignature as exc:
                raise ValueError("Invalid handshake signature") from exc
        peer.peer_id = peer_id
        peer.display_name = Identity.normalize_display_name(payload.display_name)
        peer.signing_public_key = payload.signing_public_key
        peer.encryption_public_key = payload.encryption_public_key
        peer.protocol_version = agreed_version
        # Legacy peers (no version fields in handshake) are represented as -1
        # internally but displayed as v0 in the TUI.
        peer.remote_protocol_version = -1 if payload.legacy else payload.protocol_version
        peer.remote_min_protocol_version = payload.min_protocol_version
        # The connection only enables capabilities advertised by *both* peers.
        peer.capabilities = intersect_capabilities(DEFAULT_CAPABILITIES, payload.capabilities)
        logger.debug(
            "Authenticated key exchange with %s: signing=%s encryption=%s version=v%d caps=%s",
            peer.peer_id,
            _key_fingerprint(peer.signing_public_key),
            _key_fingerprint(peer.encryption_public_key),
            peer.protocol_version,
            ",".join(peer.capabilities),
        )

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
                elif packet.type == PacketType.PROFILE:
                    await self._apply_profile_update(peer, packet)
                else:
                    await self.on_packet(peer, packet)
        finally:
            peer.state = PeerState.DISCONNECTED
            if peer.peer_id and self.peers.get(peer.peer_id) is peer:
                remote = self._udp_peers.get(peer.peer_id)
                if remote and remote.state == PeerState.CONNECTED:
                    self.peers[peer.peer_id] = remote
                else:
                    await self.db.set_peer_online(peer.peer_id, False)
                    self.peers.pop(peer.peer_id, None)
                await self._notify_peer_changed(peer.peer_id)
            if peer.writer:
                peer.writer.close()

    async def _apply_profile_update(self, peer: PeerConnection, packet: Packet) -> None:
        if peer.signing_public_key is None or peer.encryption_public_key is None:
            raise ValueError("Profile update received before authentication")
        payload = ProfilePayload.decode(packet.payload)
        if payload.peer_id != peer.peer_id:
            raise ValueError("Profile update peer ID does not match connection")
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(
                payload.signature, payload.signed_bytes()
            )
        except InvalidSignature as exc:
            raise ValueError("Invalid profile signature") from exc
        peer.display_name = Identity.normalize_display_name(payload.display_name)
        peer.tui_active = payload.tui_active
        active = self.peers.get(peer.peer_id)
        if active:
            active.display_name = peer.display_name
            active.tui_active = peer.tui_active
        await self.db.upsert_peer(
            peer.peer_id, peer.display_name, peer.encryption_public_key, peer.signing_public_key, peer.tui_active
        )
        await self._notify_peer_changed(peer.peer_id)

    async def send_packet(self, peer: PeerConnection, packet: Packet) -> None:
        try:
            await self._send_packet(peer, packet)
        except ConnectionError:
            if peer.transport == "remote_udp":
                await self._on_udp_disconnected(peer.peer_id)
            raise

    async def _send_packet(self, peer: PeerConnection, packet: Packet) -> None:
        if peer.transport == "remote_udp":
            await self.udp.send_packet(peer.peer_id, packet)
            return
        if peer.writer is None:
            raise ConnectionError("Peer is not connected")
        try:
            peer.writer.write(packet.encode())
            await peer.writer.drain()
        except (ConnectionError, OSError):
            peer.state = PeerState.DISCONNECTED
            remote = self._udp_peers.get(peer.peer_id)
            if not remote or remote.state != PeerState.CONNECTED:
                raise
            self.peers[peer.peer_id] = remote
            await self.udp.send_packet(peer.peer_id, packet)

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

    def get_network_info(self, peer_id: str) -> dict:
        active = self.get_connected_peer(peer_id)
        known = list(self._known_endpoints.get(peer_id, {}).items())
        active_endpoint = active.endpoint if active else None
        if active and active.transport == "lan_tcp":
            advertised = self._known_endpoints.get(peer_id, {}).get("lan_tcp")
            # Prefer the advertised LAN candidate, but fall back to the active
            # connection address so peers always have a visible endpoint.
            if advertised and advertised[0] == active.address:
                active_endpoint = advertised
            elif active_endpoint is None:
                active_endpoint = active.endpoint
        if active and active_endpoint and (active.transport, active_endpoint) not in known:
            known.append((active.transport, active_endpoint))
        endpoints = [
            {
                "transport": transport,
                "endpoint": _format_endpoint(endpoint),
                "active": bool(active and active.transport == transport and active_endpoint == endpoint),
            }
            for transport, endpoint in sorted(known)
        ]
        return {
            "active_transport": active.transport if active else None,
            "active_endpoint": _format_endpoint(active_endpoint) if active_endpoint else None,
            "endpoints": endpoints,
        }
