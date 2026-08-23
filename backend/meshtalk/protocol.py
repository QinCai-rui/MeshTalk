"""Wire protocol types and packet framing.

TCP framing: [4-byte length][1-byte type][payload]

Packet types:
  HANDSHAKE            0x01
  HANDSHAKE_ACK        0x02
  MESSAGE              0x03
  MESSAGE_ACK          0x04
  PING                 0x05
  PONG                 0x06
  GOODBYE              0x07
  PROFILE              0x08
  HANDSHAKE_CONFIRM    0x09
  FRIEND_REQUEST       0x0A
  FRIEND_REQUEST_RESPONSE 0x0B
  MESSAGE_BLOCKED      0x0C
  FRIEND_REQUEST_CANCELLED 0x0D
  GROUP_MESSAGE          0x0E
  GROUP_MESSAGE_ACK      0x0F
  GROUP_LEAVE            0x10
  TYPING                 0x14
"""

from __future__ import annotations

import enum
import hashlib
import json
import math
import re
import struct
from dataclasses import dataclass, field
from typing import Any

PROTOCOL_VERSION = 4
MIN_SUPPORTED_PROTOCOL_VERSION = 4

# Feature capability identifiers exchanged during the handshake. A connection
# only enables a capability when both peers advertise it (see
# ``intersect_capabilities``). They are informational until higher-level code
# gates behaviour on them via ``PeerConnection.supports``.
CAP_TEXT_CHAT = "text_chat"
CAP_PROFILE_SYNC = "profile_sync"
CAP_FRIEND_REQUESTS = "friend_requests"
CAP_DELIVERY_RECEIPTS = "delivery_receipts"
CAP_BLOCK_REPORTS = "block_reports"
CAP_GROUP_CHAT = "group_chat"
CAP_FILE_TRANSFER = "file_transfer"
CAP_TYPING_INDICATORS = "typing_indicators"
DEFAULT_CAPABILITIES = [
    CAP_TEXT_CHAT,
    CAP_PROFILE_SYNC,
    CAP_FRIEND_REQUESTS,
    CAP_DELIVERY_RECEIPTS,
    CAP_BLOCK_REPORTS,
    CAP_GROUP_CHAT,
    CAP_FILE_TRANSFER,
    CAP_TYPING_INDICATORS,
]
LEGACY_CAPABILITIES = [
    capability for capability in DEFAULT_CAPABILITIES
    if capability not in (CAP_GROUP_CHAT, CAP_FILE_TRANSFER, CAP_TYPING_INDICATORS)
]
# Capabilities that have a direct counterpart in this implementation. Unknown
# advertised capabilities remain in the signed handshake but are excluded from
# the negotiated set by ``intersect_capabilities``.
KNOWN_CAPABILITIES = frozenset(DEFAULT_CAPABILITIES)
UDP_PORT = 24890
TCP_PORT = 24891
MAX_PACKET_SIZE = 64 * 1024  # 64 KB
DISCOVERY_ID = re.compile(r"[a-f0-9]{32}")
HEADER_FORMAT = "!IB"  # 4-byte big-endian length + 1-byte type
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)


def negotiate_protocol_version(
    local_version: int,
    local_min: int,
    remote_version: int,
    remote_min: int,
) -> int | None:
    """Negotiate the highest mutually supported protocol version.

    Returns None if versions are incompatible.
    """
    agreed = min(local_version, remote_version)
    if agreed < max(local_min, remote_min):
        return None
    return agreed


def intersect_capabilities(local: list[str], remote: list[str]) -> list[str]:
    """Return the sorted set of capabilities supported by both peers.

    Unknown capabilities advertised by a peer are ignored so that future
    releases can introduce features without breaking older clients.
    """
    return sorted(set(local) & set(remote) & KNOWN_CAPABILITIES)


def validate_capabilities(capabilities: list[str]) -> list[str]:
    """Return capability strings received from a remote peer.

    Unknown capabilities must be retained until handshake signature verification;
    removing one would change the authenticated canonical payload. Unsupported
    capabilities are filtered later when the negotiated intersection is built.
    """
    if not isinstance(capabilities, list):
        return []
    return [cap for cap in capabilities if isinstance(cap, str)]


