"""End-to-end encrypted endpoint exchange through an opaque control service."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import ipaddress
import json
import logging
import os
import ssl
import time
from collections.abc import Awaitable, Callable

import certifi
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from websockets.asyncio.client import connect

from .identity import Identity
from .protocol import (
    PROTOCOL_VERSION,
    MIN_SUPPORTED_PROTOCOL_VERSION,
    negotiate_protocol_version,
)
from .settings import Room, Settings
from .udp_transport import Endpoint, UdpTransport

logger = logging.getLogger(__name__)

CandidateCallback = Callable[[str, Endpoint], Awaitable[None]]
CARD_MAX_AGE = 180
REFRESH_INTERVAL = 30
PEER_FETCH_INTERVAL = 120
CONTROL_PING_INTERVAL = 5
CONTROL_PING_TIMEOUT = 5
CONTROL_CONNECT_TIMEOUT = 10
CONTROL_RECONNECT_MAX_DELAY = 30
MAX_CANDIDATE_CHANGES_PER_MINUTE = 12
MAX_TRACKED_CANDIDATES = 512
CANDIDATE_TRACKING_AGE = 600
CONTROL_SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())


def _canonical(value: dict) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _room_key(room: Room) -> bytes:
    return HKDF(
        algorithm=SHA256(), length=32, salt=room.room_id, info=b"meshtalk-control-room-v1"
    ).derive(room.secret)


def encrypt_endpoint_card(identity: Identity, room: Room, endpoint: Endpoint) -> str:
    value = {
        "version": PROTOCOL_VERSION,
        "min_version": MIN_SUPPORTED_PROTOCOL_VERSION,
        "kind": "endpoint",
        "peer_id": identity.peer_id,
        "signing_public_key": identity.signing_public_key_bytes().hex(),
        "candidate": {"host": endpoint[0], "port": endpoint[1]},
        "created_at": int(time.time()),
        "nonce": os.urandom(16).hex(),
    }
    value["signature"] = identity.signing_private_key.sign(_canonical(value)).hex()
    nonce = os.urandom(12)
    encrypted = AESGCM(_room_key(room)).encrypt(nonce, json.dumps(value).encode(), room.room_id)
    return _encode(nonce + encrypted)


def decrypt_endpoint_card(room: Room, payload: str, now: float | None = None) -> dict:
    encrypted = _decode(payload)
    if len(encrypted) < 12 + 16:
        raise ValueError("Truncated endpoint card")
    plaintext = AESGCM(_room_key(room)).decrypt(
        encrypted[:12], encrypted[12:], room.room_id
    )
    value = json.loads(plaintext)
    signature = bytes.fromhex(value.pop("signature"))
    signing_key = bytes.fromhex(value["signing_public_key"])
    peer_id = hashlib.sha256(signing_key).hexdigest()
    current_time = time.time() if now is None else now
    remote_version = value.get("version", 1)
    remote_min = value.get("min_version", 1)
    if value.get("kind") != "endpoint" or negotiate_protocol_version(
        PROTOCOL_VERSION, MIN_SUPPORTED_PROTOCOL_VERSION, remote_version, remote_min
    ) is None:
        raise ValueError("Unsupported endpoint card protocol version")
    if value.get("peer_id") != peer_id or len(signing_key) != 32 or len(signature) != 64:
        raise ValueError("Endpoint card identity mismatch")
    created_at = value.get("created_at")
    if not isinstance(created_at, int) or abs(current_time - created_at) > CARD_MAX_AGE:
        raise ValueError("Expired endpoint card")
    candidate = value.get("candidate")
    if not isinstance(candidate, dict) or not isinstance(candidate.get("host"), str):
        raise ValueError("Invalid endpoint card candidate")
    if not isinstance(candidate.get("port"), int):
        raise ValueError("Invalid endpoint card port")
    try:
        Ed25519PublicKey.from_public_bytes(signing_key).verify(signature, _canonical(value))
    except InvalidSignature as exc:
        raise ValueError("Invalid endpoint card signature") from exc
    value["signature"] = signature.hex()
    return value


class RendezvousService:
    def __init__(
        self,
        identity: Identity,
        settings: Settings,
        udp: UdpTransport,
        on_candidate: CandidateCallback,
        allow_loopback: bool = False,
    ) -> None:
        self.identity = identity
        self.settings = settings
        self.udp = udp
        self.on_candidate = on_candidate
        self.allow_loopback = allow_loopback
        self.connected = False
        self.public_endpoint: Endpoint | None = None
        self._last_published_endpoint: Endpoint | None = None
        self.member_counts: dict[str, int] = {}
        self.reconnect_attempts: int = 0
        self._running = False
        self._task: asyncio.Task | None = None
        self._stun_task: asyncio.Task | None = None
        self._reconnect = asyncio.Event()
        self._seen_cards: dict[tuple[str, str, str], float] = {}
        self._last_candidates: dict[str, Endpoint] = {}
        self._candidate_changes: dict[str, list[float]] = {}
        self._candidate_seen: dict[str, float] = {}
        self._websocket = None

    async def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(self._connection_loop())
        self._stun_task = asyncio.create_task(self._stun_loop())

    async def stop(self) -> None:
        self._running = False
        self._reconnect.set()
        if self._stun_task:
            self._stun_task.cancel()
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, self._stun_task, return_exceptions=True)

    def configuration_changed(self) -> None:
        self._reconnect.set()

    def room_status(self) -> list[dict]:
        return [
            {"room_id": room.id, "members": self.member_counts.get(room.id, 0)}
            for room in self.settings.rooms.values()
        ]

    async def refresh_endpoint(self) -> dict:
        if not self._websocket:
            return {"error": "Not connected to control server"}
        try:
            await self._discover_endpoint()
            await self._announce_all(self._websocket)
        except Exception as exc:
            return {"error": str(exc)}
        endpoint = self.public_endpoint
        return {
            "public_endpoint": list(endpoint) if endpoint else None,
        }

    async def _connection_loop(self) -> None:
        backoff = 1.0
        while self._running:
            self._reconnect.clear()
            url = self.settings.control_url
            if not url or not self.settings.rooms:
                self.connected = False
                try:
                    await asyncio.wait_for(self._reconnect.wait(), 2)
                except TimeoutError:
                    pass
                continue
            try:
                async with connect(
                    url,
                    ssl=CONTROL_SSL_CONTEXT if url.startswith("wss://") else None,
                    max_size=256 * 1024,
                    open_timeout=CONTROL_CONNECT_TIMEOUT,
                    ping_interval=CONTROL_PING_INTERVAL,
                    ping_timeout=CONTROL_PING_TIMEOUT,
                ) as websocket:
                    self.connected = True
                    self._websocket = websocket
                    self.reconnect_attempts = 0
                    backoff = 1.0
                    for room in self.settings.rooms.values():
                        await websocket.send(json.dumps({"type": "join", "room_id": room.id}))
                    await self._discover_endpoint()
                    await self._announce_all(websocket)
                    receive_task = asyncio.create_task(self._receive_loop(websocket))
                    refresh_task = asyncio.create_task(self._refresh_loop(websocket))
                    fetch_task = asyncio.create_task(self._fetch_loop(websocket))
                    reconnect_task = asyncio.create_task(self._reconnect.wait())
                    done, pending = await asyncio.wait(
                        (receive_task, refresh_task, fetch_task, reconnect_task),
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    for task in done:
                        if task is not reconnect_task:
                            task.result()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Control connection failed: %s", exc)
            finally:
                self.connected = False
                self._websocket = None
                self.member_counts.clear()
            if self._running:
                self.reconnect_attempts += 1
                logger.info("Control disconnected; reconnecting in %.0fs", backoff)
                try:
                    await asyncio.wait_for(self._reconnect.wait(), backoff)
                except TimeoutError:
                    pass
                backoff = min(backoff * 2, CONTROL_RECONNECT_MAX_DELAY)

    async def _receive_loop(self, websocket) -> None:
        async for raw in websocket:
            if not isinstance(raw, str) or len(raw) > 256 * 1024:
                continue
            try:
                message = json.loads(raw)
                room_id = message.get("room_id")
                room = self.settings.rooms.get(room_id)
                if not room:
                    continue
                if message.get("type") in ("joined", "refresh"):
                    count = message.get("member_count")
                    if isinstance(count, int):
                        self.member_counts[room_id] = count
                elif message.get("type") == "signal" and isinstance(message.get("payload"), str):
                    await self._handle_card(room, message["payload"])
                elif message.get("type") == "peers" and isinstance(message.get("payloads"), list):
                    for payload in message["payloads"]:
                        if isinstance(payload, str):
                            try:
                                await self._handle_card(room, payload)
                            except Exception as exc:
                                logger.debug("Rejected fetched peer card: %s", exc)
            except Exception as exc:
                logger.debug("Rejected control message: %s", exc)

    async def _refresh_loop(self, websocket) -> None:
        while True:
            await asyncio.sleep(REFRESH_INTERVAL)
            await self._announce_all(websocket)

    async def _fetch_loop(self, websocket) -> None:
        while True:
            await asyncio.sleep(PEER_FETCH_INTERVAL)
            if not self._websocket:
                continue
            for room in self.settings.rooms.values():
                try:
                    await websocket.send(json.dumps({"type": "get_peers", "room_id": room.id}))
                except Exception as exc:
                    logger.debug("Failed to fetch peer roster: %s", exc)

    async def _discover_endpoint(self) -> None:
        host, port = self.settings.stun_server
        try:
            self.public_endpoint = await self.udp.discover_public_endpoint(host, port)
        except Exception as exc:
            self.public_endpoint = None
            logger.warning("Public STUN discovery failed through %s:%d: %s", host, port, exc)

    async def _stun_loop(self) -> None:
        while self._running:
            await self._discover_endpoint()
            if self.public_endpoint != self._last_published_endpoint and self._websocket:
                try:
                    await self._announce_all(self._websocket)
                    logger.info("Public endpoint changed to %s; re-announced to rooms", self.public_endpoint)
                except Exception as exc:
                    logger.warning("Failed to re-announce endpoint after change: %s", exc)
            await asyncio.sleep(REFRESH_INTERVAL)

    async def _announce_all(self, websocket) -> None:
        if not self.public_endpoint:
            return
        self._last_published_endpoint = self.public_endpoint
        for room in self.settings.rooms.values():
            await self._announce(websocket, room)

    async def _announce(self, websocket, room: Room) -> None:
        if not self.public_endpoint:
            return
        payload = encrypt_endpoint_card(self.identity, room, self.public_endpoint)
        await websocket.send(json.dumps({"type": "signal", "room_id": room.id, "payload": payload}))

    async def _handle_card(self, room: Room, payload: str) -> None:
        value = decrypt_endpoint_card(room, payload)
        peer_id = value["peer_id"]
        if peer_id == self.identity.peer_id:
            return
        replay_key = (room.id, peer_id, value["nonce"])
        if replay_key in self._seen_cards:
            return
        self._seen_cards[replay_key] = time.monotonic()
        now = time.monotonic()
        self._seen_cards = {
            key: seen_at for key, seen_at in self._seen_cards.items() if now - seen_at < CARD_MAX_AGE
        }
        candidate = value["candidate"]
        address = ipaddress.ip_address(candidate["host"])
        port = candidate["port"]
        valid_address = isinstance(address, ipaddress.IPv4Address) and address.is_global and not (
            address.is_multicast or address.is_unspecified or address.is_reserved or address.is_link_local
        )
        if self.allow_loopback and address.is_loopback:
            valid_address = True
        if not 1 <= port <= 65535 or not valid_address:
            raise ValueError("Endpoint card is not a public address")
        endpoint = str(address), port
        self._candidate_seen = {
            tracked_peer: seen_at for tracked_peer, seen_at in self._candidate_seen.items()
            if now - seen_at < CANDIDATE_TRACKING_AGE
        }
        self._last_candidates = {
            tracked_peer: tracked for tracked_peer, tracked in self._last_candidates.items()
            if tracked_peer in self._candidate_seen
        }
        self._candidate_changes = {
            tracked_peer: changes for tracked_peer, changes in self._candidate_changes.items()
            if tracked_peer in self._candidate_seen
        }
        if peer_id not in self._candidate_seen and len(self._candidate_seen) >= MAX_TRACKED_CANDIDATES:
            raise ValueError("Too many room candidates")
        if self._last_candidates.get(peer_id) != endpoint:
            changes = [changed for changed in self._candidate_changes.get(peer_id, []) if now - changed < 60]
            if len(changes) >= MAX_CANDIDATE_CHANGES_PER_MINUTE:
                raise ValueError("Endpoint card changed too frequently")
            changes.append(now)
        self.udp.expect_peer(peer_id, endpoint)
        self._candidate_seen[peer_id] = now
        if self._last_candidates.get(peer_id) != endpoint:
            self._candidate_changes[peer_id] = changes
            self._last_candidates[peer_id] = endpoint
        await self.on_candidate(peer_id, endpoint)
