"""Authenticated encryption for established LAN TCP sessions."""

from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .protocol import (
    HEADER_SIZE,
    MAX_PACKET_SIZE,
    TCP_TRANSPORT_VERSION,
    HandshakePayload,
    Packet,
)

TCP_RECORD_HEADER_FORMAT = "!IQ"  # ciphertext length + monotonic sequence
TCP_RECORD_HEADER_SIZE = struct.calcsize(TCP_RECORD_HEADER_FORMAT)
TCP_RECORD_TAG_SIZE = 16
TCP_NONCE_PREFIX_SIZE = 4
TCP_MAX_SEQUENCE = (1 << 64) - 1
TCP_MAX_PLAINTEXT_SIZE = HEADER_SIZE + MAX_PACKET_SIZE
TCP_MAX_RECORD_SIZE = TCP_MAX_PLAINTEXT_SIZE + TCP_RECORD_TAG_SIZE
TCP_RECORD_AAD_PREFIX = b"meshtalk-tcp-record-v1"
TCP_KDF_INFO = b"meshtalk-tcp-session-v1"
TCP_TRANSCRIPT_DOMAIN = b"meshtalk-tcp-handshake-transcript-v1"


class TcpTransportError(ValueError):
    """Raised when a TCP session or record fails validation."""


def _length_prefixed(value: bytes) -> bytes:
    """Encode a byte string as a 4-byte big-endian length prefix followed by the value."""
    return struct.pack("!I", len(value)) + value


def _authenticated_handshake_payload(payload: HandshakePayload) -> bytes:
    """Serialize a handshake payload as its signed bytes and signature, both length-prefixed."""
    return _length_prefixed(payload.signed_bytes()) + _length_prefixed(payload.signature)


def _handshake_transcript(
    first: HandshakePayload, second: HandshakePayload
) -> bytes:
    """Compute a cryptographic binding hash over both ordered handshake payloads."""
    return hashlib.sha256(
        TCP_TRANSCRIPT_DOMAIN
        + _length_prefixed(_authenticated_handshake_payload(first))
        + _length_prefixed(_authenticated_handshake_payload(second))
    ).digest()


