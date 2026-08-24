"""Transient, encrypted peer typing indicators."""

from __future__ import annotations

import json
import re
import time
from typing import Awaitable, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .database import Database
from .encryption import decrypt_as_recipient, encrypt_for_recipient
from .friends import FriendManager
from .identity import Identity
from .peer_manager import PeerConnection, PeerManager
from .protocol import CAP_GROUP_CHAT, CAP_TYPING_INDICATORS, Packet, PacketType, TypingPayload
from .settings import Settings

TYPING_FRESHNESS_SECONDS = 30
TypingEventCallback = Callable[[dict], Awaitable[None]]


class TypingRouter:
    def __init__(
        self,
        identity: Identity,
        peer_manager: PeerManager,
        db: Database,
        settings: Settings,
        friend_manager: FriendManager,
        on_event: TypingEventCallback | None = None,
    ) -> None:
        self.identity = identity
        self.peer_manager = peer_manager
        self.db = db
        self.settings = settings
        self.friend_manager = friend_manager
        self.on_event = on_event

    async def send_direct(self, recipient_id: str, is_typing: bool) -> bool:
        if recipient_id == self.identity.peer_id or not await self.friend_manager.is_friend(recipient_id):
            return False
        if await self.db.is_peer_blocked(recipient_id):
            return False
        peer = self.peer_manager.get_connected_peer(recipient_id)
        if peer is None or peer.encryption_public_key is None or not peer.supports(CAP_TYPING_INDICATORS):
            return False
        try:
            await self._send(peer, None, is_typing)
            return True
        except Exception:
            return False

    async def send_group(self, group_id: str, is_typing: bool) -> int:
        room = self.settings.rooms.get(group_id)
        if room is None or room.group_name is None:
            raise ValueError("Unknown group")
        sent = 0
        for member in await self.db.get_group_members(group_id):
            recipient_id = member["peer_id"]
            if (
                recipient_id == self.identity.peer_id
                or not member["active"]
                or await self.db.is_peer_blocked(recipient_id)
            ):
                continue
            peer = self.peer_manager.get_connected_peer(recipient_id)
            if (
                peer is None
                or peer.encryption_public_key is None
                or not peer.supports(CAP_GROUP_CHAT)
                or not peer.supports(CAP_TYPING_INDICATORS)
            ):
                continue
            try:
                await self._send(peer, group_id, is_typing)
                sent += 1
            except Exception:
                continue
        return sent

    async def _send(self, peer: PeerConnection, group_id: str | None, is_typing: bool) -> None:
        payload = TypingPayload(self.identity.peer_id, peer.peer_id, time.time(), b"")
        plaintext = json.dumps(
            {"group_id": group_id, "is_typing": is_typing}, separators=(",", ":"), sort_keys=True
        ).encode()
        payload.encrypted_content = encrypt_for_recipient(
            peer.encryption_public_key, plaintext, payload.associated_data()
        )
        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
        await self.peer_manager.send_packet(peer, Packet(PacketType.TYPING, payload.encode()))

    async def handle_packet(self, peer: PeerConnection, packet: Packet) -> bool:
        if packet.type != PacketType.TYPING:
            return False
        if not peer.supports(CAP_TYPING_INDICATORS):
            raise ValueError("Peer did not negotiate typing indicators")
        payload = TypingPayload.decode(packet.payload)
        if payload.recipient_id != self.identity.peer_id or payload.sender_id != peer.peer_id:
            raise ValueError("Typing routing mismatch")
        if abs(time.time() - payload.created_at) > TYPING_FRESHNESS_SECONDS:
            raise ValueError("Stale typing indicator")
        if peer.signing_public_key is None:
            raise ValueError("Missing authenticated signing key")
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(
                payload.signature, payload.signed_bytes()
            )
            body = json.loads(decrypt_as_recipient(
                self.identity.encryption_private_key, payload.encrypted_content, payload.associated_data()
            ))
        except (InvalidSignature, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Invalid encrypted typing indicator") from exc
        if not isinstance(body, dict):
            raise ValueError("Invalid typing content")
        group_id = body.get("group_id")
        is_typing = body.get("is_typing")
        if group_id is not None and (not isinstance(group_id, str) or not re.fullmatch(r"[a-f0-9]{32}", group_id)):
            raise ValueError("Invalid typing group")
        if not isinstance(is_typing, bool):
            raise ValueError("Invalid typing state")
        if group_id is None:
            if not await self.friend_manager.is_friend(peer.peer_id) or await self.db.is_peer_blocked(peer.peer_id):
                return True
        else:
            room = self.settings.rooms.get(group_id)
            member = await self.db.get_group_member(group_id, peer.peer_id)
            if room is None or room.group_name is None or member is None or not member["active"] or await self.db.is_peer_blocked(peer.peer_id):
                return True
        if self.on_event:
            await self.on_event({
                "event": "typing", "sender_id": peer.peer_id,
                "display_name": peer.display_name, "group_id": group_id,
                "is_typing": is_typing, "created_at": payload.created_at,
            })
        return True
