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
"""

from __future__ import annotations

import enum
import hashlib
import json
import re
import struct
from dataclasses import dataclass, field
from typing import Any

PROTOCOL_VERSION = 1
UDP_PORT = 24890
TCP_PORT = 24891
MAX_PACKET_SIZE = 64 * 1024  # 64 KB
DISCOVERY_ID = re.compile(r"[a-f0-9]{32}")
HEADER_FORMAT = "!IB"  # 4-byte big-endian length + 1-byte type
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)


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

    def encode(self) -> bytes:
        import json
        return json.dumps({
            "protocol": self.protocol,
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
        discovery_id = obj.get("discovery_id")
        tcp_port = obj.get("tcp_port")
        if (
            not isinstance(protocol, int)
            or isinstance(protocol, bool)
            or not isinstance(discovery_id, str)
            or not DISCOVERY_ID.fullmatch(discovery_id)
            or not isinstance(tcp_port, int)
            or isinstance(tcp_port, bool)
            or not 1 <= tcp_port <= 65535
        ):
            raise ValueError("Invalid discovery packet")
        return cls(protocol=protocol, discovery_id=discovery_id, tcp_port=tcp_port)


@dataclass
class HandshakePayload:
    peer_id: str
    signing_public_key: bytes
    encryption_public_key: bytes
    display_name: str
    nonce: bytes
    challenge: bytes
    signature: bytes

    def signed_bytes(self) -> bytes:
        return json.dumps({
            "peer_id": self.peer_id,
            "signing_public_key": self.signing_public_key.hex(),
            "encryption_public_key": self.encryption_public_key.hex(),
            "display_name": self.display_name,
            "nonce": self.nonce.hex(),
            "challenge": self.challenge.hex(),
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        return json.dumps({
            "peer_id": self.peer_id,
            "signing_public_key": self.signing_public_key.hex(),
            "encryption_public_key": self.encryption_public_key.hex(),
            "display_name": self.display_name,
            "nonce": self.nonce.hex(),
            "challenge": self.challenge.hex(),
            "signature": self.signature.hex(),
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> HandshakePayload:
        obj = json.loads(data)
        payload = cls(
            peer_id=obj["peer_id"],
            signing_public_key=bytes.fromhex(obj["signing_public_key"]),
            encryption_public_key=bytes.fromhex(obj["encryption_public_key"]),
            display_name=obj["display_name"],
            nonce=bytes.fromhex(obj["nonce"]),
            challenge=bytes.fromhex(obj["challenge"]),
            signature=bytes.fromhex(obj["signature"]),
        )
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
    expires_at: float
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
            "expires_at": self.expires_at,
        }, separators=(",", ":"), sort_keys=True).encode()

    def signed_bytes(self) -> bytes:
        return hashlib.sha256(self.associated_data() + self.encrypted_content).digest()

    def encode(self) -> bytes:
        return json.dumps({
            "message_id": self.message_id,
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
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
            expires_at=obj["expires_at"],
            hop_count=obj["hop_count"],
            max_hops=obj["max_hops"],
            encrypted_content=bytes.fromhex(obj["encrypted_content"]),
            signature=bytes.fromhex(obj.get("signature", "")),
        )


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
