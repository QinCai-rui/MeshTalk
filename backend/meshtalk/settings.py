"""Persistent control-service and private room configuration."""

from __future__ import annotations

import base64
import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_STUN_HOST = "stun.l.google.com"
DEFAULT_STUN_PORT = 19302
INVITE_PREFIX = "meshtalk:"


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


@dataclass(frozen=True)
class Room:
    room_id: bytes
    secret: bytes

    @property
    def id(self) -> str:
        return self.room_id.hex()

    @property
    def invite(self) -> str:
        return f"{INVITE_PREFIX}{_encode(self.room_id)}.{_encode(self.secret)}"

    @classmethod
    def create(cls) -> Room:
        return cls(secrets.token_bytes(16), secrets.token_bytes(32))

    @classmethod
    def from_invite(cls, invite: str) -> Room:
        if not isinstance(invite, str) or not invite.startswith(INVITE_PREFIX):
            raise ValueError("Invalid MeshTalk room invite")
        try:
            room_id_text, secret_text = invite[len(INVITE_PREFIX):].split(".", 1)
            room = cls(_decode(room_id_text), _decode(secret_text))
        except Exception as exc:
            raise ValueError("Invalid MeshTalk room invite") from exc
        if len(room.room_id) != 16 or len(room.secret) != 32:
            raise ValueError("Invalid MeshTalk room invite")
        return room


class Settings:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._control_url = ""
        self._control_setup_dismissed = False
        self._stun_host = DEFAULT_STUN_HOST
        self._stun_port = DEFAULT_STUN_PORT
        self.rooms: dict[str, Room] = {}
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
    def control_setup_dismissed(self) -> bool:
        return self._control_setup_dismissed

    def dismiss_control_setup(self) -> None:
        self._control_setup_dismissed = True
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

    def create_room(self) -> Room:
        room = Room.create()
        self.rooms[room.id] = room
        self.save()
        return room

    def join_room(self, invite: str) -> Room:
        room = Room.from_invite(invite)
        self.rooms[room.id] = room
        self.save()
        return room

    def leave_room(self, room_id: str) -> None:
        if room_id not in self.rooms:
            raise ValueError("Unknown room ID")
        del self.rooms[room_id]
        self.save()

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "version": 1,
            "control_url": self._control_url,
            "control_setup_dismissed": self._control_setup_dismissed,
            "stun_server": {"host": self._stun_host, "port": self._stun_port},
            "rooms": [
                {"room_id": _encode(room.room_id), "secret": _encode(room.secret)}
                for room in self.rooms.values()
            ],
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
        self._control_setup_dismissed = bool(data.get("control_setup_dismissed", False))
        if self._control_url:
            self._control_url = self._validate_control_url(self._control_url)
        stun = data.get("stun_server", {})
        self._stun_host = stun.get("host", DEFAULT_STUN_HOST)
        self._stun_port = int(stun.get("port", DEFAULT_STUN_PORT))
        for item in data.get("rooms", []):
            room = Room(_decode(item["room_id"]), _decode(item["secret"]))
            if len(room.room_id) != 16 or len(room.secret) != 32:
                raise ValueError("Invalid room in settings")
            self.rooms[room.id] = room
