"""Persistent control-service and private room configuration."""

from __future__ import annotations

import base64
import ipaddress
import json
import os
import secrets
import tempfile
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
    """Validate and normalize a group name, raising ValueError if invalid."""
    if not isinstance(value, str):
        raise ValueError("Group name required")
    name = value.strip()
    if not name or len(name) > MAX_GROUP_NAME_LENGTH or any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise ValueError(f"Group name must be 1-{MAX_GROUP_NAME_LENGTH} printable characters")
    return name


@dataclass(frozen=True)
class Room:
    """A private rendezvous room, optionally with group chat capabilities."""
    room_id: bytes
    secret: bytes
    group_name: str | None = None

    @property
    def id(self) -> str:
        """Return the room ID as a hex string."""
        return self.room_id.hex()

    @property
    def invite(self) -> str:
        """Generate an invite link for this room."""
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
        """Create a new room with random credentials and optional group name."""
        return cls(
            secrets.token_bytes(16),
            secrets.token_bytes(32),
            normalize_group_name(group_name) if group_name is not None else None,
        )

    @classmethod
    def from_invite(cls, invite: str) -> Room:
        """Parse and validate a room invite link, returning a Room instance."""
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
    """Persistent configuration including control server, rooms, and user preferences."""

    def __init__(self, path: Path) -> None:
        """Initialize settings from a JSON file, creating default values if file doesn't exist."""
        self.path = path
        self._control_url = ""
        self._control_pinned_ips: tuple[str, ...] = ()
        self._control_setup_dismissed = False
        self._identity_setup_dismissed = False
        self._flashing_enabled = True
        self._notification_setup_dismissed = False
        self._notification_delivery = "terminal"
        self._notification_events = {
            "messages": True,
            "friend_requests": True,
            "file_offers": True,
            "file_completed": True,
        }
        self._github_token = ""
        self._stun_host = DEFAULT_STUN_HOST
        self._stun_port = DEFAULT_STUN_PORT
        self._stun_pinned_ips: tuple[str, ...] = ()
        self.rooms: dict[str, Room] = {}
        self.muted_peers: dict[str, float] = {}
        self._files_dir: str | None = None
        self._load()

    @property
    def files_dir(self) -> Path:
        """Return the files storage directory, checking environment variable first."""
        # Env var takes precedence (cross-platform: C:\, E:\, /mnt/e, ~/ )
        env = os.environ.get("MESHTALK_FILES_DIR")
        if env and env.strip():
            return Path(env.strip()).expanduser()
        if self._files_dir:
            return Path(self._files_dir).expanduser()
        # Default: alongside settings.json (DATA_DIR/files) - respects MESHTALK_DATA_DIR if used
        return self.path.parent / "files"

    def set_files_dir(self, path_str: str) -> Path:
        """Set the files storage directory after validation."""
        if not isinstance(path_str, str) or not path_str.strip():
            raise ValueError("files_dir must be a non-empty path")
        raw = path_str.strip().strip('"').strip("'")
        p = Path(raw).expanduser()
        if not p.is_absolute():
            # Resolve relative against parent of settings (DATA_DIR) or cwd for consistency
            p = (self.path.parent / p).resolve() if self.path.parent.exists() else (Path.cwd() / p).resolve()
        # Validate: try to create parent and check writable (cross-platform)
        try:
            p.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=p, prefix=".meshtalk-", delete=True) as test:
                test.write(b"test")
                test.flush()
        except Exception as exc:
            raise ValueError(f"Cannot use files directory '{p}': {exc}") from exc
        self._files_dir = str(p.resolve() if p.exists() else p)
        self.save()
        return Path(self._files_dir)

    def clear_files_dir(self) -> None:
        """Reset files directory to default."""
        self._files_dir = None
        self.save()

    @property
    def control_url(self) -> str:
        """Return the control server URL, checking environment variable first."""
        configured = os.environ.get("MESHTALK_CONTROL_URL", self._control_url)
        return self._validate_control_url(configured) if configured else ""

    @property
    def stun_server(self) -> tuple[str, int]:
        """Return the STUN server host and port."""
        configured = os.environ.get("MESHTALK_STUN_SERVER")
        if configured:
            host, separator, port = configured.rpartition(":")
            if not separator or not host:
                raise ValueError("MESHTALK_STUN_SERVER must be host:port")
            return host, int(port)
        return self._stun_host, self._stun_port

    def set_control_url(self, url: str) -> None:
        """Set and validate the control server URL."""
        self._control_url = self._validate_control_url(url)
        self._control_setup_dismissed = True
        self.save()

    @property
    def control_pinned_ips(self) -> tuple[str, ...]:
        """Return the pinned control server IP addresses."""
        return self._control_pinned_ips

    def set_control_pinned_ips(self, ips: str) -> None:
        """Set pinned IP addresses for the control server."""
        self._control_pinned_ips = self._validate_pinned_ips(ips)
        self.save()

    def clear_control_pinned_ips(self) -> None:
        """Clear pinned control server IP addresses."""
        self._control_pinned_ips = ()
        self.save()

    @property
    def stun_pinned_ips(self) -> tuple[str, ...]:
        """Return the pinned STUN server IP addresses."""
        return self._stun_pinned_ips

    def set_stun_pinned_ips(self, ips: str) -> None:
        """Set pinned IPv4 addresses for the STUN server."""
        values = self._validate_pinned_ips(ips)
        if any(not isinstance(ipaddress.ip_address(value), ipaddress.IPv4Address) for value in values):
            raise ValueError("STUN pinned IPs must be IPv4")
        self._stun_pinned_ips = values
        self.save()

    def clear_stun_pinned_ips(self) -> None:
        """Clear pinned STUN server IP addresses."""
        self._stun_pinned_ips = ()
        self.save()

    @property
    def control_setup_dismissed(self) -> bool:
        """Return whether the control server setup prompt has been dismissed."""
        return self._control_setup_dismissed

    def dismiss_control_setup(self) -> None:
        """Mark the control server setup prompt as dismissed."""
        self._control_setup_dismissed = True
        self.save()

    @property
    def identity_setup_dismissed(self) -> bool:
        """Return whether the identity setup prompt has been dismissed."""
        return self._identity_setup_dismissed

    def dismiss_identity_setup(self) -> None:
        """Mark the identity setup prompt as dismissed."""
        self._identity_setup_dismissed = True
        self.save()

    @property
    def flashing_enabled(self) -> bool:
        """Return whether screen flashing effects are enabled for accessibility."""
        return self._flashing_enabled

    def set_flashing_enabled(self, enabled: bool) -> None:
        """Enable or disable screen flashing effects."""
        self._flashing_enabled = enabled
        self.save()

    @property
    def github_token(self) -> str:
        """Return the stored GitHub personal access token."""
        return self._github_token

    def set_github_token(self, token: str) -> None:
        """Set the GitHub personal access token."""
        if not isinstance(token, str):
            raise ValueError("GitHub token must be a string")
        self._github_token = token.strip()
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
    def _validate_pinned_ips(ips: str) -> tuple[str, ...]:
        if not isinstance(ips, str):
            raise ValueError("Pinned IPs must be a comma-separated string")
        values = []
        for value in ips.split(","):
            try:
                normalized = str(ipaddress.ip_address(value.strip()))
            except ValueError as exc:
                raise ValueError("Each pinned value must be a valid IP address") from exc
            if normalized not in values:
                values.append(normalized)
        if not values:
            raise ValueError("At least one pinned IP is required")
        return tuple(values)

    def create_room(self, group_name: str | None = None) -> Room:
        """Create a new private room with optional group chat capability."""
        room = Room.create(group_name)
        self.rooms[room.id] = room
        self.save()
        return room

    def join_room(self, invite: str) -> Room:
        """Join a room using an invite link."""
        room = Room.from_invite(invite)
        existing = self.rooms.get(room.id)
        if existing and existing != room:
            raise ValueError("Invite conflicts with the existing room")
        self.rooms[room.id] = room
        self.save()
        return room

    def leave_room(self, room_id: str) -> None:
        """Leave and remove a room from settings."""
        if room_id not in self.rooms:
            raise ValueError("Unknown room ID")
        del self.rooms[room_id]
        self.save()

    def mute_peer(self, peer_id: str, until: float = 0) -> None:
        """Mute a peer until the specified timestamp (0 for permanent)."""
        self.muted_peers[peer_id] = until
        self.save()

    def unmute_peer(self, peer_id: str) -> None:
        """Unmute a previously muted peer."""
        self.muted_peers.pop(peer_id, None)
        self.save()

    def is_peer_muted(self, peer_id: str) -> bool:
        """Check if a peer is currently muted."""
        until = self.muted_peers.get(peer_id)
        if until is None:
            return False
        if until > 0 and time.time() >= until:
            del self.muted_peers[peer_id]
            self.save()
            return False
        return True

    @property
    def notification_preferences(self) -> dict:
        """Return notification preferences including delivery method and event filters."""
        return {
            "setup_dismissed": self._notification_setup_dismissed,
            "delivery": self._notification_delivery,
            "events": dict(self._notification_events),
        }

    def set_notification_preferences(
        self,
        *,
        setup_dismissed: bool | None = None,
        delivery: str | None = None,
        events: dict[str, bool] | None = None,
    ) -> None:
        """Update notification preferences."""
        if setup_dismissed is not None:
            self._notification_setup_dismissed = setup_dismissed
        if delivery is not None:
            if delivery not in {"terminal", "native", "disabled"}:
                raise ValueError("notification delivery must be terminal, native, or disabled")
            self._notification_delivery = delivery
        if events is not None:
            valid_events = set(self._notification_events)
            if set(events) - valid_events or any(not isinstance(enabled, bool) for enabled in events.values()):
                raise ValueError("notification events must contain boolean known event values")
            self._notification_events.update(events)
        self.save()

    def save(self) -> None:
        """Save settings to disk as a JSON file."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "version": 1,
            "control_url": self._control_url,
            "control_pinned_ips": list(self._control_pinned_ips),
            "control_setup_dismissed": self._control_setup_dismissed,
            "identity_setup_dismissed": self._identity_setup_dismissed,
            "flashing_enabled": self._flashing_enabled,
            "notifications": self.notification_preferences,
            "github_token": self._github_token,
            "stun_server": {"host": self._stun_host, "port": self._stun_port},
            "stun_pinned_ips": list(self._stun_pinned_ips),
            "rooms": [
                {
                    "room_id": _encode(room.room_id),
                    "secret": _encode(room.secret),
                    "group_name": room.group_name,
                }
                for room in self.rooms.values()
            ],
            "muted_peers": self.muted_peers,
            "files_dir": self._files_dir,
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
        control_pinned_ips = data.get("control_pinned_ips", data.get("control_pinned_ip"))
        if control_pinned_ips is not None:
            if isinstance(control_pinned_ips, list):
                if control_pinned_ips:
                    control_pinned_ips = ",".join(control_pinned_ips)
                else:
                    control_pinned_ips = None
            if control_pinned_ips is not None:
                self._control_pinned_ips = self._validate_pinned_ips(control_pinned_ips)
        self._control_setup_dismissed = bool(data.get("control_setup_dismissed", False))
        self._identity_setup_dismissed = bool(data.get("identity_setup_dismissed", False))
        self._flashing_enabled = bool(data.get("flashing_enabled", True))
        notifications = data.get("notifications", {})
        if isinstance(notifications, dict):
            self._notification_setup_dismissed = bool(notifications.get("setup_dismissed", False))
            delivery = notifications.get("delivery")
            if delivery in {"terminal", "native", "disabled"}:
                self._notification_delivery = delivery
            events = notifications.get("events")
            if isinstance(events, dict):
                for event in self._notification_events:
                    if isinstance(events.get(event), bool):
                        self._notification_events[event] = events[event]
        self._github_token = data.get("github_token", "") if isinstance(data.get("github_token", ""), str) else ""
        if self._control_url:
            self._control_url = self._validate_control_url(self._control_url)
        stun = data.get("stun_server", {})
        self._stun_host = stun.get("host", DEFAULT_STUN_HOST)
        self._stun_port = int(stun.get("port", DEFAULT_STUN_PORT))
        stun_pinned_ips = data.get("stun_pinned_ips", data.get("stun_pinned_ip"))
        if stun_pinned_ips is not None:
            if isinstance(stun_pinned_ips, list):
                if stun_pinned_ips:
                    stun_pinned_ips = ",".join(stun_pinned_ips)
                else:
                    stun_pinned_ips = None
            if stun_pinned_ips is not None:
                values = self._validate_pinned_ips(stun_pinned_ips)
                if any(not isinstance(ipaddress.ip_address(value), ipaddress.IPv4Address) for value in values):
                    raise ValueError("STUN pinned IPs must be IPv4")
                self._stun_pinned_ips = values
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
        files_dir = data.get("files_dir")
        if isinstance(files_dir, str) and files_dir.strip():
            # Validate but don't fail load if old path no longer exists - keep stored value
            self._files_dir = files_dir.strip()
