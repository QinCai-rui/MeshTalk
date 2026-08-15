"""Direct, authenticated end-to-end encrypted message delivery."""

from __future__ import annotations

import logging
import time
import uuid
from typing import Awaitable, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .database import Database
from .encryption import decrypt_as_recipient, encrypt_for_recipient
from .identity import Identity
from .peer_manager import PeerConnection, PeerManager
from .protocol import MessagePayload, Packet, PacketType

logger = logging.getLogger(__name__)
MESSAGE_EXPIRY = 86400


class MessageRouter:
    def __init__(self, identity: Identity, peer_manager: PeerManager, db: Database, on_received: Callable[[dict], Awaitable[None]] | None = None, on_delivered: Callable[[str], Awaitable[None]] | None = None) -> None:
        self.identity, self.peer_manager, self.db = identity, peer_manager, db
        self.on_received = on_received
        self.on_delivered = on_delivered

    async def send_message(self, recipient_id: str, plaintext: bytes) -> str:
        if len(plaintext) > 64 * 1024:
            raise ValueError("Message exceeds 64 KiB limit")
        peer = self.peer_manager.get_connected_peer(recipient_id)
        if peer is None or peer.encryption_public_key is None:
            raise ValueError("Recipient is not directly connected")
        now = time.time()
        message = MessagePayload(str(uuid.uuid4()), self.identity.peer_id, recipient_id, now, now + MESSAGE_EXPIRY, 0, 0, b"")
        message.encrypted_content = encrypt_for_recipient(peer.encryption_public_key, plaintext, message.associated_data())
        message.signature = self.identity.signing_private_key.sign(message.signed_bytes())
        await self.db.save_message({
            "message_id": message.message_id, "sender_id": message.sender_id, "recipient_id": message.recipient_id,
            "content": plaintext.decode("utf-8"), "encrypted_content": message.encrypted_content,
            "created_at": message.created_at, "expires_at": message.expires_at, "hop_count": 0, "max_hops": 0,
            "read_at": now,
        })
        await self.db.mark_message_seen(message.message_id)
        await self.peer_manager.send_packet(peer, Packet(PacketType.MESSAGE, message.encode()))
        return message.message_id

    async def handle_packet(self, peer: PeerConnection, packet: Packet) -> None:
        if packet.type == PacketType.MESSAGE:
            await self._handle_message(peer, packet)
        elif packet.type == PacketType.MESSAGE_ACK:
            message_id = packet.payload.decode("ascii")
            await self.db.mark_message_delivered(message_id)
            if self.on_delivered:
                await self.on_delivered(message_id)

    async def _handle_message(self, peer: PeerConnection, packet: Packet) -> None:
        message = MessagePayload.decode(packet.payload)
        if message.recipient_id != self.identity.peer_id:
            return
        if message.sender_id != peer.peer_id or peer.signing_public_key is None:
            raise ValueError("Message sender does not match authenticated peer")
        if message.expires_at < time.time() or message.hop_count != 0 or message.max_hops != 0:
            raise ValueError("Invalid direct message metadata")
        if len(message.signature) != 64:
            raise ValueError("Invalid message signature")
        if await self.db.is_message_seen(message.message_id):
            await self.peer_manager.send_packet(peer, Packet(PacketType.MESSAGE_ACK, message.message_id.encode("ascii")))
            return
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(message.signature, message.signed_bytes())
            plaintext = decrypt_as_recipient(self.identity.encryption_private_key, message.encrypted_content, message.associated_data())
            content = plaintext.decode("utf-8")
        except (InvalidSignature, UnicodeDecodeError) as exc:
            raise ValueError("Invalid encrypted message") from exc
        await self.db.mark_message_seen(message.message_id)
        await self.db.save_message({
            "message_id": message.message_id, "sender_id": message.sender_id, "recipient_id": message.recipient_id,
            "content": content, "encrypted_content": message.encrypted_content,
            "created_at": message.created_at, "expires_at": message.expires_at,
            "hop_count": 0, "max_hops": 0, "read_at": None,
        })
        await self.peer_manager.send_packet(peer, Packet(PacketType.MESSAGE_ACK, message.message_id.encode("ascii")))
        logger.info("Received encrypted message %s from %s", message.message_id, peer.peer_id)
        if self.on_received:
            await self.on_received({"message_id": message.message_id, "sender_id": message.sender_id, "content": content, "created_at": message.created_at})
