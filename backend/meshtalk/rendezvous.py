"""End-to-end encrypted endpoint exchange through an opaque control service."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import time
from collections.abc import Awaitable, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from websockets.asyncio.client import connect

from .identity import Identity
from .settings import Room, Settings
from .udp_transport import Endpoint, UdpTransport

logger = logging.getLogger(__name__)

CandidateCallback = Callable[[str, Endpoint], Awaitable[None]]
CARD_MAX_AGE = 180
REFRESH_INTERVAL = 30


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
        "version": 1,
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
    if value.get("version") != 1 or value.get("kind") != "endpoint":
        raise ValueError("Unsupported endpoint card")
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
    ) -> None:
        self.identity = identity
        self.settings = settings
        self.udp = udp
        self.on_candidate = on_candidate
        self.connected = False
        self.public_endpoint: Endpoint | None = None
        self.member_counts: dict[str, int] = {}
        self._running = False
        self._task: asyncio.Task | None = None
        self._reconnect = asyncio.Event()
        self._seen_cards: dict[tuple[str, str, str], float] = {}

    async def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(self._connection_loop())

    async def stop(self) -> None:
        self._running = False
        self._reconnect.set()
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    def configuration_changed(self) -> None:
        self._reconnect.set()

    def room_status(self) -> list[dict]:
        return [
            {"room_id": room.id, "members": self.member_counts.get(room.id, 0)}
            for room in self.settings.rooms.values()
        ]

    async def _connection_loop(self) -> None:
        backoff = 1.0
        while self._running:
            url = self.settings.control_url
            if not url or not self.settings.rooms:
                self.connected = False
                self._reconnect.clear()
                try:
                    await asyncio.wait_for(self._reconnect.wait(), 2)
                except TimeoutError:
                    pass
                continue
            try:
                async with connect(url, max_size=256 * 1024, ping_interval=20, ping_timeout=20) as websocket:
                    self.connected = True
                    backoff = 1.0
                    self._reconnect.clear()
                    for room in self.settings.rooms.values():
                        await websocket.send(json.dumps({"type": "join", "room_id": room.id}))
                    await self._announce_all(websocket)
                    receive_task = asyncio.create_task(self._receive_loop(websocket))
                    refresh_task = asyncio.create_task(self._refresh_loop(websocket))
                    reconnect_task = asyncio.create_task(self._reconnect.wait())
                    done, pending = await asyncio.wait(
                        (receive_task, refresh_task, reconnect_task),
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
                self.member_counts.clear()
            if self._running:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)

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
                    if message.get("type") == "refresh":
                        await self._announce(websocket, room)
                elif message.get("type") == "signal" and isinstance(message.get("payload"), str):
                    await self._handle_card(room, message["payload"])
            except Exception as exc:
                logger.debug("Rejected control message: %s", exc)

    async def _refresh_loop(self, websocket) -> None:
        while True:
            await asyncio.sleep(REFRESH_INTERVAL)
            await self._announce_all(websocket)

    async def _announce_all(self, websocket) -> None:
        host, port = self.settings.stun_server
        try:
            self.public_endpoint = await self.udp.discover_public_endpoint(host, port)
        except Exception as exc:
            self.public_endpoint = None
            logger.warning("Public STUN discovery failed through %s:%d: %s", host, port, exc)
            return
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
        endpoint = candidate["host"], candidate["port"]
        await self.on_candidate(peer_id, endpoint)
        self.udp.expect_peer(peer_id, endpoint)
