"""Wire protocol types and application packet framing.

The application packet format is used inside the encrypted TCP record layer
after the LAN handshake and directly inside reliable UDP data fragments.

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
CAP_MESSAGE_REPLIES = "message_replies"
DEFAULT_CAPABILITIES = [
    CAP_TEXT_CHAT,
    CAP_PROFILE_SYNC,
    CAP_FRIEND_REQUESTS,
    CAP_DELIVERY_RECEIPTS,
    CAP_BLOCK_REPORTS,
    CAP_GROUP_CHAT,
    CAP_FILE_TRANSFER,
    CAP_TYPING_INDICATORS,
    CAP_MESSAGE_REPLIES,
]
UDP_PORT = 24890
TCP_PORT = 24891
MAX_PACKET_SIZE = 64 * 1024  # 64 KB
TCP_TRANSPORT_VERSION = 1
DISCOVERY_ID = re.compile(r"[a-f0-9]{32}")
HEADER_FORMAT = "!IB"  # 4-byte big-endian length + 1-byte type
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)


def intersect_capabilities(local: list[str], remote: list[str]) -> list[str]:
    """Return the sorted set of capabilities supported by both peers.

    The local list is authoritative for what this client implements. Unknown
    remote capabilities therefore remain disabled without affecting shared
    features.
    """
    return sorted(set(local) & set(remote))


def validate_capabilities(capabilities: object) -> list[str]:
    """Return capability strings received from a remote peer.

    Unknown capabilities must be retained until handshake signature verification;
    removing one would change the authenticated canonical payload. Unsupported
    capabilities are filtered later when the negotiated intersection is built.
    """
    if not isinstance(capabilities, list):
        raise ValueError("Handshake capabilities must be a list")
    if len(capabilities) > 64:
        raise ValueError("Too many handshake capabilities")
    if any(
        not isinstance(capability, str)
        or not capability
        or len(capability) > 64
        or not re.fullmatch(r"[A-Za-z0-9_.-]+", capability)
        for capability in capabilities
    ):
        raise ValueError("Invalid handshake capability")
    if len(set(capabilities)) != len(capabilities):
        raise ValueError("Duplicate handshake capability")
    return capabilities


class PacketType(enum.IntEnum):
    """Enumeration of all packet types in the MeshTalk protocol."""

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


PACKET_CAPABILITIES = {
    PacketType.MESSAGE: CAP_TEXT_CHAT,
    PacketType.MESSAGE_ACK: CAP_DELIVERY_RECEIPTS,
    PacketType.PROFILE: CAP_PROFILE_SYNC,
    PacketType.FRIEND_REQUEST: CAP_FRIEND_REQUESTS,
    PacketType.FRIEND_REQUEST_RESPONSE: CAP_FRIEND_REQUESTS,
    PacketType.FRIEND_REQUEST_CANCELLED: CAP_FRIEND_REQUESTS,
    PacketType.MESSAGE_BLOCKED: CAP_BLOCK_REPORTS,
    PacketType.GROUP_MESSAGE: CAP_GROUP_CHAT,
    PacketType.GROUP_MESSAGE_ACK: CAP_GROUP_CHAT,
    PacketType.GROUP_LEAVE: CAP_GROUP_CHAT,
    PacketType.FILE_OFFER: CAP_FILE_TRANSFER,
    PacketType.FILE_CHUNK: CAP_FILE_TRANSFER,
    PacketType.FILE_ACK: CAP_FILE_TRANSFER,
    PacketType.TYPING: CAP_TYPING_INDICATORS,
}


def capability_for_packet(packet_type: PacketType) -> str | None:
    """Return the capability required to send/receive a packet type, or None if no capability needed."""
    return PACKET_CAPABILITIES.get(packet_type)


@dataclass
class Packet:
    """A MeshTalk protocol packet with type and payload."""
    type: PacketType
    payload: bytes = field(default=b"")

    def encode(self) -> bytes:
        """Encode the packet to wire format with length header."""
        length = len(self.payload)
        if length > MAX_PACKET_SIZE:
            raise ValueError(f"Payload too large: {length} > {MAX_PACKET_SIZE}")
        header = struct.pack(HEADER_FORMAT, length, self.type)
        return header + self.payload

    @classmethod
    def decode_header(cls, data: bytes) -> tuple[int, PacketType]:
        """Decode packet header, returning payload length and packet type."""
        if len(data) < HEADER_SIZE:
            raise ValueError(f"Header too short: {len(data)} < {HEADER_SIZE}")
        length, ptype = struct.unpack(HEADER_FORMAT, data)
        if length > MAX_PACKET_SIZE:
            raise ValueError(f"Packet too large: {length} > {MAX_PACKET_SIZE}")
        return length, PacketType(ptype)

    @classmethod
    def decode(cls, header_data: bytes, payload: bytes) -> Packet:
        """Decode a complete packet from header and payload."""
        length, ptype = cls.decode_header(header_data)
        if len(payload) != length:
            raise ValueError(f"Payload length mismatch: {len(payload)} != {length}")
        return cls(type=ptype, payload=payload)


@dataclass
class DiscoveryPacket:
    """LAN discovery announcement containing ephemeral ID and TCP port."""

    discovery_id: str
    tcp_port: int

    def encode(self) -> bytes:
        """Encode discovery packet to JSON bytes."""
        import json
        return json.dumps({
            "discovery_id": self.discovery_id,
            "tcp_port": self.tcp_port,
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> DiscoveryPacket:
        """Decode and validate a discovery packet from JSON bytes."""
        import json
        obj = json.loads(data)
        if not isinstance(obj, dict):
            raise ValueError("Discovery packet must be an object")
        discovery_id = obj.get("discovery_id")
        tcp_port = obj.get("tcp_port")
        if (
            not isinstance(discovery_id, str)
            or not DISCOVERY_ID.fullmatch(discovery_id)
            or not isinstance(tcp_port, int)
            or isinstance(tcp_port, bool)
            or not 1 <= tcp_port <= 65535
        ):
            raise ValueError("Invalid discovery packet")
        return cls(discovery_id=discovery_id, tcp_port=tcp_port)


@dataclass
class HandshakePayload:
    """Signed handshake containing peer identity and ephemeral TCP key material."""

    peer_id: str
    signing_public_key: bytes
    encryption_public_key: bytes
    display_name: str
    nonce: bytes
    challenge: bytes
    signature: bytes
    capabilities: list[str] = field(default_factory=lambda: list(DEFAULT_CAPABILITIES))
    transport_version: int = TCP_TRANSPORT_VERSION
    session_public_key: bytes = b""

    def signed_bytes(self) -> bytes:
        """Return canonical bytes that are signed by the peer's private key."""
        data = {
            "peer_id": self.peer_id,
            "signing_public_key": self.signing_public_key.hex(),
            "encryption_public_key": self.encryption_public_key.hex(),
            "display_name": self.display_name,
            "nonce": self.nonce.hex(),
            "challenge": self.challenge.hex(),
            "capabilities": sorted(self.capabilities),
            "transport_version": self.transport_version,
            "session_public_key": self.session_public_key.hex(),
        }
        return json.dumps(data, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        """Encode handshake to JSON bytes."""
        return json.dumps({
            "peer_id": self.peer_id,
            "signing_public_key": self.signing_public_key.hex(),
            "encryption_public_key": self.encryption_public_key.hex(),
            "display_name": self.display_name,
            "nonce": self.nonce.hex(),
            "challenge": self.challenge.hex(),
            "signature": self.signature.hex(),
            "capabilities": self.capabilities,
            "transport_version": self.transport_version,
            "session_public_key": self.session_public_key.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> HandshakePayload:
        """Decode and validate handshake from JSON bytes."""
        obj = json.loads(data)
        capabilities = validate_capabilities(obj.get("capabilities"))
        payload = cls(
            peer_id=obj["peer_id"],
            signing_public_key=bytes.fromhex(obj["signing_public_key"]),
            encryption_public_key=bytes.fromhex(obj["encryption_public_key"]),
            display_name=obj["display_name"],
            nonce=bytes.fromhex(obj["nonce"]),
            challenge=bytes.fromhex(obj["challenge"]),
            signature=bytes.fromhex(obj["signature"]),
            capabilities=capabilities,
            transport_version=obj.get("transport_version"),
            session_public_key=bytes.fromhex(obj.get("session_public_key", "")),
        )
        if len(payload.signing_public_key) != 32 or len(payload.encryption_public_key) != 32:
            raise ValueError("Invalid handshake public key length")
        if (
            len(payload.nonce) != 32
            or len(payload.challenge) not in (0, 32)
            or len(payload.signature) != 64
            or not isinstance(payload.transport_version, int)
            or isinstance(payload.transport_version, bool)
            or payload.transport_version != TCP_TRANSPORT_VERSION
            or len(payload.session_public_key) != 32
        ):
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
        """Return canonical bytes for signature verification."""
        return json.dumps({
            "peer_id": self.peer_id,
            "display_name": self.display_name,
            "tui_active": self.tui_active,
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        """Encode profile to JSON bytes."""
        return json.dumps({
            "peer_id": self.peer_id,
            "display_name": self.display_name,
            "tui_active": self.tui_active,
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> ProfilePayload:
        """Decode profile from JSON bytes."""
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
    """Direct message with routing metadata and encrypted content."""

    message_id: str
    sender_id: str
    recipient_id: str
    created_at: float
    hop_count: int
    max_hops: int
    encrypted_content: bytes
    signature: bytes = b""
    reply_to_message_id: str | None = None

    def associated_data(self) -> bytes:
        """Immutable routing metadata authenticated by AES-GCM and sender signature."""
        data: dict[str, object] = {
            "message_id": self.message_id,
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "created_at": self.created_at,
        }
        if self.reply_to_message_id:
            data["reply_to_message_id"] = self.reply_to_message_id
        return json.dumps(data, separators=(",", ":"), sort_keys=True).encode()

    def signed_bytes(self) -> bytes:
        """Return SHA256 hash of authenticated content for signature verification."""
        return hashlib.sha256(self.associated_data() + self.encrypted_content).digest()

    def encode(self) -> bytes:
        """Encode message to JSON bytes."""
        data: dict[str, object] = {
            "message_id": self.message_id,
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "created_at": self.created_at,
            "hop_count": self.hop_count,
            "max_hops": self.max_hops,
            "encrypted_content": self.encrypted_content.hex(),
            "signature": self.signature.hex(),
        }
        if self.reply_to_message_id:
            data["reply_to_message_id"] = self.reply_to_message_id
        return json.dumps(data).encode()

    @classmethod
    def decode(cls, data: bytes) -> MessagePayload:
        """Decode message from JSON bytes."""
        obj = json.loads(data)
        payload = cls(
            message_id=obj["message_id"],
            sender_id=obj["sender_id"],
            recipient_id=obj["recipient_id"],
            created_at=obj["created_at"],
            hop_count=obj["hop_count"],
            max_hops=obj["max_hops"],
            encrypted_content=bytes.fromhex(obj["encrypted_content"]),
            signature=bytes.fromhex(obj.get("signature", "")),
            reply_to_message_id=obj.get("reply_to_message_id"),
        )
        if payload.reply_to_message_id is not None and not _valid_request_id(payload.reply_to_message_id):
            raise ValueError("Invalid reply target")
        return payload


@dataclass
class GroupMessagePayload:
    """Group chat message with routing metadata and encrypted content."""

    message_id: str
    group_id: str
    sender_id: str
    recipient_id: str
    created_at: float
    encrypted_content: bytes
    signature: bytes = b""
    reply_to_message_id: str | None = None

    def associated_data(self) -> bytes:
        """Return routing metadata authenticated by AES-GCM."""
        data: dict[str, object] = {
            "message_id": self.message_id,
            "group_id": self.group_id,
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "created_at": self.created_at,
        }
        if self.reply_to_message_id:
            data["reply_to_message_id"] = self.reply_to_message_id
        return json.dumps(data, separators=(",", ":"), sort_keys=True).encode()

    def signed_bytes(self) -> bytes:
        """Return SHA256 hash for signature verification."""
        return hashlib.sha256(self.associated_data() + self.encrypted_content).digest()

    def encode(self) -> bytes:
        """Encode group message to JSON bytes."""
        data: dict[str, object] = {
            "message_id": self.message_id,
            "group_id": self.group_id,
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "created_at": self.created_at,
            "encrypted_content": self.encrypted_content.hex(),
            "signature": self.signature.hex(),
        }
        if self.reply_to_message_id:
            data["reply_to_message_id"] = self.reply_to_message_id
        return json.dumps(data).encode()

    @classmethod
    def decode(cls, data: bytes) -> GroupMessagePayload:
        """Decode and validate group message from JSON bytes."""
        obj = json.loads(data)
        payload = cls(
            message_id=obj["message_id"],
            group_id=obj["group_id"],
            sender_id=obj["sender_id"],
            recipient_id=obj["recipient_id"],
            created_at=obj["created_at"],
            encrypted_content=bytes.fromhex(obj["encrypted_content"]),
            signature=bytes.fromhex(obj.get("signature", "")),
            reply_to_message_id=obj.get("reply_to_message_id"),
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
            or (payload.reply_to_message_id is not None and not _valid_request_id(payload.reply_to_message_id))
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
        """Return routing metadata authenticated by AES-GCM."""
        return json.dumps({
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "created_at": self.created_at,
        }, separators=(",", ":"), sort_keys=True).encode()

    def signed_bytes(self) -> bytes:
        """Return SHA256 hash for signature verification."""
        return hashlib.sha256(self.associated_data() + self.encrypted_content).digest()

    def encode(self) -> bytes:
        """Encode typing indicator to JSON bytes."""
        return json.dumps({
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "created_at": self.created_at,
            "encrypted_content": self.encrypted_content.hex(),
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> TypingPayload:
        """Decode and validate typing indicator from JSON bytes."""
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
            or not math.isfinite(payload.created_at)
            or payload.created_at <= 0
            or len(payload.signature) != 64
        ):
            raise ValueError("Invalid typing payload")
        return payload


@dataclass
class GroupAckPayload:
    """Acknowledgement of group message receipt."""

    message_id: str
    group_id: str
    recipient_id: str
    signature: bytes = b""

    def signed_bytes(self) -> bytes:
        """Return canonical bytes for signature verification."""
        return json.dumps({
            "message_id": self.message_id,
            "group_id": self.group_id,
            "recipient_id": self.recipient_id,
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        """Encode group acknowledgement to JSON bytes."""
        return json.dumps({
            "message_id": self.message_id,
            "group_id": self.group_id,
            "recipient_id": self.recipient_id,
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> GroupAckPayload:
        """Decode and validate group acknowledgement from JSON bytes."""
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
    """Announcement that a peer has left a group."""

    event_id: str
    group_id: str
    peer_id: str
    created_at: float
    signature: bytes = b""

    def signed_bytes(self) -> bytes:
        """Return canonical bytes for signature verification."""
        return json.dumps({
            "event_id": self.event_id,
            "group_id": self.group_id,
            "peer_id": self.peer_id,
            "created_at": self.created_at,
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        """Encode group leave event to JSON bytes."""
        return json.dumps({
            "event_id": self.event_id,
            "group_id": self.group_id,
            "peer_id": self.peer_id,
            "created_at": self.created_at,
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> GroupLeavePayload:
        """Decode and validate group leave event from JSON bytes."""
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
        """Return canonical bytes for signature verification."""
        return json.dumps({
            "request_id": self.request_id,
            "sender_id": self.sender_id,
            "note": self.note,
            "created_at": self.created_at,
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        """Encode friend request to JSON bytes."""
        return json.dumps({
            "request_id": self.request_id,
            "sender_id": self.sender_id,
            "note": self.note,
            "created_at": self.created_at,
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> FriendRequestPayload:
        """Decode and validate friend request from JSON bytes."""
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
        """Return canonical bytes for signature verification."""
        return json.dumps({
            "request_id": self.request_id,
            "responder_id": self.responder_id,
            "accept": self.accept,
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        """Encode friend request response to JSON bytes."""
        return json.dumps({
            "request_id": self.request_id,
            "responder_id": self.responder_id,
            "accept": self.accept,
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> FriendRequestResponsePayload:
        """Decode and validate friend request response from JSON bytes."""
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
        """Return canonical bytes for signature verification."""
        return json.dumps({
            "message_id": self.message_id,
            "blocked_by": self.blocked_by,
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        """Encode block notice to JSON bytes."""
        return json.dumps({
            "message_id": self.message_id,
            "blocked_by": self.blocked_by,
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> MessageBlockedPayload:
        """Decode and validate block notice from JSON bytes."""
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
        """Return canonical bytes for signature verification."""
        return json.dumps({
            "request_id": self.request_id,
            "sender_id": self.sender_id,
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        """Encode cancellation notice to JSON bytes."""
        return json.dumps({
            "request_id": self.request_id,
            "sender_id": self.sender_id,
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> FriendRequestCancelledPayload:
        """Decode and validate cancellation notice from JSON bytes."""
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
    """File transfer offer containing metadata about the file."""

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
        """Return canonical bytes for signature verification."""
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
        """Encode file offer to JSON bytes."""
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
        """Decode and validate file offer from JSON bytes."""
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
    """A single chunk of a file transfer with encrypted content."""

    file_id: str
    chunk_index: int
    total_chunks: int
    sender_id: str
    recipient_id: str
    encrypted_content: bytes
    signature: bytes = b""
    group_id: str | None = None

    def associated_data(self) -> bytes:
        """Return file chunk metadata authenticated by AES-GCM."""
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
        """Return SHA256 hash for signature verification."""
        return hashlib.sha256(self.associated_data() + self.encrypted_content).digest()

    def encode(self) -> bytes:
        """Encode file chunk to JSON bytes."""
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
        """Decode and validate file chunk from JSON bytes."""
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
    """Acknowledgement of file transfer progress or completion."""

    file_id: str
    recipient_id: str
    status: str
    signature: bytes = b""
    missing_ranges: list[tuple[int, int]] = field(default_factory=list)

    def signed_bytes(self) -> bytes:
        """Return canonical bytes for signature verification."""
        data: dict[str, object] = {
            "file_id": self.file_id,
            "recipient_id": self.recipient_id,
            "status": self.status,
        }
        if self.missing_ranges:
            data["missing_ranges"] = self.missing_ranges
        return json.dumps(data, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        """Encode file acknowledgement to JSON bytes."""
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
        """Decode and validate file acknowledgement from JSON bytes."""
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
