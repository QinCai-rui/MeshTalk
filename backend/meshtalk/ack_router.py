"""Explicit, toggleable message acknowledgements for DMs and groups."""

from __future__ import annotations

import time
from typing import Awaitable, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .database import Database
from .friends import FriendManager
from .identity import Identity
from .peer_manager import PeerConnection, PeerManager
from .protocol import (
    ACK_TARGET_KINDS,
    CAP_GROUP_CHAT,
    CAP_MESSAGE_ACKNOWLEDGEMENTS,
    GroupAcknowledgePayload,
    MessageAcknowledgePayload,
    Packet,
    PacketType,
)
from .settings import Settings

AckEventCallback = Callable[[dict], Awaitable[None]]


class AckRouter:
    def __init__(
        self,
        identity: Identity,
        peer_manager: PeerManager,
        db: Database,
        settings: Settings,
        friend_manager: FriendManager,
        on_event: AckEventCallback | None = None,
    ) -> None:
        self.identity = identity
        self.peer_manager = peer_manager
        self.db = db
        self.settings = settings
        self.friend_manager = friend_manager
        self.on_event = on_event

    # ------------------------------------------------------------------ send
    async def send_direct(
        self, recipient_id: str, target_id: str, kind: str, acknowledged: bool
    ) -> dict:
        if kind not in ACK_TARGET_KINDS:
            raise ValueError("kind must be 'message' or 'file'")
        if await self.db.is_peer_blocked(recipient_id):
            raise ValueError("Peer is blocked")
        if recipient_id != self.identity.peer_id and not await self.friend_manager.is_friend(recipient_id):
            raise ValueError("Peer is not a friend")
        peer = self.peer_manager.get_connected_peer(recipient_id)
        if peer is not None and not peer.supports(CAP_MESSAGE_ACKNOWLEDGEMENTS):
            raise ValueError("Peer does not support acknowledgements")
        if peer is None and not await self.db.peer_supports(recipient_id, CAP_MESSAGE_ACKNOWLEDGEMENTS):
            raise ValueError("Peer does not support acknowledgements")
        created_at = time.time()
        # Persist locally so the acker sees their own toggle state after reload.
        if acknowledged:
            await self.db.set_message_ack(target_id, self.identity.peer_id, kind, created_at)
        else:
            await self.db.remove_message_ack(target_id, self.identity.peer_id)
        payload = MessageAcknowledgePayload(
            target_id, kind, self.identity.peer_id, acknowledged, created_at
        )
        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
        encoded = payload.encode()
        if peer is not None:
            await self.peer_manager.send_packet(peer, Packet(PacketType.MESSAGE_ACKNOWLEDGE, encoded))
        else:
            await self.db.add_to_outqueue(recipient_id, PacketType.MESSAGE_ACKNOWLEDGE.value, encoded, target_id)
        return {"target_id": target_id, "kind": kind, "acknowledged": acknowledged}

    async def send_group(
        self, group_id: str, target_id: str, kind: str, acknowledged: bool
    ) -> dict:
        if kind not in ACK_TARGET_KINDS:
            raise ValueError("kind must be 'message' or 'file'")
        room = self.settings.rooms.get(group_id)
        if room is None or room.group_name is None:
            raise ValueError("Unknown group")
        created_at = time.time()
        if acknowledged:
            await self.db.set_group_message_ack(target_id, group_id, self.identity.peer_id, kind, created_at)
        else:
            await self.db.remove_group_message_ack(target_id, group_id, self.identity.peer_id)
        sent = 0
        for member in await self.db.get_group_members(group_id):
            recipient_id = member["peer_id"]
            if recipient_id == self.identity.peer_id or not member["active"]:
                continue
            if await self.db.is_peer_blocked(recipient_id):
                continue
            peer = self.peer_manager.get_connected_peer(recipient_id)
            if peer is not None and (
                not peer.supports(CAP_GROUP_CHAT) or not peer.supports(CAP_MESSAGE_ACKNOWLEDGEMENTS)
            ):
                continue
            try:
                payload = GroupAcknowledgePayload(
                    target_id, group_id, kind, self.identity.peer_id, acknowledged, created_at
                )
                payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
                encoded = payload.encode()
            except Exception:
                continue
            if peer is not None:
                try:
                    await self.peer_manager.send_packet(peer, Packet(PacketType.GROUP_ACKNOWLEDGE, encoded))
                    sent += 1
                    continue
                except Exception:
                    pass
            try:
                await self.db.add_to_outqueue(
                    recipient_id, PacketType.GROUP_ACKNOWLEDGE.value, encoded, target_id, group_id
                )
                sent += 1
            except Exception:
                continue
        return {"target_id": target_id, "group_id": group_id, "kind": kind, "acknowledged": acknowledged, "sent": sent}

    # ------------------------------------------------------------------ receive
    async def handle_packet(self, peer: PeerConnection, packet: Packet) -> bool:
        if packet.type == PacketType.MESSAGE_ACKNOWLEDGE:
            await self._handle_direct(peer, MessageAcknowledgePayload.decode(packet.payload))
            return True
        if packet.type == PacketType.GROUP_ACKNOWLEDGE:
            await self._handle_group(peer, GroupAcknowledgePayload.decode(packet.payload))
            return True
        return False

    async def _handle_direct(self, peer: PeerConnection, payload: MessageAcknowledgePayload) -> None:
        if not peer.supports(CAP_MESSAGE_ACKNOWLEDGEMENTS):
            raise ValueError("Peer did not negotiate acknowledgements")
        if payload.acker_id != peer.peer_id or peer.signing_public_key is None:
            raise ValueError("Acknowledgement sender mismatch")
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(
                payload.signature, payload.signed_bytes()
            )
        except InvalidSignature as exc:
            raise ValueError("Invalid acknowledgement signature") from exc
        if not await self.friend_manager.is_friend(peer.peer_id) or await self.db.is_peer_blocked(peer.peer_id):
            return
        # Store regardless of whether the target row still exists so acks that
        # arrive before (or after deletion of) the original don't crash and can
        # still be joined when history is listed.
        if payload.acknowledged:
            await self.db.set_message_ack(payload.target_id, payload.acker_id, payload.kind, payload.created_at)
        else:
            await self.db.remove_message_ack(payload.target_id, payload.acker_id)
        if self.on_event:
            await self._emit({
                "event": "message_acknowledged",
                "target_id": payload.target_id,
                "message_id": payload.target_id,
                "kind": payload.kind,
                "acker_id": payload.acker_id,
                "display_name": peer.display_name,
                "acknowledged": payload.acknowledged,
                "created_at": payload.created_at,
            })

    async def _handle_group(self, peer: PeerConnection, payload: GroupAcknowledgePayload) -> None:
        if not peer.supports(CAP_GROUP_CHAT) or not peer.supports(CAP_MESSAGE_ACKNOWLEDGEMENTS):
            raise ValueError("Peer did not negotiate group acknowledgements")
        if payload.acker_id != peer.peer_id or peer.signing_public_key is None:
            raise ValueError("Group acknowledgement sender mismatch")
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(
                payload.signature, payload.signed_bytes()
            )
        except InvalidSignature as exc:
            raise ValueError("Invalid group acknowledgement signature") from exc
        if await self.db.is_peer_blocked(peer.peer_id):
            return
        room = self.settings.rooms.get(payload.group_id)
        member = await self.db.get_group_member(payload.group_id, peer.peer_id)
        if room is None or room.group_name is None or member is None or not member["active"]:
            raise ValueError("Acker is not an active group member")
        if payload.acknowledged:
            await self.db.set_group_message_ack(
                payload.target_id, payload.group_id, payload.acker_id, payload.kind, payload.created_at
            )
        else:
            await self.db.remove_group_message_ack(payload.target_id, payload.group_id, payload.acker_id)
        if self.on_event:
            await self._emit({
                "event": "group_message_acknowledged",
                "target_id": payload.target_id,
                "message_id": payload.target_id,
                "group_id": payload.group_id,
                "kind": payload.kind,
                "acker_id": payload.acker_id,
                "display_name": peer.display_name,
                "acknowledged": payload.acknowledged,
                "created_at": payload.created_at,
            })

    async def _emit(self, event: dict) -> None:
        if self.on_event:
            await self.on_event(event)

    async def can_flush(self, peer: PeerConnection, item: dict) -> bool:
        """Outqueue flush gate: drop queued acks when the peer lacks the capability."""
        try:
            packet_type = PacketType(item.get("packet_type", 0))
        except ValueError:
            return True
        if packet_type in (PacketType.MESSAGE_ACKNOWLEDGE, PacketType.GROUP_ACKNOWLEDGE):
            return peer.supports(CAP_MESSAGE_ACKNOWLEDGEMENTS)
        return True