@dataclass
class TcpSession:
    """Directional AES-GCM state for one TCP connection."""

    peer_id: str
    session_id: bytes
    transcript_hash: bytes
    confirmation_token: bytes
    transmit_encryption_key: bytes
    receive_encryption_key: bytes
    transmit_nonce_prefix: bytes
    receive_nonce_prefix: bytes
    send_sequence: int = 0
    receive_sequence: int = 0
    confirmed: bool = False

    @classmethod
    def derive(
        cls,
        local_peer_id: str,
        remote_peer_id: str,
        local_private_key: X25519PrivateKey,
        local_payload: HandshakePayload,
        remote_payload: HandshakePayload,
    ) -> TcpSession:
        """Derive a session bound to both authenticated handshake payloads."""
        if local_peer_id == remote_peer_id:
            raise TcpTransportError("TCP session cannot be established with itself")
        if local_payload.peer_id != local_peer_id or remote_payload.peer_id != remote_peer_id:
            raise TcpTransportError("TCP session identity mismatch")
        if any(
            payload.transport_version != TCP_TRANSPORT_VERSION
            or len(payload.session_public_key) != 32
            or len(payload.nonce) != 32
            for payload in (local_payload, remote_payload)
        ):
            raise TcpTransportError("Invalid TCP session handshake parameters")

        try:
            remote_public_key = X25519PublicKey.from_public_bytes(remote_payload.session_public_key)
            shared_secret = local_private_key.exchange(remote_public_key)
        except ValueError as exc:
            raise TcpTransportError("Invalid TCP session key") from exc

        first, second = (
            (local_payload, remote_payload)
            if local_peer_id < remote_peer_id
            else (remote_payload, local_payload)
        )
        transcript_hash = _handshake_transcript(first, second)
        salt = hashlib.sha256(
            b"meshtalk-tcp-kdf-salt-v1" + first.nonce + second.nonce
        ).digest()
        material = HKDF(
            algorithm=SHA256(),
            length=32 + 4 + 32 + 4,
            salt=salt,
            info=TCP_KDF_INFO + transcript_hash,
        ).derive(shared_secret)

        first_to_second = material[:36]
        second_to_first = material[36:72]
        transmit, receive = (
            (first_to_second, second_to_first)
            if local_peer_id < remote_peer_id
            else (second_to_first, first_to_second)
        )
        session_id = hashlib.sha256(
            b"meshtalk-tcp-session-id-v1" + transcript_hash + material
        ).digest()[:16]
        confirmation_token = hashlib.sha256(
            b"meshtalk-tcp-confirm-v1" + session_id + transcript_hash
        ).digest()
        return cls(
            peer_id=remote_peer_id,
            session_id=session_id,
            transcript_hash=transcript_hash,
            confirmation_token=confirmation_token,
            transmit_encryption_key=transmit[:32],
            receive_encryption_key=receive[:32],
            transmit_nonce_prefix=transmit[32:],
            receive_nonce_prefix=receive[32:],
        )

    @staticmethod
    def validate_record_header(header: bytes) -> tuple[int, int]:
        """Parse and validate a TCP record header, returning ciphertext length and sequence number."""
        if len(header) != TCP_RECORD_HEADER_SIZE:
            raise TcpTransportError("TCP record header is truncated")
        try:
            length, sequence = struct.unpack(TCP_RECORD_HEADER_FORMAT, header)
        except struct.error as exc:
            raise TcpTransportError("Invalid TCP record header") from exc
        if length < TCP_RECORD_TAG_SIZE:
            raise TcpTransportError("TCP record is truncated")
        if length > TCP_MAX_RECORD_SIZE:
            raise TcpTransportError("TCP record is oversized")
        if sequence >= TCP_MAX_SEQUENCE:
            raise TcpTransportError("TCP record sequence is exhausted")
        return length, sequence

    def _nonce(self, prefix: bytes, sequence: int) -> bytes:
        """Construct a 12-byte AES-GCM nonce from a 4-byte prefix and 8-byte sequence number."""
        return prefix + struct.pack("!Q", sequence)

    def encrypt_packet(self, packet: Packet) -> bytes:
        """Encrypt an application packet as an authenticated TCP record and increment send sequence."""
        if self.send_sequence >= TCP_MAX_SEQUENCE:
            raise TcpTransportError("TCP send sequence is exhausted")
        plaintext = packet.encode()
        sequence = self.send_sequence
        record_length = len(plaintext) + TCP_RECORD_TAG_SIZE
        header = struct.pack(TCP_RECORD_HEADER_FORMAT, record_length, sequence)
        ciphertext = AESGCM(self.transmit_encryption_key).encrypt(
            self._nonce(self.transmit_nonce_prefix, sequence),
            plaintext,
            TCP_RECORD_AAD_PREFIX + header,
        )
        self.send_sequence += 1
        return header + ciphertext

    def decrypt_record(self, header: bytes, ciphertext: bytes) -> Packet:
        """Decrypt and authenticate a TCP record, returning the application packet and incrementing receive sequence."""
        length, sequence = self.validate_record_header(header)
        if len(ciphertext) != length:
            raise TcpTransportError("TCP record length mismatch")
        if sequence != self.receive_sequence:
            raise TcpTransportError(
                f"Unexpected TCP record sequence: {sequence} != {self.receive_sequence}"
            )
        try:
            plaintext = AESGCM(self.receive_encryption_key).decrypt(
                self._nonce(self.receive_nonce_prefix, sequence),
                ciphertext,
                TCP_RECORD_AAD_PREFIX + header,
            )
            if len(plaintext) < HEADER_SIZE or len(plaintext) > TCP_MAX_PLAINTEXT_SIZE:
                raise TcpTransportError("Invalid TCP record plaintext size")
            packet = Packet.decode(plaintext[:HEADER_SIZE], plaintext[HEADER_SIZE:])
        except InvalidTag as exc:
            raise TcpTransportError("Invalid TCP record authentication") from exc
        except (TypeError, ValueError) as exc:
            if isinstance(exc, TcpTransportError):
                raise
            raise TcpTransportError("Invalid TCP record packet") from exc
        self.receive_sequence += 1
        return packet
