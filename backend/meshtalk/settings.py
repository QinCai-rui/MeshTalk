"""Persistent control-service and private room configuration."""

from __future__ import annotations

import base64
import ipaddress
import json
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

DEFAULT_STUN_HOST = "stun.l.google.com"
DEFAULT_STUN_PORT = 19302
INVITE_PREFIX = "meshtalk:"
GROUP_INVITE_PREFIX = "meshtalk-group:"
MAX_GROUP_NAME_LENGTH = 64


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _group_metadata_key(room_id: bytes, secret: bytes) -> bytes:
    return HKDF(
        algorithm=SHA256(), length=32, salt=room_id, info=b"meshtalk-group-invite-v1"
    ).derive(secret)


def normalize_group_name(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("Group name required")
    name = value.strip()
    if not name or len(name) > MAX_GROUP_NAME_LENGTH or any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise ValueError(f"Group name must be 1-{MAX_GROUP_NAME_LENGTH} printable characters")
    return name


@dataclass(frozen=True)
class Room:
    room_id: bytes
    secret: bytes
    group_name: str | None = None

    @property
    def id(self) -> str:
        return self.room_id.hex()

    @property
    def invite(self) -> str:
        prefix = GROUP_INVITE_PREFIX if self.group_name is not None else INVITE_PREFIX
        invite = f"{prefix}{_encode(self.room_id)}.{_encode(self.secret)}"
        if self.group_name is None:
            return invite
        metadata = json.dumps(
            {"version": 1, "group_name": self.group_name}, separators=(",", ":"), sort_keys=True
        ).encode()
        nonce = os.urandom(12)
        encrypted = AESGCM(_group_metadata_key(self.room_id, self.secret)).encrypt(
            nonce, metadata, self.room_id
        )
        return f"{invite}.{_encode(nonce + encrypted)}"

    @classmethod
    def create(cls, group_name: str | None = None) -> Room:
        return cls(
            secrets.token_bytes(16),
            secrets.token_bytes(32),
            normalize_group_name(group_name) if group_name is not None else None,
        )

    @classmethod
    def from_invite(cls, invite: str) -> Room:
        if not isinstance(invite, str):
            raise ValueError("Invalid MeshTalk room invite")
        is_group = invite.startswith(GROUP_INVITE_PREFIX)
        prefix = GROUP_INVITE_PREFIX if is_group else INVITE_PREFIX
        if not invite.startswith(prefix):
            raise ValueError("Invalid MeshTalk room invite")
        try:
            parts = invite[len(prefix):].split(".")
            if len(parts) != (3 if is_group else 2):
                raise ValueError("Invalid invite fields")
            room_id, secret = _decode(parts[0]), _decode(parts[1])
            group_name = None
            if is_group:
                encrypted = _decode(parts[2])
                if len(encrypted) < 28:
                    raise ValueError("Truncated group metadata")
                plaintext = AESGCM(_group_metadata_key(room_id, secret)).decrypt(
                    encrypted[:12], encrypted[12:], room_id
                )
                metadata = json.loads(plaintext)
                if metadata.get("version") != 1:
                    raise ValueError("Unsupported group metadata")
                group_name = normalize_group_name(metadata.get("group_name"))
            room = cls(room_id, secret, group_name)
        except Exception as exc:
            raise ValueError("Invalid MeshTalk room invite") from exc
        if len(room.room_id) != 16 or len(room.secret) != 32:
            raise ValueError("Invalid MeshTalk room invite")
        return room


class Settings:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._control_url = ""
        self._control_pinned_ip: str | None = None
        self._control_setup_dismissed = False
        self._identity_setup_dismissed = False
        self._stun_host = DEFAULT_STUN_HOST
        self._stun_port = DEFAULT_STUN_PORT
        self._stun_pinned_ip: str | None = None
        self.rooms: dict[str, Room] = {}
        self.muted_peers: dict[str, float] = {}
        self._load()

    @property
    def control_url(self) -> str:
        configured = os.environ.get("MESHTALK_CONTROL_URL", self._control_url)
        return self._validate_control_url(configured) if configured else ""

    @property
    def stun_server(self) -> tuple[str, int]:
        configured = os.environ.get("MESHTALK_STUN_SERVER")
        if configured:
            host, separator, port = configured.rpartition(":")
            if not separator or not host:
                raise ValueError("MESHTALK_STUN_SERVER must be host:port")
            return host, int(port)
        return self._stun_host, self._stun_port

    def set_control_url(self, url: str) -> None:
        self._control_url = self._validate_control_url(url)
        self._control_setup_dismissed = True
        self.save()

    @property
    def control_pinned_ip(self) -> str | None:
        return self._control_pinned_ip

    def set_control_pinned_ip(self, ip: str) -> None:
        self._control_pinned_ip = self._validate_pinned_ip(ip)
        self.save()

    def clear_control_pinned_ip(self) -> None:
        self._control_pinned_ip = None
        self.save()

    @property
    def stun_pinned_ip(self) -> str | None:
        return self._stun_pinned_ip

    def set_stun_pinned_ip(self, ip: str) -> None:
        value = self._validate_pinned_ip(ip)
        if not isinstance(ipaddress.ip_address(value), ipaddress.IPv4Address):
            raise ValueError("STUN pinned IP must be IPv4")
        self._stun_pinned_ip = value
        self.save()

    def clear_stun_pinned_ip(self) -> None:
        self._stun_pinned_ip = None
        self.save()

    @property
    def control_setup_dismissed(self) -> bool:
        return self._control_setup_dismissed

    def dismiss_control_setup(self) -> None:
        self._control_setup_dismissed = True
        self.save()

    @property
    def identity_setup_dismissed(self) -> bool:
        return self._identity_setup_dismissed

    def dismiss_identity_setup(self) -> None:
        self._identity_setup_dismissed = True
        self.save()

    @staticmethod
    def _validate_control_url(url: str) -> str:
        url = url.strip().rstrip("/")
        parsed = urlparse(url)
        if parsed.scheme not in ("ws", "wss") or not parsed.hostname:
            raise ValueError("Control URL must use ws:// or wss://")
        if parsed.scheme == "ws" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("Remote control URLs must use wss://")
        return url

    @staticmethod
    def _validate_pinned_ip(ip: str) -> str:
        if not isinstance(ip, str):
            raise ValueError("Pinned IP must be a string")
        try:
            return str(ipaddress.ip_address(ip.strip()))
        except ValueError as exc:
            raise ValueError("Pinned IP must be a valid IP address") from exc

    def create_room(self, group_name: str | None = None) -> Room:
        room = Room.create(group_name)
        self.rooms[room.id] = room
        self.save()
        return room

    def join_room(self, invite: str) -> Room:
        room = Room.from_invite(invite)
        existing = self.rooms.get(room.id)
        if existing and existing != room:
            raise ValueError("Invite conflicts with the existing room")
        self.rooms[room.id] = room
        self.save()
        return room

    def leave_room(self, room_id: str) -> None:
        if room_id not in self.rooms:
            raise ValueError("Unknown room ID")
        del self.rooms[room_id]
        self.save()

    def mute_peer(self, peer_id: str, until: float = 0) -> None:
        self.muted_peers[peer_id] = until
        self.save()

    def unmute_peer(self, peer_id: str) -> None:
        self.muted_peers.pop(peer_id, None)
        self.save()

    def is_peer_muted(self, peer_id: str) -> bool:
        until = self.muted_peers.get(peer_id)
        if until is None:
            return False
        if until > 0 and time.time() >= until:
            del self.muted_peers[peer_id]
            self.save()
            return False
        return True

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "version": 1,
            "control_url": self._control_url,
            "control_pinned_ip": self._control_pinned_ip,
            "control_setup_dismissed": self._control_setup_dismissed,
            "identity_setup_dismissed": self._identity_setup_dismissed,
            "stun_server": {"host": self._stun_host, "port": self._stun_port},
            "stun_pinned_ip": self._stun_pinned_ip,
            "rooms": [
                {
                    "room_id": _encode(room.room_id),
                    "secret": _encode(room.secret),
                    "group_name": room.group_name,
                }
                for room in self.rooms.values()
            ],
            "muted_peers": self.muted_peers,
        }
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, indent=2))
        temporary.chmod(0o600)
        temporary.replace(self.path)

    def _load(self) -> None:
        if not self.path.exists():
            return
        self.path.chmod(0o600)
        data = json.loads(self.path.read_text())
        if data.get("version") != 1:
            raise ValueError("Unsupported settings version")
        self._control_url = data.get("control_url", "")
        control_pinned_ip = data.get("control_pinned_ip")
        self._control_pinned_ip = (
            self._validate_pinned_ip(control_pinned_ip) if control_pinned_ip is not None else None
        )
        self._control_setup_dismissed = bool(data.get("control_setup_dismissed", False))
        self._identity_setup_dismissed = bool(data.get("identity_setup_dismissed", False))
        if self._control_url:
            self._control_url = self._validate_control_url(self._control_url)
        stun = data.get("stun_server", {})
        self._stun_host = stun.get("host", DEFAULT_STUN_HOST)
        self._stun_port = int(stun.get("port", DEFAULT_STUN_PORT))
        stun_pinned_ip = data.get("stun_pinned_ip")
        if stun_pinned_ip is not None:
            value = self._validate_pinned_ip(stun_pinned_ip)
            if not isinstance(ipaddress.ip_address(value), ipaddress.IPv4Address):
                raise ValueError("STUN pinned IP must be IPv4")
            self._stun_pinned_ip = value
        for item in data.get("rooms", []):
            group_name = item.get("group_name")
            room = Room(
                _decode(item["room_id"]),
                _decode(item["secret"]),
                normalize_group_name(group_name) if group_name is not None else None,
            )
            if len(room.room_id) != 16 or len(room.secret) != 32:
                raise ValueError("Invalid room in settings")
            self.rooms[room.id] = room
        raw_mutes = data.get("muted_peers", {})
        now = time.time()
        for peer_id, until in raw_mutes.items():
            if not isinstance(peer_id, str) or not isinstance(until, (int, float)):
                continue
            if until <= 0 or now < until:
                self.muted_peers[peer_id] = float(until)