class IncompatibleProtocolError(ValueError):
    def __init__(
        self,
        peer_id: str,
        remote_version: int,
        remote_min: int,
        local_version: int = PROTOCOL_VERSION,
        local_min: int = MIN_SUPPORTED_PROTOCOL_VERSION,
    ) -> None:
        self.peer_id = peer_id
        self.remote_version = remote_version
        self.remote_min = remote_min
        self.local_version = local_version
        self.local_min = local_min
        super().__init__(
            f"Incompatible protocol version for peer {peer_id}: "
            f"remote (v{remote_version}, min v{remote_min}) vs local (v{local_version}, min v{local_min})"
        )


class PacketType(enum.IntEnum):
    HANDSHAKE = 0x01
    HANDSHAKE_ACK = 0x02
    MESSAGE = 0x03
    MESSAGE_ACK = 0x04
    PING = 0x05
    PONG = 0x06
    GOODBYE = 0x07
    PROFILE = 0x08
    HANDSHAKE_CONFIRM = 0x09
    FRIEND_REQUEST = 0x0A
    FRIEND_REQUEST_RESPONSE = 0x0B
    MESSAGE_BLOCKED = 0x0C
    FRIEND_REQUEST_CANCELLED = 0x0D
    GROUP_MESSAGE = 0x0E
    GROUP_MESSAGE_ACK = 0x0F
    GROUP_LEAVE = 0x10
    FILE_OFFER = 0x11
    FILE_CHUNK = 0x12
    FILE_ACK = 0x13
    TYPING = 0x14


@dataclass
class Packet:
    type: PacketType
    payload: bytes = field(default=b"")

    def encode(self) -> bytes:
        length = len(self.payload)
        if length > MAX_PACKET_SIZE:
            raise ValueError(f"Payload too large: {length} > {MAX_PACKET_SIZE}")
        header = struct.pack(HEADER_FORMAT, length, self.type)
        return header + self.payload

    @classmethod
    def decode_header(cls, data: bytes) -> tuple[int, PacketType]:
        if len(data) < HEADER_SIZE:
            raise ValueError(f"Header too short: {len(data)} < {HEADER_SIZE}")
        length, ptype = struct.unpack(HEADER_FORMAT, data)
        if length > MAX_PACKET_SIZE:
            raise ValueError(f"Packet too large: {length} > {MAX_PACKET_SIZE}")
        return length, PacketType(ptype)

    @classmethod
    def decode(cls, header_data: bytes, payload: bytes) -> Packet:
        length, ptype = cls.decode_header(header_data)
        if len(payload) != length:
            raise ValueError(f"Payload length mismatch: {len(payload)} != {length}")
        return cls(type=ptype, payload=payload)


