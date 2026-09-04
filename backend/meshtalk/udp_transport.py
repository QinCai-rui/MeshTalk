"""Authenticated reliable UDP transport used for NAT-traversed peer links."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import secrets
import socket
import struct
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .identity import Identity
from .protocol import (
    HEADER_SIZE,
    MAX_PACKET_SIZE,
    DEFAULT_CAPABILITIES,
    Packet,
    intersect_capabilities,
    validate_capabilities,
)
logger = logging.getLogger(__name__)

MAGIC = b"MTU1"
HELLO = 1
DATA = 2
ACK = 3
PING = 4
PONG = 5
READY = 6
GOODBYE = 7
STUN_COOKIE = 0x2112A442
FRAGMENT_SIZE = 950
MAX_FRAGMENTS = (MAX_PACKET_SIZE + HEADER_SIZE + FRAGMENT_SIZE - 1) // FRAGMENT_SIZE
MAX_DATAGRAM_SIZE = 1200
DATA_HEADER = struct.Struct("!4sB8sQHH12s")
AUTH_HEADER = struct.Struct("!4sB8sQ")
RETRY_INTERVAL = 0.45
MAX_RETRIES = 10
SESSION_TIMEOUT = 12.0
DIRECT_PROBE_INTERVAL = 60.0
EXPECTED_PEER_TIMEOUT = 600.0
MAX_EXPECTED_PEERS = 512
MAX_ATTEMPTS = 128
MAX_SESSIONS = 256

Endpoint = tuple[str, int]
ConnectedCallback = Callable[[str, str, int, str, bytes, bytes, bool], Awaitable[None]]
PacketCallback = Callable[[str, Packet], Awaitable[None]]
DisconnectedCallback = Callable[[str], Awaitable[None]]
DerpSender = Callable[[str, bytes], Awaitable[None]]


def _canonical(value: dict) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


def _raw_public(key: X25519PrivateKey) -> bytes:
    return key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


def parse_stun_response(data: bytes, transaction_id: bytes) -> Endpoint:
    """Parse and validate an RFC 5389 binding success response."""
    if len(transaction_id) != 12 or len(data) < 20:
        raise ValueError("Truncated STUN response")
    message_type, length, cookie = struct.unpack("!HHI", data[:8])
    if message_type != 0x0101 or cookie != STUN_COOKIE or data[8:20] != transaction_id:
        raise ValueError("Invalid STUN binding response")
    if length > len(data) - 20 or length % 4:
        raise ValueError("Invalid STUN response length")
    offset = 20
    end = 20 + length
    mapped: Endpoint | None = None
    while offset + 4 <= end:
        attribute_type, attribute_length = struct.unpack("!HH", data[offset:offset + 4])
        value = data[offset + 4:offset + 4 + attribute_length]
        if len(value) != attribute_length:
            raise ValueError("Truncated STUN attribute")
        if attribute_type in (0x0020, 0x0001) and attribute_length in (8, 20):
            family = value[1]
            port = struct.unpack("!H", value[2:4])[0]
            address = value[4:]
            if attribute_type == 0x0020:
                port ^= STUN_COOKIE >> 16
                mask = struct.pack("!I", STUN_COOKIE) + transaction_id
                address = bytes(byte ^ mask[index] for index, byte in enumerate(address))
            if family == 0x01 and len(address) == 4:
                mapped = str(ipaddress.IPv4Address(address)), port
            elif family == 0x02 and len(address) == 16:
                mapped = str(ipaddress.IPv6Address(address)), port
            if mapped:
                return mapped
        offset += 4 + ((attribute_length + 3) & ~3)
    raise ValueError("STUN response has no mapped address")


@dataclass
class Attempt:
    peer_id: str
    endpoint: Endpoint
    via_relay: bool = False
    private_key: X25519PrivateKey = field(default_factory=X25519PrivateKey.generate)
    nonce: bytes = field(default_factory=lambda: os.urandom(32))
    hello: bytes = b""
    task: asyncio.Task | None = None
    created_at: float = field(default_factory=time.monotonic)


@dataclass
class Reassembly:
    count: int
    created_at: float = field(default_factory=time.monotonic)
    fragments: dict[int, bytes] = field(default_factory=dict)


@dataclass
class Session:
    peer_id: str
    endpoint: Endpoint
    via_relay: bool
    session_id: bytes
    transmit_encryption_key: bytes
    receive_encryption_key: bytes
    transmit_authentication_key: bytes
    receive_authentication_key: bytes
    display_name: str
    encryption_public_key: bytes
    signing_public_key: bytes
    local_hello: bytes
    remote_nonce: bytes
    remote_session_public_key: bytes
    capabilities: list[str] = field(default_factory=list)
    remote_capabilities: list[str] = field(default_factory=list)
    peer_missing_capabilities: list[str] = field(default_factory=list)
    local_missing_capabilities: list[str] = field(default_factory=list)
    confirmed: bool = False
    connected_notified: bool = False
    created_at: float = field(default_factory=time.monotonic)
    last_seen: float = field(default_factory=time.monotonic)
    reassemblies: dict[int, Reassembly] = field(default_factory=dict)
    seen: dict[int, float] = field(default_factory=dict)


class UdpTransport:
    def __init__(
        self,
        identity: Identity,
        on_connected: ConnectedCallback,
        on_packet: PacketCallback,
        on_disconnected: DisconnectedCallback,
        capabilities: list[str] | None = None,
        force_relay: bool | None = None,
    ) -> None:
        self.identity = identity
        self.on_connected = on_connected
        self.on_packet = on_packet
        self.on_disconnected = on_disconnected
        self.capabilities = validate_capabilities(
            list(DEFAULT_CAPABILITIES if capabilities is None else capabilities)
        )
        self.force_relay = os.environ.get("MESHTALK_FORCE_RELAY") == "true" if force_relay is None else force_relay
        self.relay_enabled = True
        self._transport: asyncio.DatagramTransport | None = None
        self._attempts: dict[str, Attempt] = {}
        self._expected_endpoints: dict[str, tuple[Endpoint, float]] = {}
        self._derp_candidates: dict[str, Endpoint] = {}
        self._derp_peers: dict[Endpoint, str] = {}
        self._derp_sender: DerpSender | None = None
        self._direct_candidates: dict[str, Endpoint] = {}
        self._last_direct_probe: dict[str, float] = {}
        self._sessions: dict[str, Session] = {}
        self._pending_sessions: dict[str, dict[tuple[Endpoint, bool], Session]] = {}
        self._retiring_sessions: dict[bytes, tuple[Session, float]] = {}
        self._sessions_by_id: dict[bytes, Session] = {}
        self._stun_waiters: dict[bytes, asyncio.Future[bytes]] = {}
        self._pending: dict[tuple[bytes, int], asyncio.Event] = {}
        self._tasks: set[asyncio.Task] = set()
        self._maintenance_task: asyncio.Task | None = None
        if self.force_relay:
            logger.info("Direct remote UDP is disabled; DERP relay is required")

    async def start(self, port: int = 0) -> None:
        loop = asyncio.get_running_loop()
        self._transport, _ = await loop.create_datagram_endpoint(
            lambda: _UdpProtocol(self), local_addr=("0.0.0.0", port)
        )
        self._maintenance_task = asyncio.create_task(self._maintenance_loop())
        logger.info("Remote UDP transport listening on port %d", self.local_endpoint[1])

    async def stop(self) -> None:
        if self._maintenance_task:
            self._maintenance_task.cancel()
        for attempt in self._attempts.values():
            if attempt.task:
                attempt.task.cancel()
        for task in list(self._tasks):
            task.cancel()
        if self._transport:
            for session in list(self._sessions.values()):
                try:
                    for _ in range(3):
                        self._send_authenticated(session, GOODBYE, 0)
                except Exception:
                    pass
            self._transport.close()
        await asyncio.gather(
            *(task for task in [self._maintenance_task, *self._tasks] if task),
            return_exceptions=True,
        )

    @property
    def local_endpoint(self) -> Endpoint:
        if not self._transport:
            raise RuntimeError("UDP transport is not started")
        host, port = self._transport.get_extra_info("sockname")[:2]
        return str(host), int(port)

    def endpoint_for(self, peer_id: str) -> Endpoint | None:
        session = self._sessions.get(peer_id)
        return session.endpoint if session and session.confirmed else None

    def configure_derp(self, sender: DerpSender | None, server_enabled: bool = True) -> None:
        self.relay_enabled = server_enabled
        self._derp_sender = sender if self.relay_enabled else None

    def expect_derp_peer(self, peer_id: str) -> None:
        if peer_id == self.identity.peer_id:
            return
        endpoint = (f"derp:{peer_id}", 0)
        self._derp_candidates[peer_id] = endpoint
        self._derp_peers[endpoint] = peer_id
        if self.relay_enabled and self._derp_sender and (self.force_relay or peer_id not in self._direct_candidates):
            self._start_attempt(peer_id, endpoint, via_relay=True)

    def clear_direct_candidate(self, peer_id: str) -> None:
        self._direct_candidates.pop(peer_id, None)
        self._expected_endpoints.pop(peer_id, None)
        attempt = self._attempts.get(peer_id)
        if attempt and not attempt.via_relay:
            if attempt.task:
                attempt.task.cancel()
            self._attempts.pop(peer_id, None)
        for session in list(self._pending_sessions.get(peer_id, {}).values()):
            if not session.via_relay:
                self._remove_session(session)

    def expect_peer(self, peer_id: str, endpoint: Endpoint) -> None:
        if peer_id == self.identity.peer_id:
            return
        self._validate_peer_endpoint(peer_id, endpoint)
        previous_endpoint = self._direct_candidates.get(peer_id)
        self._direct_candidates[peer_id] = endpoint
        if peer_id not in self._expected_endpoints and len(self._expected_endpoints) >= MAX_EXPECTED_PEERS:
            raise ValueError("Too many expected UDP peers")
        now = time.monotonic()
        session = self._sessions.get(peer_id)
        verified = self._expected_endpoints.get(peer_id)
        if (
            verified
            and now - verified[1] < EXPECTED_PEER_TIMEOUT
            and session is not None
            and session.confirmed
            and session.endpoint == verified[0]
        ):
            endpoint = verified[0]
        self._expected_endpoints[peer_id] = (endpoint, now)
        if self.force_relay:
            derp_endpoint = self._derp_candidates.get(peer_id)
            if self._derp_sender and derp_endpoint:
                self._start_attempt(peer_id, derp_endpoint, via_relay=True)
            return
        if session and session.confirmed and session.endpoint == endpoint:
            return
        existing = self._attempts.get(peer_id)
        if existing and existing.endpoint == endpoint and existing.task and not existing.task.done():
            return
        if session and session.confirmed and session.via_relay:
            if (
                previous_endpoint == endpoint
                and now - self._last_direct_probe.get(peer_id, 0) < DIRECT_PROBE_INTERVAL
            ):
                return
            self._last_direct_probe[peer_id] = now
        if existing and existing.task:
            existing.task.cancel()
        self._start_attempt(peer_id, endpoint)

    def _validate_peer_endpoint(self, peer_id: str, endpoint: Endpoint) -> None:
        host, port = endpoint
        ipaddress.ip_address(host)
        if not 1 <= port <= 65535:
            raise ValueError("Invalid peer UDP port")
        if peer_id not in self._expected_endpoints and len(self._expected_endpoints) >= MAX_EXPECTED_PEERS:
            raise ValueError("Too many expected UDP peers")

    async def discover_public_endpoint(self, host: str, port: int, timeout: float = 5.0) -> Endpoint:
        if not self._transport:
            raise RuntimeError("UDP transport is not started")
        loop = asyncio.get_running_loop()
        addresses = await loop.getaddrinfo(host, port, family=socket.AF_INET, type=socket.SOCK_DGRAM)
        if not addresses:
            raise OSError("STUN server did not resolve to IPv4")
        transaction_id = os.urandom(12)
        request = struct.pack("!HHI12s", 0x0001, 0, STUN_COOKIE, transaction_id)
        future: asyncio.Future[bytes] = loop.create_future()
        self._stun_waiters[transaction_id] = future
        try:
            self._transport.sendto(request, addresses[0][4])
            response = await asyncio.wait_for(future, timeout)
            return parse_stun_response(response, transaction_id)
        finally:
            self._stun_waiters.pop(transaction_id, None)

    async def send_packet(self, peer_id: str, packet: Packet) -> None:
        session = self._sessions.get(peer_id)
        if not session or not session.confirmed:
            raise ConnectionError("Remote UDP peer is not connected")
        frame = packet.encode()
        fragments = [frame[offset:offset + FRAGMENT_SIZE] for offset in range(0, len(frame), FRAGMENT_SIZE)]
        if not fragments or len(fragments) > MAX_FRAGMENTS:
            raise ValueError("Packet cannot be represented by UDP transport")
        message_id = secrets.randbits(64)
        datagrams = [
            self._encrypt_fragment(session, message_id, index, len(fragments), fragment)
            for index, fragment in enumerate(fragments)
        ]
        acknowledged = asyncio.Event()
        if len(self._pending) >= 64:
            raise ConnectionError("Too many pending UDP packets")
        self._pending[(session.session_id, message_id)] = acknowledged
        try:
            for _ in range(MAX_RETRIES):
                for datagram in datagrams:
                    self._send_route(datagram, session.endpoint, session.via_relay)
                try:
                    await asyncio.wait_for(acknowledged.wait(), RETRY_INTERVAL)
                    return
                except asyncio.TimeoutError:
                    continue
            raise ConnectionError("Remote UDP packet was not acknowledged")
        finally:
            self._pending.pop((session.session_id, message_id), None)

    def datagram_received(self, data: bytes, addr: Endpoint, via_relay: bool = False) -> None:
        if len(data) >= 20 and data[4:8] == struct.pack("!I", STUN_COOKIE):
            waiter = self._stun_waiters.get(data[8:20])
            if waiter and not waiter.done():
                waiter.set_result(data)
            return
        if len(data) > MAX_DATAGRAM_SIZE or not data.startswith(MAGIC) or len(data) < 5:
            return
        if self.force_relay and not via_relay:
            return
        try:
            message_type = data[4]
            if message_type == HELLO:
                self._handle_hello(data[5:], addr, via_relay)
            elif message_type == DATA:
                self._handle_data(data, addr, via_relay)
            elif message_type == ACK:
                self._handle_ack(data, addr, via_relay)
            elif message_type in (PING, PONG, READY, GOODBYE):
                self._handle_keepalive(data, addr, via_relay)
        except Exception as exc:
            logger.debug("Rejected UDP datagram from %s:%d: %s", *addr, exc)

    def _make_hello(self, attempt: Attempt) -> bytes:
        value = {
            "capabilities": self.capabilities,
            "peer_id": self.identity.peer_id,
            "display_name": self.identity.display_name,
            "signing_public_key": self.identity.signing_public_key_bytes().hex(),
            "encryption_public_key": self.identity.encryption_public_key_bytes().hex(),
            "session_public_key": _raw_public(attempt.private_key).hex(),
            "nonce": attempt.nonce.hex(),
        }
        value["signature"] = self.identity.signing_private_key.sign(_canonical(value)).hex()
        return MAGIC + bytes([HELLO]) + json.dumps(value, separators=(",", ":")).encode()

    async def _punch_loop(self, attempt: Attempt) -> None:
        for _ in range(20):
            current = self._attempts.get(attempt.peer_id)
            session = self._sessions.get(attempt.peer_id)
            if current is not attempt or session and session.confirmed and session.endpoint == attempt.endpoint and session.via_relay == attempt.via_relay:
                return
            self._send_route(attempt.hello, attempt.endpoint, attempt.via_relay)
            if session and session.endpoint == attempt.endpoint and session.via_relay == attempt.via_relay:
                self._send_authenticated(session, READY, 0)
            await asyncio.sleep(0.4)
        if self._attempts.get(attempt.peer_id) is attempt:
            self._attempts.pop(attempt.peer_id, None)
            session = self._sessions.get(attempt.peer_id)
            if session and not session.confirmed:
                self._remove_session(session)
            if not attempt.via_relay:
                derp_endpoint = self._derp_candidates.get(attempt.peer_id)
                if self._derp_sender and derp_endpoint and (session is None or not session.confirmed):
                    self._start_attempt(attempt.peer_id, derp_endpoint, via_relay=True)

    @staticmethod
    def _route_key(session: Session) -> tuple[Endpoint, bool]:
        return session.endpoint, session.via_relay

    def _remove_session(self, session: Session) -> None:
        if self._sessions.get(session.peer_id) is session:
            self._sessions.pop(session.peer_id, None)
        self._sessions_by_id.pop(session.session_id, None)
        pending = self._pending_sessions.get(session.peer_id)
        if pending and pending.get(self._route_key(session)) is session:
            pending.pop(self._route_key(session), None)
            if not pending:
                self._pending_sessions.pop(session.peer_id, None)
        self._retiring_sessions.pop(session.session_id, None)

    def _session_for_route(
        self, peer_id: str, endpoint: Endpoint, via_relay: bool
    ) -> Session | None:
        active = self._sessions.get(peer_id)
        if active and self._route_key(active) == (endpoint, via_relay):
            return active
        pending = self._pending_sessions.get(peer_id, {}).get((endpoint, via_relay))
        if pending:
            return pending
        return next(
            (
                session
                for session, _ in self._retiring_sessions.values()
                if session.peer_id == peer_id
                and self._route_key(session) == (endpoint, via_relay)
            ),
            None,
        )

    def _promote_session(self, session: Session) -> None:
        active = self._sessions.get(session.peer_id)
        if active is session:
            return
        if active and active.confirmed:
            self._retiring_sessions[active.session_id] = (
                active,
                time.monotonic() + SESSION_TIMEOUT,
            )
        elif active:
            self._remove_session(active)
        self._sessions[session.peer_id] = session
        pending = self._pending_sessions.get(session.peer_id)
        if pending:
            pending.pop(self._route_key(session), None)
            if not pending:
                self._pending_sessions.pop(session.peer_id, None)

    def _handle_hello(self, payload: bytes, addr: Endpoint, via_relay: bool) -> None:
        if len(payload) > 1000:
            raise ValueError("Oversized UDP handshake")
        value = json.loads(payload)
        signature = bytes.fromhex(value.pop("signature"))
        signing_key = bytes.fromhex(value["signing_public_key"])
        encryption_key = bytes.fromhex(value["encryption_public_key"])
        session_key = bytes.fromhex(value["session_public_key"])
        nonce = bytes.fromhex(value["nonce"])
        peer_id = hashlib.sha256(signing_key).hexdigest()
        if value.get("peer_id") != peer_id:
            raise ValueError("UDP handshake identity mismatch")
        remote_capabilities = validate_capabilities(value.get("capabilities"))
        if any(len(item) != 32 for item in (signing_key, encryption_key, session_key, nonce)) or len(signature) != 64:
            raise ValueError("Invalid UDP handshake key length")
        direct = self._expected_endpoints.get(peer_id)
        relay = self._derp_candidates.get(peer_id)
        matches_direct = direct is not None and direct[0][0] == addr[0]
        matches_relay = relay == addr
        if (direct or relay) and not (matches_direct or matches_relay):
            raise ValueError("UDP handshake source does not match an introduced endpoint")
        if matches_direct and direct and direct[0] != addr:
            logger.info("UDP endpoint changed for %s: %s -> %s:%d", peer_id, direct[0], *addr)
        if direct is None and relay is None:
            logger.debug("Accepting UDP handshake from %s without prior introduction", peer_id)
        if not via_relay and matches_direct:
            self._expected_endpoints[peer_id] = (addr, time.monotonic())
        try:
            Ed25519PublicKey.from_public_bytes(signing_key).verify(signature, _canonical(value))
        except InvalidSignature as exc:
            raise ValueError("Invalid UDP handshake signature") from exc
        current = self._session_for_route(peer_id, addr, via_relay)
        if (
            current and current.remote_nonce == nonce
            and current.remote_session_public_key == session_key
        ):
            self._send_route(current.local_hello, addr, via_relay)
            self._send_authenticated(current, READY, 0)
            return
        attempt = self._attempts.get(peer_id)
        if not attempt or attempt.endpoint != addr or attempt.via_relay != via_relay:
            attempt = self._start_attempt(peer_id, addr, via_relay)
        self._send_route(attempt.hello, addr, via_relay)
        shared = attempt.private_key.exchange(X25519PublicKey.from_public_bytes(session_key))
        local_first = self.identity.peer_id < peer_id
        salt = attempt.nonce + nonce if local_first else nonce + attempt.nonce
        material = HKDF(
            algorithm=SHA256(), length=128, salt=salt, info=b"meshtalk-udp-session-v1"
        ).derive(shared)
        session_id = hashlib.sha256(material + b"session-id").digest()[:8]
        if current and current.session_id == session_id:
            self._send_authenticated(current, READY, 0)
            return
        if not current and len(self._sessions_by_id) >= MAX_SESSIONS:
            raise ValueError("Too many UDP sessions")
        if current:
            self._remove_session(current)
        first_to_second = material[:32], material[32:64]
        second_to_first = material[64:96], material[96:128]
        transmit, receive = (first_to_second, second_to_first) if local_first else (second_to_first, first_to_second)
        session = Session(
            peer_id, addr, via_relay, session_id, transmit[0], receive[0], transmit[1], receive[1],
            Identity.normalize_display_name(value["display_name"]), encryption_key, signing_key,
            attempt.hello, nonce, session_key,
            intersect_capabilities(self.capabilities, remote_capabilities),
            sorted(remote_capabilities),
            sorted(set(self.capabilities) - set(remote_capabilities)),
            sorted(set(remote_capabilities) - set(self.capabilities)),
        )
        active = self._sessions.get(peer_id)
        if active and active.confirmed and self._route_key(active) != (addr, via_relay):
            self._pending_sessions.setdefault(peer_id, {})[(addr, via_relay)] = session
        else:
            self._sessions[peer_id] = session
        self._sessions_by_id[session_id] = session
        self._send_authenticated(session, READY, 0)

    def _encrypt_fragment(
        self, session: Session, message_id: int, index: int, count: int, fragment: bytes
    ) -> bytes:
        nonce = os.urandom(12)
        header = DATA_HEADER.pack(MAGIC, DATA, session.session_id, message_id, index, count, nonce)
        return header + AESGCM(session.transmit_encryption_key).encrypt(nonce, fragment, header)

    def _handle_data(self, data: bytes, addr: Endpoint, via_relay: bool) -> None:
        if len(data) < DATA_HEADER.size + 16:
            raise ValueError("Truncated UDP data")
        _, _, session_id, message_id, index, count, nonce = DATA_HEADER.unpack(data[:DATA_HEADER.size])
        session = self._session_for(session_id, addr, via_relay, require_confirmation=True)
        if not 1 <= count <= MAX_FRAGMENTS or index >= count:
            raise ValueError("Invalid UDP fragment index")
        fragment = AESGCM(session.receive_encryption_key).decrypt(
            nonce, data[DATA_HEADER.size:], data[:DATA_HEADER.size]
        )
        session.last_seen = time.monotonic()
        if message_id in session.seen:
            self._send_ack(session, message_id)
            return
        if len(session.reassemblies) >= 32 and message_id not in session.reassemblies:
            raise ValueError("Too many UDP reassemblies")
        reassembly = session.reassemblies.setdefault(message_id, Reassembly(count))
        if reassembly.count != count:
            raise ValueError("UDP fragment count changed")
        reassembly.fragments[index] = fragment
        if len(reassembly.fragments) != count:
            return
        frame = b"".join(reassembly.fragments[index] for index in range(count))
        del session.reassemblies[message_id]
        if len(frame) < HEADER_SIZE or len(frame) > MAX_PACKET_SIZE + HEADER_SIZE:
            raise ValueError("Invalid reassembled packet size")
        packet = Packet.decode(frame[:HEADER_SIZE], frame[HEADER_SIZE:])
        session.seen[message_id] = time.monotonic()
        self._send_ack(session, message_id)
        self._spawn(self.on_packet(session.peer_id, packet))

    def _send_ack(self, session: Session, message_id: int) -> None:
        header = AUTH_HEADER.pack(MAGIC, ACK, session.session_id, message_id)
        self._send_route(
            header + hmac.digest(session.transmit_authentication_key, header, "sha256")[:16],
            session.endpoint,
            session.via_relay,
        )

    def _handle_ack(self, data: bytes, addr: Endpoint, via_relay: bool) -> None:
        if len(data) != AUTH_HEADER.size + 16:
            raise ValueError("Invalid UDP acknowledgement")
        _, _, session_id, message_id = AUTH_HEADER.unpack(data[:AUTH_HEADER.size])
        session = self._session_for(session_id, addr, via_relay, require_confirmation=True)
        expected = hmac.digest(
            session.receive_authentication_key, data[:AUTH_HEADER.size], "sha256"
        )[:16]
        if not hmac.compare_digest(data[AUTH_HEADER.size:], expected):
            raise ValueError("Invalid UDP acknowledgement authentication")
        session.last_seen = time.monotonic()
        event = self._pending.get((session_id, message_id))
        if event:
            event.set()

    def _handle_keepalive(self, data: bytes, addr: Endpoint, via_relay: bool) -> None:
        if len(data) != AUTH_HEADER.size + 16:
            raise ValueError("Invalid UDP keepalive")
        _, message_type, session_id, token = AUTH_HEADER.unpack(data[:AUTH_HEADER.size])
        session = self._session_for(session_id, addr, via_relay)
        expected = hmac.digest(
            session.receive_authentication_key, data[:AUTH_HEADER.size], "sha256"
        )[:16]
        if not hmac.compare_digest(data[AUTH_HEADER.size:], expected):
            raise ValueError("Invalid UDP keepalive authentication")
        if message_type == READY:
            if not session.confirmed:
                session.confirmed = True
                session.last_seen = time.monotonic()
                attempt = self._attempts.pop(session.peer_id, None)
                if attempt and attempt.task:
                    attempt.task.cancel()
                self._promote_session(session)
                self._send_authenticated(session, READY, 0)
            if not session.connected_notified:
                session.connected_notified = True
                self._spawn(self.on_connected(
                    session.peer_id,
                    session.endpoint[0],
                    session.endpoint[1],
                    session.display_name,
                    session.encryption_public_key,
                    session.signing_public_key,
                    session.via_relay,
                ))
            return
        if not session.confirmed:
            raise ValueError("UDP session is not confirmed")
        session.last_seen = time.monotonic()
        if message_type == PING:
            self._send_authenticated(session, PONG, token)
        elif message_type == GOODBYE:
            active = self._sessions.get(session.peer_id) is session
            self._remove_session(session)
            if active:
                self._spawn(self.on_disconnected(session.peer_id))

    def _send_authenticated(self, session: Session, message_type: int, token: int) -> None:
        header = AUTH_HEADER.pack(MAGIC, message_type, session.session_id, token)
        self._send_route(
            header + hmac.digest(session.transmit_authentication_key, header, "sha256")[:16],
            session.endpoint,
            session.via_relay,
        )

    def get_capabilities(self, peer_id: str) -> list[str]:
        session = self._sessions.get(peer_id)
        return list(session.capabilities) if session else []

    def get_capability_gaps(self, peer_id: str) -> tuple[list[str], list[str], list[str]] | None:
        session = self._sessions.get(peer_id)
        if session is None:
            return None
        return (
            list(session.remote_capabilities),
            list(session.peer_missing_capabilities),
            list(session.local_missing_capabilities),
        )

    def _session_for(
        self, session_id: bytes, addr: Endpoint, via_relay: bool, require_confirmation: bool = False
    ) -> Session:
        session = self._sessions_by_id.get(session_id)
        if not session or session.endpoint != addr or session.via_relay != via_relay:
            raise ValueError("Unknown UDP session")
        if require_confirmation and not session.confirmed:
            raise ValueError("UDP session is not confirmed")
        return session

    async def _maintenance_loop(self) -> None:
        while True:
            await asyncio.sleep(5)
            now = time.monotonic()
            for session in list(self._sessions.values()):
                if not session.confirmed and now - session.created_at > 10:
                    self._remove_session(session)
                    continue
                if now - session.last_seen > SESSION_TIMEOUT:
                    self._remove_session(session)
                    await self.on_disconnected(session.peer_id)
                    continue
                if session.confirmed:
                    self._send_authenticated(session, PING, secrets.randbits(64))
                    if session.via_relay and now - self._last_direct_probe.get(session.peer_id, 0) >= DIRECT_PROBE_INTERVAL:
                        direct = self._direct_candidates.get(session.peer_id)
                        attempt = self._attempts.get(session.peer_id)
                        if direct and not (attempt and not attempt.via_relay and attempt.task and not attempt.task.done()):
                            self._last_direct_probe[session.peer_id] = now
                            self._start_attempt(session.peer_id, direct)
                session.seen = {
                    message_id: seen_at for message_id, seen_at in session.seen.items()
                    if now - seen_at < SESSION_TIMEOUT
                }
                session.reassemblies = {
                    message_id: value for message_id, value in session.reassemblies.items()
                    if now - value.created_at < 10
                }
            for session, expires_at in list(self._retiring_sessions.values()):
                if now >= expires_at:
                    self._remove_session(session)
                    continue
                session.seen = {
                    message_id: seen_at for message_id, seen_at in session.seen.items()
                    if now - seen_at < SESSION_TIMEOUT
                }
                session.reassemblies = {
                    message_id: value for message_id, value in session.reassemblies.items()
                    if now - value.created_at < 10
                }
            for sessions in list(self._pending_sessions.values()):
                for session in list(sessions.values()):
                    if now - session.created_at > 10:
                        self._remove_session(session)
            self._expected_endpoints = {
                peer_id: value for peer_id, value in self._expected_endpoints.items()
                if now - value[1] < EXPECTED_PEER_TIMEOUT or peer_id in self._sessions
            }

    def _start_attempt(self, peer_id: str, endpoint: Endpoint, via_relay: bool = False) -> Attempt:
        if via_relay and self._derp_sender is None:
            return Attempt(peer_id, endpoint, via_relay=True)
        if peer_id not in self._attempts and len(self._attempts) >= MAX_ATTEMPTS:
            raise ValueError("Too many concurrent UDP punch attempts")
        old = self._attempts.get(peer_id)
        if old and old.task:
            old.task.cancel()
        attempt = Attempt(peer_id, endpoint, via_relay=via_relay)
        attempt.hello = self._make_hello(attempt)
        self._attempts[peer_id] = attempt
        attempt.task = self._spawn(self._punch_loop(attempt))
        return attempt

    def _send_route(self, data: bytes, endpoint: Endpoint, via_relay: bool) -> None:
        if via_relay:
            peer_id = self._derp_peers.get(endpoint)
            if not self._derp_sender or not peer_id:
                raise ConnectionError("DERP relay is not available")
            self._spawn(self._derp_sender(peer_id, data))
            return
        self._sendto(data, endpoint)

    def _sendto(self, data: bytes, endpoint: Endpoint) -> None:
        if not self._transport:
            raise RuntimeError("UDP transport is not started")
        self._transport.sendto(data, endpoint)

    def derp_datagram_received(self, peer_id: str, data: bytes) -> None:
        endpoint = self._derp_candidates.get(peer_id)
        if endpoint:
            self.datagram_received(data, endpoint, via_relay=True)

    def _spawn(self, awaitable: Awaitable[None]) -> asyncio.Task:
        task = asyncio.create_task(awaitable)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task


class _UdpProtocol(asyncio.DatagramProtocol):
    def __init__(self, service: UdpTransport) -> None:
        self.service = service

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        self.service.datagram_received(data, (addr[0], addr[1]))

    def error_received(self, exc: Exception) -> None:
        logger.debug("UDP transport error: %s", exc)
