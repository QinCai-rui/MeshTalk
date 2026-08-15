"""Wire protocol types and packet framing.

TCP framing: [4-byte length][1-byte type][payload]

Packet types:
  HANDSHAKE      0x01
  HANDSHAKE_ACK  0x02
  MESSAGE        0x03
  MESSAGE_ACK    0x04
  PING           0x05
  PONG           0x06
  GOODBYE        0x07
"""

from __future__ import annotations

import enum
import hashlib
import json
import struct
from dataclasses import dataclass, field
from typing import Any

PROTOCOL_VERSION = 1
UDP_PORT = 24890
TCP_PORT = 24891
MAX_PACKET_SIZE = 64 * 1024  # 64 KB
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
    peer_id: str
    tcp_port: int

    def encode(self) -> bytes:
        import json
        return json.dumps({
            "protocol": self.protocol,
            "peer_id": self.peer_id,
            "tcp_port": self.tcp_port,
        }).encode()

    @classmethod
    def decode(cls, data: bytes) -> DiscoveryPacket:
        import json
        obj = json.loads(data)
        return cls(
            protocol=obj["protocol"],
            peer_id=obj["peer_id"],
            tcp_port=obj["tcp_port"],
        )


@dataclass
class HandshakePayload:
    peer_id: str
    signing_public_key: bytes
    encryption_public_key: bytes
    display_name: str
    nonce: bytes
    signature: bytes

    def signed_bytes(self) -> bytes:
        return json.dumps({
            "peer_id": self.peer_id,
            "signing_public_key": self.signing_public_key.hex(),
            "encryption_public_key": self.encryption_public_key.hex(),
            "display_name": self.display_name,
            "nonce": self.nonce.hex(),
        }, separators=(",", ":"), sort_keys=True).encode()

    def encode(self) -> bytes:
        return json.dumps({
            "peer_id": self.peer_id,
            "signing_public_key": self.signing_public_key.hex(),
            "encryption_public_key": self.encryption_public_key.hex(),
            "display_name": self.display_name,
            "nonce": self.nonce.hex(),
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
            signature=bytes.fromhex(obj["signature"]),
        )
        if len(payload.signing_public_key) != 32 or len(payload.encryption_public_key) != 32:
            raise ValueError("Invalid handshake public key length")
        if len(payload.nonce) != 32 or len(payload.signature) != 64:
            raise ValueError("Invalid handshake nonce or signature")
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