@dataclass
class DiscoveryPacket:
    protocol: int
    discovery_id: str
    tcp_port: int
    min_protocol: int = MIN_SUPPORTED_PROTOCOL_VERSION

    def encode(self) -> bytes:
        import json
        return json.dumps({
            "protocol": self.protocol,
            "min_protocol": self.min_protocol,
            "discovery_id": self.discovery_id,
            "tcp_port": self.tcp_port,
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> DiscoveryPacket:
        import json
        obj = json.loads(data)
        if not isinstance(obj, dict):
            raise ValueError("Discovery packet must be an object")
        protocol = obj.get("protocol")
        min_protocol = obj.get("min_protocol", 0)
        discovery_id = obj.get("discovery_id")
        tcp_port = obj.get("tcp_port")
        if (
            not isinstance(protocol, int)
            or isinstance(protocol, bool)
            or not isinstance(min_protocol, int)
            or isinstance(min_protocol, bool)
            or not isinstance(discovery_id, str)
            or not DISCOVERY_ID.fullmatch(discovery_id)
            or not isinstance(tcp_port, int)
            or isinstance(tcp_port, bool)
            or not 1 <= tcp_port <= 65535
        ):
            raise ValueError("Invalid discovery packet")
        return cls(protocol=protocol, discovery_id=discovery_id, tcp_port=tcp_port, min_protocol=min_protocol)


@dataclass
class HandshakePayload:
    peer_id: str
    signing_public_key: bytes
    encryption_public_key: bytes
    display_name: str
    nonce: bytes
    challenge: bytes
    signature: bytes
    protocol_version: int = PROTOCOL_VERSION
    min_protocol_version: int = MIN_SUPPORTED_PROTOCOL_VERSION
    capabilities: list[str] = field(default_factory=lambda: list(DEFAULT_CAPABILITIES))
    legacy: bool = False

    def signed_bytes(self, legacy: bool = False) -> bytes:
        data = {
            "peer_id": self.peer_id,
            "signing_public_key": self.signing_public_key.hex(),
            "encryption_public_key": self.encryption_public_key.hex(),
            "display_name": self.display_name,
            "nonce": self.nonce.hex(),
            "challenge": self.challenge.hex(),
        }
        # The version/capability fields are only folded into the authenticated
        # canonical once we have actually negotiated a protocol version above 1.
        # This keeps v1 byte-for-byte compatible with prior releases (which
        # signed exactly these six fields) so mixed-version meshes keep working
        # during rolling upgrades.
        if not legacy and self.protocol_version > 1:
            data["protocol_version"] = self.protocol_version
            data["min_protocol_version"] = self.min_protocol_version
            data["capabilities"] = sorted(self.capabilities)
        return json.dumps(data, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        return json.dumps({
            "peer_id": self.peer_id,
            "signing_public_key": self.signing_public_key.hex(),
            "encryption_public_key": self.encryption_public_key.hex(),
            "display_name": self.display_name,
            "nonce": self.nonce.hex(),
            "challenge": self.challenge.hex(),
            "signature": self.signature.hex(),
            "protocol_version": self.protocol_version,
            "min_protocol_version": self.min_protocol_version,
            "capabilities": self.capabilities,
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> HandshakePayload:
        obj = json.loads(data)
        has_version = "protocol_version" in obj
        protocol_version = obj.get("protocol_version", 0)
        min_protocol_version = obj.get("min_protocol_version", 0)
        capabilities = validate_capabilities(obj.get("capabilities", list(LEGACY_CAPABILITIES)))
        payload = cls(
            peer_id=obj["peer_id"],
            signing_public_key=bytes.fromhex(obj["signing_public_key"]),
            encryption_public_key=bytes.fromhex(obj["encryption_public_key"]),
            display_name=obj["display_name"],
            nonce=bytes.fromhex(obj["nonce"]),
            challenge=bytes.fromhex(obj["challenge"]),
            signature=bytes.fromhex(obj["signature"]),
            protocol_version=protocol_version,
            min_protocol_version=min_protocol_version,
            capabilities=capabilities,
        )
        payload.legacy = not has_version
        if len(payload.signing_public_key) != 32 or len(payload.encryption_public_key) != 32:
            raise ValueError("Invalid handshake public key length")
        if len(payload.nonce) != 32 or len(payload.challenge) not in (0, 32) or len(payload.signature) != 64:
            raise ValueError("Invalid handshake nonce, challenge, or signature")
        return payload


@dataclass
class ProfilePayload:
    """An authenticated display-name update for an established peer connection."""

    peer_id: str
    display_name: str
    tui_active: bool
    signature: bytes

    def signed_bytes(self) -> bytes:
        return json.dumps({
            "peer_id": self.peer_id,
            "display_name": self.display_name,
            "tui_active": self.tui_active,
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        return json.dumps({
            "peer_id": self.peer_id,
            "display_name": self.display_name,
            "tui_active": self.tui_active,
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> ProfilePayload:
        obj = json.loads(data)
        payload = cls(
            peer_id=obj["peer_id"],
            display_name=obj["display_name"],
            tui_active=obj["tui_active"],
            signature=bytes.fromhex(obj["signature"]),
        )
        if not isinstance(payload.tui_active, bool) or len(payload.signature) != 64:
            raise ValueError("Invalid profile signature")
        return payload


@dataclass
class MessagePayload:
    message_id: str
    sender_id: str
    recipient_id: str
    created_at: float
    hop_count: int
    max_hops: int
    encrypted_content: bytes
    signature: bytes = b""

    def associated_data(self) -> bytes:
        """Immutable routing metadata authenticated by AES-GCM and sender signature."""
        return json.dumps({
            "message_id": self.message_id,
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "created_at": self.created_at,
        }, separators=(",", ":"), sort_keys=True).encode()

    def signed_bytes(self) -> bytes:
        return hashlib.sha256(self.associated_data() + self.encrypted_content).digest()

    def encode(self) -> bytes:
        return json.dumps({
            "message_id": self.message_id,
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "created_at": self.created_at,
            "hop_count": self.hop_count,
            "max_hops": self.max_hops,
            "encrypted_content": self.encrypted_content.hex(),
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> MessagePayload:
        obj = json.loads(data)
        return cls(
            message_id=obj["message_id"],
            sender_id=obj["sender_id"],
            recipient_id=obj["recipient_id"],
            created_at=obj["created_at"],
            hop_count=obj["hop_count"],
            max_hops=obj["max_hops"],
            encrypted_content=bytes.fromhex(obj["encrypted_content"]),
            signature=bytes.fromhex(obj.get("signature", "")),
        )


@dataclass
class GroupMessagePayload:
    message_id: str
    group_id: str
    sender_id: str
    recipient_id: str
    created_at: float
    encrypted_content: bytes
    signature: bytes = b""

    def associated_data(self) -> bytes:
        return json.dumps({
            "message_id": self.message_id,
            "group_id": self.group_id,
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "created_at": self.created_at,
        }, separators=(",", ":"), sort_keys=True).encode()

    def signed_bytes(self) -> bytes:
        return hashlib.sha256(self.associated_data() + self.encrypted_content).digest()

    def encode(self) -> bytes:
        return json.dumps({
            "message_id": self.message_id,
            "group_id": self.group_id,
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "created_at": self.created_at,
            "encrypted_content": self.encrypted_content.hex(),
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> GroupMessagePayload:
        obj = json.loads(data)
        payload = cls(
            message_id=obj["message_id"],
            group_id=obj["group_id"],
            sender_id=obj["sender_id"],
            recipient_id=obj["recipient_id"],
            created_at=obj["created_at"],
            encrypted_content=bytes.fromhex(obj["encrypted_content"]),
            signature=bytes.fromhex(obj.get("signature", "")),
        )
        if (
            not _valid_request_id(payload.message_id)
            or not isinstance(payload.group_id, str)
            or not re.fullmatch(r"[a-f0-9]{32}", payload.group_id)
            or not _valid_peer_id(payload.sender_id)
            or not _valid_peer_id(payload.recipient_id)
            or not isinstance(payload.created_at, (int, float))
            or isinstance(payload.created_at, bool)
            or not math.isfinite(payload.created_at)
            or payload.created_at <= 0
            or len(payload.signature) != 64
        ):
            raise ValueError("Invalid group message payload")
        return payload


@dataclass
class TypingPayload:
    """A signed envelope whose conversation context is encrypted per recipient."""

    sender_id: str
    recipient_id: str
    created_at: float
    encrypted_content: bytes
    signature: bytes = b""

    def associated_data(self) -> bytes:
        return json.dumps({
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "created_at": self.created_at,
        }, separators=(",", ":"), sort_keys=True).encode()

    def signed_bytes(self) -> bytes:
        return hashlib.sha256(self.associated_data() + self.encrypted_content).digest()

    def encode(self) -> bytes:
        return json.dumps({
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "created_at": self.created_at,
            "encrypted_content": self.encrypted_content.hex(),
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> TypingPayload:
        obj = json.loads(data)
        payload = cls(
            sender_id=obj["sender_id"],
            recipient_id=obj["recipient_id"],
            created_at=obj["created_at"],
            encrypted_content=bytes.fromhex(obj["encrypted_content"]),
            signature=bytes.fromhex(obj.get("signature", "")),
        )
        if (
            not _valid_peer_id(payload.sender_id)
            or not _valid_peer_id(payload.recipient_id)
            or not isinstance(payload.created_at, (int, float))
            or isinstance(payload.created_at, bool)
            or len(payload.signature) != 64
        ):
            raise ValueError("Invalid typing payload")
        return payload


@dataclass
class GroupAckPayload:
    message_id: str
    group_id: str
    recipient_id: str
    signature: bytes = b""

    def signed_bytes(self) -> bytes:
        return json.dumps({
            "message_id": self.message_id,
            "group_id": self.group_id,
            "recipient_id": self.recipient_id,
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        return json.dumps({
            "message_id": self.message_id,
            "group_id": self.group_id,
            "recipient_id": self.recipient_id,
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> GroupAckPayload:
        obj = json.loads(data)
        payload = cls(
            message_id=obj["message_id"],
            group_id=obj["group_id"],
            recipient_id=obj["recipient_id"],
            signature=bytes.fromhex(obj.get("signature", "")),
        )
        if (
            not _valid_request_id(payload.message_id)
            or not re.fullmatch(r"[a-f0-9]{32}", payload.group_id)
            or not _valid_peer_id(payload.recipient_id)
            or len(payload.signature) != 64
        ):
            raise ValueError("Invalid group acknowledgement")
        return payload


@dataclass
class GroupLeavePayload:
    event_id: str
    group_id: str
    peer_id: str
    created_at: float
    signature: bytes = b""

    def signed_bytes(self) -> bytes:
        return json.dumps({
            "event_id": self.event_id,
            "group_id": self.group_id,
            "peer_id": self.peer_id,
            "created_at": self.created_at,
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        return json.dumps({
            "event_id": self.event_id,
            "group_id": self.group_id,
            "peer_id": self.peer_id,
            "created_at": self.created_at,
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> GroupLeavePayload:
        obj = json.loads(data)
        payload = cls(
            event_id=obj["event_id"],
            group_id=obj["group_id"],
            peer_id=obj["peer_id"],
            created_at=obj["created_at"],
            signature=bytes.fromhex(obj.get("signature", "")),
        )
        if (
            not _valid_request_id(payload.event_id)
            or not re.fullmatch(r"[a-f0-9]{32}", payload.group_id)
            or not _valid_peer_id(payload.peer_id)
            or not isinstance(payload.created_at, (int, float))
            or isinstance(payload.created_at, bool)
            or len(payload.signature) != 64
        ):
            raise ValueError("Invalid group leave payload")
        return payload


MAX_FRIEND_NOTE_LENGTH = 1024


def _valid_peer_id(peer_id: str) -> bool:
    return isinstance(peer_id, str) and len(peer_id) <= 128 and peer_id != ""


def _valid_request_id(request_id: str) -> bool:
    return isinstance(request_id, str) and len(request_id) <= 128 and request_id != ""


@dataclass
class FriendRequestPayload:
    """A signed request asking another peer to become a friend."""

    request_id: str
    sender_id: str
    note: str
    created_at: float
    signature: bytes

    def signed_bytes(self) -> bytes:
        return json.dumps({
            "request_id": self.request_id,
            "sender_id": self.sender_id,
            "note": self.note,
            "created_at": self.created_at,
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        return json.dumps({
            "request_id": self.request_id,
            "sender_id": self.sender_id,
            "note": self.note,
            "created_at": self.created_at,
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> FriendRequestPayload:
        obj = json.loads(data)
        payload = cls(
            request_id=obj["request_id"],
            sender_id=obj["sender_id"],
            note=obj.get("note", ""),
            created_at=obj["created_at"],
            signature=bytes.fromhex(obj["signature"]),
        )
        if (
            not _valid_request_id(payload.request_id)
            or not _valid_peer_id(payload.sender_id)
            or not isinstance(payload.note, str)
            or len(payload.note) > MAX_FRIEND_NOTE_LENGTH
            or not isinstance(payload.created_at, (int, float))
            or isinstance(payload.created_at, bool)
            or payload.created_at <= 0
            or len(payload.signature) != 64
        ):
            raise ValueError("Invalid friend request payload")
        return payload


@dataclass
class FriendRequestResponsePayload:
    """A signed accept/decline response to a friend request."""

    request_id: str
    responder_id: str
    accept: bool
    signature: bytes

    def signed_bytes(self) -> bytes:
        return json.dumps({
            "request_id": self.request_id,
            "responder_id": self.responder_id,
            "accept": self.accept,
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        return json.dumps({
            "request_id": self.request_id,
            "responder_id": self.responder_id,
            "accept": self.accept,
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> FriendRequestResponsePayload:
        obj = json.loads(data)
        payload = cls(
            request_id=obj["request_id"],
            responder_id=obj["responder_id"],
            accept=obj["accept"],
            signature=bytes.fromhex(obj["signature"]),
        )
        if (
            not _valid_request_id(payload.request_id)
            or not _valid_peer_id(payload.responder_id)
            or not isinstance(payload.accept, bool)
            or len(payload.signature) != 64
        ):
            raise ValueError("Invalid friend request response payload")
        return payload


@dataclass
class MessageBlockedPayload:
    """A signed notice telling a sender their message was not delivered because
    the recipient is not a friend yet."""

    message_id: str
    blocked_by: str
    signature: bytes

    def signed_bytes(self) -> bytes:
        return json.dumps({
            "message_id": self.message_id,
            "blocked_by": self.blocked_by,
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        return json.dumps({
            "message_id": self.message_id,
            "blocked_by": self.blocked_by,
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> MessageBlockedPayload:
        obj = json.loads(data)
        payload = cls(
            message_id=obj["message_id"],
            blocked_by=obj["blocked_by"],
            signature=bytes.fromhex(obj["signature"]),
        )
        if (
            not _valid_request_id(payload.message_id)
            or not _valid_peer_id(payload.blocked_by)
            or len(payload.signature) != 64
        ):
            raise ValueError("Invalid blocked message payload")
        return payload


@dataclass
class FriendRequestCancelledPayload:
    """A signed notice telling a peer that a pending friend request was cancelled."""

    request_id: str
    sender_id: str
    signature: bytes

    def signed_bytes(self) -> bytes:
        return json.dumps({
            "request_id": self.request_id,
            "sender_id": self.sender_id,
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        return json.dumps({
            "request_id": self.request_id,
            "sender_id": self.sender_id,
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> FriendRequestCancelledPayload:
        obj = json.loads(data)
        payload = cls(
            request_id=obj["request_id"],
            sender_id=obj["sender_id"],
            signature=bytes.fromhex(obj["signature"]),
        )
        if (
            not _valid_request_id(payload.request_id)
            or not _valid_peer_id(payload.sender_id)
            or len(payload.signature) != 64
        ):
            raise ValueError("Invalid friend request cancelled payload")
        return payload


# File transfer constants and payloads — cross-platform considerations:
# - Filename is sanitized on both sender and receiver to avoid path traversal
#   and illegal characters on Windows (\ / : * ? " < > |) and POSIX (/).
# - File content is treated as binary (no encoding conversion) so line endings
#   remain intact across OSes.
# - Chunk size is chosen to fit within MAX_PACKET_SIZE after encryption and
#   hex encoding, ensuring reliable delivery over both LAN TCP and fragmented
#   remote UDP transports.

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MiB
MAX_FILE_CHUNK_SIZE = 28 * 1024
MAX_FILENAME_LENGTH = 255


def sanitize_filename(name: str) -> str:
    """Return a cross-platform safe filename derived from ``name``.

    Handles Windows, macOS, and Linux illegal characters and reserved names.
    """
    import pathlib
    # Extract basename in a cross-platform way: split on both / and \ and :.
    # pathlib alone is OS-specific, so handle manually.
    if not isinstance(name, str):
        name = str(name)
    # Take last segment after any separator
    parts = re.split(r"[\\/]", name)
    base = parts[-1] if parts else name
    base = base.strip()
    # Replace illegal chars and control chars
    base = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", base)
    # Strip trailing dots/spaces (Windows restriction)
    base = base.strip(" .")
    # Truncate to max length
    if len(base) > MAX_FILENAME_LENGTH:
        # Preserve extension if present
        stem, dot, ext = base[:MAX_FILENAME_LENGTH].rpartition(".")
        if dot and len(ext) <= 10:
            base = base[:MAX_FILENAME_LENGTH - len(ext) - 1].rstrip(" .") + "." + ext
        else:
            base = base[:MAX_FILENAME_LENGTH]
    # Handle reserved Windows names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    reserved = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}
    stem_upper = base.split(".")[0].upper() if base else ""
    if stem_upper in reserved:
        base = "_" + base
    if not base:
        base = "file"
    return base


@dataclass
class FileOfferPayload:
    file_id: str
    filename: str
    file_size: int
    chunk_size: int
    total_chunks: int
    sender_id: str
    recipient_id: str
    created_at: float
    signature: bytes = b""
    group_id: str | None = None

    def signed_bytes(self) -> bytes:
        data: dict[str, object] = {
            "file_id": self.file_id,
            "filename": self.filename,
            "file_size": self.file_size,
            "chunk_size": self.chunk_size,
            "total_chunks": self.total_chunks,
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "created_at": self.created_at,
        }
        if self.group_id:
            data["group_id"] = self.group_id
        return json.dumps(data, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        payload: dict[str, object] = {
            "file_id": self.file_id,
            "filename": self.filename,
            "file_size": self.file_size,
            "chunk_size": self.chunk_size,
            "total_chunks": self.total_chunks,
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "created_at": self.created_at,
            "signature": self.signature.hex(),
        }
        if self.group_id:
            payload["group_id"] = self.group_id
        return json.dumps(payload).encode()

    @classmethod
    def decode(cls, data: bytes) -> FileOfferPayload:
        obj = json.loads(data)
        payload = cls(
            file_id=obj["file_id"],
            filename=sanitize_filename(obj["filename"]),
            file_size=obj["file_size"],
            chunk_size=obj["chunk_size"],
            total_chunks=obj["total_chunks"],
            sender_id=obj["sender_id"],
            recipient_id=obj["recipient_id"],
            created_at=obj["created_at"],
            signature=bytes.fromhex(obj.get("signature", "")),
            group_id=obj.get("group_id"),
        )
        if (
            not _valid_request_id(payload.file_id)
            or not isinstance(payload.filename, str)
            or not 0 < payload.file_size <= MAX_FILE_SIZE
            or payload.chunk_size <= 0
            or payload.chunk_size > MAX_FILE_CHUNK_SIZE
            or payload.total_chunks <= 0
            or payload.total_chunks > 10000
            or payload.file_size > payload.chunk_size * payload.total_chunks
            or payload.file_size <= (payload.total_chunks - 1) * payload.chunk_size
            or not _valid_peer_id(payload.sender_id)
            or not _valid_peer_id(payload.recipient_id)
            or not isinstance(payload.created_at, (int, float))
            or isinstance(payload.created_at, bool)
            or len(payload.signature) != 64
        ):
            raise ValueError("Invalid file offer payload")
        if payload.group_id is not None and not re.fullmatch(r"[a-f0-9]{32}", payload.group_id):
            raise ValueError("Invalid group_id in file offer")
        return payload


@dataclass
class FileChunkPayload:
    file_id: str
    chunk_index: int
    total_chunks: int
    sender_id: str
    recipient_id: str
    encrypted_content: bytes
    signature: bytes = b""
    group_id: str | None = None

    def associated_data(self) -> bytes:
        data: dict[str, object] = {
            "file_id": self.file_id,
            "chunk_index": self.chunk_index,
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
        }
        if self.group_id:
            data["group_id"] = self.group_id
        return json.dumps(data, separators=(",", ":"), sort_keys=True).encode()

    def signed_bytes(self) -> bytes:
        return hashlib.sha256(self.associated_data() + self.encrypted_content).digest()

    def encode(self) -> bytes:
        payload: dict[str, object] = {
            "file_id": self.file_id,
            "chunk_index": self.chunk_index,
            "total_chunks": self.total_chunks,
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "encrypted_content": self.encrypted_content.hex(),
            "signature": self.signature.hex(),
        }
        if self.group_id:
            payload["group_id"] = self.group_id
        return json.dumps(payload).encode()

    @classmethod
    def decode(cls, data: bytes) -> FileChunkPayload:
        obj = json.loads(data)
        payload = cls(
            file_id=obj["file_id"],
            chunk_index=obj["chunk_index"],
            total_chunks=obj["total_chunks"],
            sender_id=obj["sender_id"],
            recipient_id=obj["recipient_id"],
            encrypted_content=bytes.fromhex(obj["encrypted_content"]),
            signature=bytes.fromhex(obj.get("signature", "")),
            group_id=obj.get("group_id"),
        )
        if (
            not _valid_request_id(payload.file_id)
            or not isinstance(payload.chunk_index, int)
            or isinstance(payload.chunk_index, bool)
            or payload.chunk_index < 0
            or payload.chunk_index >= payload.total_chunks
            or payload.total_chunks <= 0
            or not _valid_peer_id(payload.sender_id)
            or not _valid_peer_id(payload.recipient_id)
            or len(payload.encrypted_content) < 32 + 12 + 16
            or len(payload.encrypted_content) > MAX_PACKET_SIZE
            or len(payload.signature) != 64
        ):
            raise ValueError("Invalid file chunk payload")
        if payload.group_id is not None and not re.fullmatch(r"[a-f0-9]{32}", payload.group_id):
            raise ValueError("Invalid group_id in file chunk")
        return payload


@dataclass
class FileAckPayload:
    file_id: str
    recipient_id: str
    status: str
    signature: bytes = b""
    missing_ranges: list[tuple[int, int]] = field(default_factory=list)

    def signed_bytes(self) -> bytes:
        data: dict[str, object] = {
            "file_id": self.file_id,
            "recipient_id": self.recipient_id,
            "status": self.status,
        }
        if self.missing_ranges:
            data["missing_ranges"] = self.missing_ranges
        return json.dumps(data, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        payload: dict[str, object] = {
            "file_id": self.file_id,
            "recipient_id": self.recipient_id,
            "status": self.status,
            "signature": self.signature.hex(),
        }
        if self.missing_ranges:
            payload["missing_ranges"] = self.missing_ranges
        return json.dumps(payload, separators=(",", ":")).encode()

    @classmethod
    def decode(cls, data: bytes) -> FileAckPayload:
        obj = json.loads(data)
        raw_ranges = obj.get("missing_ranges", [])
        if not isinstance(raw_ranges, list):
            raise ValueError("Invalid file ack payload")
        missing_ranges: list[tuple[int, int]] = []
        previous_end = -1
        for value in raw_ranges:
            if (
                not isinstance(value, list)
                or len(value) != 2
                or not all(isinstance(index, int) and not isinstance(index, bool) for index in value)
            ):
                raise ValueError("Invalid file ack payload")
            start, end = value
            if start < 0 or end < start or end >= 10000 or start <= previous_end:
                raise ValueError("Invalid file ack payload")
            missing_ranges.append((start, end))
            previous_end = end
        payload = cls(
            file_id=obj["file_id"],
            recipient_id=obj["recipient_id"],
            status=obj["status"],
            signature=bytes.fromhex(obj.get("signature", "")),
            missing_ranges=missing_ranges,
        )
        if (
            not _valid_request_id(payload.file_id)
            or not _valid_peer_id(payload.recipient_id)
            or payload.status not in ("completed", "ack", "missing")
            or (payload.status == "missing") != bool(payload.missing_ranges)
            or len(payload.signature) != 64
        ):
            raise ValueError("Invalid file ack payload")
        return payload
