"""Direct, authenticated end-to-end encrypted message delivery.

Incoming messages are only accepted from friends. Messages from other peers
are dropped and the sender receives a signed MESSAGE_BLOCKED notice.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Awaitable, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .database import Database
from .encryption import decrypt_as_recipient, encrypt_for_recipient
from .friends import FriendManager
from .identity import Identity
from .peer_manager import PeerConnection, PeerManager
from .protocol import (
    CAP_BLOCK_REPORTS,
    CAP_DELIVERY_RECEIPTS,
    MAX_PACKET_SIZE,
    MessageBlockedPayload,
    MessagePayload,
    Packet,
    PacketType,
)

logger = logging.getLogger(__name__)
MAX_MESSAGE_CONTENT_SIZE = 30 * 1024


class MessageRouter:
    def __init__(self, identity: Identity, peer_manager: PeerManager, db: Database, on_received: Callable[[dict], Awaitable[None]] | None = None, on_delivered: Callable[[str], Awaitable[None]] | None = None, friend_manager: FriendManager | None = None) -> None:
        self.identity, self.peer_manager, self.db = identity, peer_manager, db
        self.on_received = on_received
        self.on_delivered = on_delivered
        self.friend_manager = friend_manager or FriendManager(identity, peer_manager, db)

    async def send_message(self, recipient_id: str, plaintext: bytes) -> tuple[str, bool]:
        if len(plaintext) > MAX_MESSAGE_CONTENT_SIZE:
            raise ValueError("Message exceeds 30 KiB limit")
        peer = self.peer_manager.get_connected_peer(recipient_id)
        encryption_key = peer.encryption_public_key if peer is not None else None
        if encryption_key is None:
            stored = await self.db.get_peer(recipient_id)
            if stored and stored.get("public_key"):
                encryption_key = stored["public_key"]
        if encryption_key is None:
            raise ValueError("No known public key for recipient; connect once before sending offline")
        now = time.time()
        message = MessagePayload(str(uuid.uuid4()), self.identity.peer_id, recipient_id, now, 0, 0, b"")
        message.encrypted_content = encrypt_for_recipient(encryption_key, plaintext, message.associated_data())
        message.signature = self.identity.signing_private_key.sign(message.signed_bytes())
        encoded_message = message.encode()
        if len(encoded_message) > MAX_PACKET_SIZE:
            raise ValueError("Encrypted message exceeds packet limit")
        await self.db.save_message({
            "message_id": message.message_id, "sender_id": message.sender_id, "recipient_id": message.recipient_id,
            "content": plaintext.decode("utf-8"), "encrypted_content": message.encrypted_content,
            "created_at": message.created_at, "hop_count": 0, "max_hops": 0,
            "read_at": now, "queued": 1 if peer is None else 0,
        })
        await self.db.mark_message_seen(message.message_id)
        if peer is not None:
            await self.peer_manager.send_packet(peer, Packet(PacketType.MESSAGE, encoded_message))
            return message.message_id, False
        await self.db.add_to_outqueue(recipient_id, PacketType.MESSAGE.value, encoded_message, message.message_id)
        return message.message_id, True

    async def handle_packet(self, peer: PeerConnection, packet: Packet) -> None:
        if packet.type == PacketType.MESSAGE:
            await self._handle_message(peer, packet)
        elif packet.type == PacketType.MESSAGE_ACK:
            message_id = packet.payload.decode("ascii")
            await self.db.mark_message_delivered(message_id)
            if self.on_delivered:
                await self.on_delivered(message_id)
        elif packet.type in (
            PacketType.FRIEND_REQUEST,
            PacketType.FRIEND_REQUEST_RESPONSE,
            PacketType.FRIEND_REQUEST_CANCELLED,
            PacketType.MESSAGE_BLOCKED,
        ):
            await self.friend_manager.handle_packet(peer, packet)

    async def _handle_message(self, peer: PeerConnection, packet: Packet) -> None:
        message = MessagePayload.decode(packet.payload)
        if message.recipient_id != self.identity.peer_id:
            return
        if message.sender_id != peer.peer_id or peer.signing_public_key is None:
            raise ValueError("Message sender does not match authenticated peer")
        if not await self.friend_manager.is_friend(message.sender_id):
            await self._send_blocked_notice(peer, message)
            return
        if message.hop_count != 0 or message.max_hops != 0:
            raise ValueError("Invalid direct message metadata")
        if len(message.signature) != 64:
            raise ValueError("Invalid message signature")
        if await self.db.is_message_seen(message.message_id):
            await self._send_delivery_receipt(peer, message.message_id)
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
            "created_at": message.created_at,
            "hop_count": 0, "max_hops": 0, "read_at": None,
        })
        await self._send_delivery_receipt(peer, message.message_id)
        logger.info("Received encrypted message %s from %s", message.message_id, peer.peer_id)
        if self.on_received:
            await self.on_received({"message_id": message.message_id, "sender_id": message.sender_id, "content": content, "created_at": message.created_at})

    async def _send_delivery_receipt(self, peer: PeerConnection, message_id: str) -> None:
        # Only acknowledge delivery when both peers negotiated the capability.
        if not peer.supports(CAP_DELIVERY_RECEIPTS):
            return
        await self.peer_manager.send_packet(peer, Packet(PacketType.MESSAGE_ACK, message_id.encode("ascii")))

    async def _send_blocked_notice(self, peer: PeerConnection, message: MessagePayload) -> None:
        # Only report blocking when both peers negotiated the capability.
        if not peer.supports(CAP_BLOCK_REPORTS):
            return
        payload = MessageBlockedPayload(message.message_id, self.identity.peer_id, b"")
        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
        await self.peer_manager.send_packet(peer, Packet(PacketType.MESSAGE_BLOCKED, payload.encode()))
        logger.info("Blocked message %s from non-friend %s", message.message_id, peer.peer_id)
