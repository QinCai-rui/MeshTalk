"""Persistent control-service and private room configuration."""

from __future__ import annotations

import base64
import json
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

DEFAULT_STUN_HOST = "stun.l.google.com"
DEFAULT_STUN_PORT = 19302
INVITE_PREFIX = "meshtalk:"
GROUP_INVITE_PREFIX = "meshtalk-group:"
MAX_GROUP_NAME_LENGTH = 80
MAX_GROUP_MEMBERS = 64


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _canonical(value: dict) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


@dataclass(frozen=True)
class Room:
    room_id: bytes
    secret: bytes
    name: str = "Untitled group"
    owner_id: str = ""
    owner_signing_public_key: bytes = b""
    epoch: int = 1
    invite_signature: bytes = b""

    @property
    def id(self) -> str:
        return self.room_id.hex()

    @property
    def invite(self) -> str:
        if self.owner_id and self.owner_signing_public_key and self.invite_signature:
            payload = {
                "version": 1,
                "group_id": self.id,
                "secret": _encode(self.secret),
                "name": self.name,
                "owner_id": self.owner_id,
                "owner_key": self.owner_signing_public_key.hex(),
                "epoch": self.epoch,
            }
            envelope = {"payload": payload, "signature": self.invite_signature.hex()}
            encoded = _encode(json.dumps(envelope, separators=(",", ":")).encode())
            return f"{GROUP_INVITE_PREFIX}{encoded}"
        return f"{INVITE_PREFIX}{_encode(self.room_id)}.{_encode(self.secret)}"

    @classmethod
    def create(
        cls,
        name: str = "Untitled group",
        owner_id: str = "",
        owner_signing_public_key: bytes = b"",
        signing_private_key: Ed25519PrivateKey | None = None,
    ) -> Room:
        name = cls.normalize_name(name)
        room = cls(secrets.token_bytes(16), secrets.token_bytes(32), name, owner_id, owner_signing_public_key)
        if signing_private_key is not None:
            room = cls(**{**room.__dict__, "invite_signature": signing_private_key.sign(_canonical(room.invite_payload()))})
        return room

    @staticmethod
    def normalize_name(name: str | None) -> str:
        value = " ".join((name or "").strip().split())
        if not value:
            return "Untitled group"
        return value[:MAX_GROUP_NAME_LENGTH]

    def invite_payload(self) -> dict:
        return {
            "version": 1,
            "group_id": self.id,
            "secret": _encode(self.secret),
            "name": self.name,
            "owner_id": self.owner_id,
            "owner_key": self.owner_signing_public_key.hex(),
            "epoch": self.epoch,
        }

    @classmethod
    def from_invite(cls, invite: str) -> Room:
        if isinstance(invite, str) and invite.startswith(GROUP_INVITE_PREFIX):
            try:
                envelope = json.loads(_decode(invite[len(GROUP_INVITE_PREFIX):]))
                payload = envelope["payload"]
                signature = bytes.fromhex(envelope["signature"])
                owner_key = bytes.fromhex(payload["owner_key"])
                if len(owner_key) != 32 or len(signature) != 64:
                    raise ValueError("Invalid group invite signature")
                from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
                Ed25519PublicKey.from_public_bytes(owner_key).verify(signature, _canonical(payload))
                room = cls(
                    bytes.fromhex(payload["group_id"]), _decode(payload["secret"]),
                    cls.normalize_name(payload.get("name")), payload["owner_id"], owner_key,
                    int(payload.get("epoch", 1)), signature,
                )
            except Exception as exc:
                raise ValueError("Invalid MeshTalk group invite") from exc
            if len(room.room_id) != 16 or len(room.secret) != 32 or room.epoch < 1 or not room.owner_id:
                raise ValueError("Invalid MeshTalk group invite")
            return room
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
        self._identity_setup_dismissed = False
        self._stun_host = DEFAULT_STUN_HOST
        self._stun_port = DEFAULT_STUN_PORT
        self.rooms: dict[str, Room] = {}
        self.muted_peers: dict[str, float] = {}
        self.muted_groups: dict[str, float] = {}
        self._load()

    @property
    def groups(self) -> dict[str, Room]:
        """Named-group view of the legacy room store."""
        return self.rooms

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

    def create_room(
        self,
        name: str = "Untitled group",
        owner_id: str = "",
        owner_signing_public_key: bytes = b"",
        signing_private_key: Ed25519PrivateKey | None = None,
    ) -> Room:
        room = Room.create(name, owner_id, owner_signing_public_key, signing_private_key)
        self.rooms[room.id] = room
        self.save()
        return room

    def create_group(
        self,
        name: str,
        owner_id: str,
        owner_signing_public_key: bytes,
        signing_private_key: Ed25519PrivateKey,
    ) -> Room:
        return self.create_room(name, owner_id, owner_signing_public_key, signing_private_key)

    def migrate_legacy_groups(
        self,
        owner_id: str,
        owner_signing_public_key: bytes,
        signing_private_key: Ed25519PrivateKey,
    ) -> int:
        """Upgrade pre-groups room records without changing their secret or ID."""
        migrated = 0
        for group_id, room in list(self.rooms.items()):
            if room.owner_id:
                continue
            upgraded = Room(room.room_id, room.secret, room.name or "Untitled group", owner_id, owner_signing_public_key, room.epoch)
            upgraded = Room(**{**upgraded.__dict__, "invite_signature": signing_private_key.sign(_canonical(upgraded.invite_payload()))})
            self.rooms[group_id] = upgraded
            migrated += 1
        if migrated:
            self.save()
        return migrated

    def join_room(self, invite: str) -> Room:
        room = Room.from_invite(invite)
        self.rooms[room.id] = room
        self.save()
        return room

    def join_group(self, invite: str) -> Room:
        return self.join_room(invite)

    def rename_group(self, group_id: str, name: str) -> Room:
        room = self.rooms.get(group_id)
        if room is None:
            raise ValueError("Unknown group ID")
        updated = Room(
            room.room_id, room.secret, Room.normalize_name(name), room.owner_id,
            room.owner_signing_public_key, room.epoch, room.invite_signature,
        )
        self.rooms[group_id] = updated
        self.save()
        return updated

    def rotate_group(self, group_id: str, secret: bytes, epoch: int, signing_private_key: Ed25519PrivateKey) -> Room:
        room = self.rooms.get(group_id)
        if room is None:
            raise ValueError("Unknown group ID")
        updated = Room(room.room_id, secret, room.name, room.owner_id, room.owner_signing_public_key, epoch)
        updated = Room(**{**updated.__dict__, "invite_signature": signing_private_key.sign(_canonical(updated.invite_payload()))})
        self.rooms[group_id] = updated
        self.save()
        return updated

    def apply_group_rekey(self, group_id: str, secret: bytes, epoch: int) -> Room:
        room = self.rooms.get(group_id)
        if room is None:
            raise ValueError("Unknown group ID")
        if len(secret) != 32 or epoch < room.epoch:
            raise ValueError("Invalid group rekey")
        updated = Room(room.room_id, secret, room.name, room.owner_id, room.owner_signing_public_key, epoch, room.invite_signature)
        self.rooms[group_id] = updated
        self.save()
        return updated

    def leave_room(self, room_id: str) -> None:
        if room_id not in self.rooms:
            raise ValueError("Unknown room ID")
        del self.rooms[room_id]
        self.save()

    def mute_peer(self, peer_id: str, until: float = 0) -> None:
        self.muted_peers[peer_id] = until
        self.save()

    def mute_group(self, group_id: str, until: float = 0) -> None:
        self.muted_groups[group_id] = until
        self.save()

    def unmute_group(self, group_id: str) -> None:
        self.muted_groups.pop(group_id, None)
        self.save()

    def is_group_muted(self, group_id: str) -> bool:
        until = self.muted_groups.get(group_id)
        if until is None:
            return False
        if until > 0 and time.time() >= until:
            del self.muted_groups[group_id]
            self.save()
            return False
        return True

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
            "control_setup_dismissed": self._control_setup_dismissed,
            "identity_setup_dismissed": self._identity_setup_dismissed,
            "stun_server": {"host": self._stun_host, "port": self._stun_port},
            "rooms": [
                {
                    "room_id": _encode(room.room_id), "secret": _encode(room.secret),
                    "name": room.name, "owner_id": room.owner_id,
                    "owner_signing_public_key": room.owner_signing_public_key.hex(),
                    "epoch": room.epoch, "invite_signature": room.invite_signature.hex(),
                }
                for room in self.rooms.values()
            ],
            "muted_peers": self.muted_peers,
            "muted_groups": self.muted_groups,
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
        self._identity_setup_dismissed = bool(data.get("identity_setup_dismissed", False))
        if self._control_url:
            self._control_url = self._validate_control_url(self._control_url)
        stun = data.get("stun_server", {})
        self._stun_host = stun.get("host", DEFAULT_STUN_HOST)
        self._stun_port = int(stun.get("port", DEFAULT_STUN_PORT))
        for item in data.get("rooms", []):
            room = Room(
                _decode(item["room_id"]), _decode(item["secret"]),
                Room.normalize_name(item.get("name")), item.get("owner_id", ""),
                bytes.fromhex(item.get("owner_signing_public_key", "")),
                int(item.get("epoch", 1)), bytes.fromhex(item.get("invite_signature", "")),
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
        raw_group_mutes = data.get("muted_groups", {})
        for group_id, until in raw_group_mutes.items():
            if not isinstance(group_id, str) or not isinstance(until, (int, float)):
                continue
            if until <= 0 or now < until:
                self.muted_groups[group_id] = float(until)
