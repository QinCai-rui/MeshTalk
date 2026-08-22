"""Room-backed, pairwise encrypted group messaging."""

from __future__ import annotations

import time
import uuid
from typing import Awaitable, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .database import Database
from .encryption import decrypt_as_recipient, encrypt_for_recipient
from .identity import Identity
from .peer_manager import PeerConnection, PeerManager
from .protocol import (
    CAP_GROUP_CHAT,
    MAX_PACKET_SIZE,
    GroupAckPayload,
    GroupLeavePayload,
    GroupMessagePayload,
    Packet,
    PacketType,
)
from .settings import Settings

MAX_GROUP_MESSAGE_CONTENT_SIZE = 30 * 1024
GroupEventCallback = Callable[[dict], Awaitable[None]]


class GroupRouter:
    def __init__(
        self,
        identity: Identity,
        peer_manager: PeerManager,
        db: Database,
        settings: Settings,
        on_event: GroupEventCallback | None = None,
    ) -> None:
        self.identity = identity
        self.peer_manager = peer_manager
        self.db = db
        self.settings = settings
        self.on_event = on_event

    async def sync_groups(self) -> None:
        for room in self.settings.rooms.values():
            if room.group_name is None:
                continue
            await self.db.upsert_group(room.id, room.group_name)
            await self.db.upsert_group_member(
                room.id, self.identity.peer_id, self.identity.display_name, group_capable=True
            )

    async def record_local_join(self, group_id: str) -> None:
        room = self.settings.rooms.get(group_id)
        if room is None or room.group_name is None:
            return
        await self._save_system_event(
            group_id, self.identity.peer_id, "You joined the group", "join"
        )
        await self._emit({
            "event": "group_member_joined", "group_id": group_id,
            "peer_id": self.identity.peer_id, "display_name": self.identity.display_name,
        })

    async def record_room_member(self, group_id: str, peer_id: str, announce_join: bool) -> None:
        room = self.settings.rooms.get(group_id)
        if room is None or room.group_name is None or peer_id == self.identity.peer_id:
            return
        peer = self.peer_manager.get_connected_peer(peer_id)
        stored = await self.db.get_peer(peer_id)
        display_name = peer.display_name if peer else (stored or {}).get("display_name", "Anonymous")
        capable = peer.supports(CAP_GROUP_CHAT) if peer else None
        await self.db.upsert_group_member(group_id, peer_id, display_name, group_capable=capable)
        if not announce_join:
            # Retained/fetched cards establish or refresh the roster. They do
            # not mean the peer joined after this device entered the group.
            await self.db.claim_group_join_announcement(group_id, peer_id)
            return
        if peer is not None or (stored and display_name != "Anonymous"):
            await self._announce_join(group_id, peer_id, display_name)

    async def peer_connected(self, peer_id: str) -> None:
        peer = self.peer_manager.get_connected_peer(peer_id)
        if peer is None:
            return
        for group in await self.db.get_groups(self.identity.peer_id):
            member = await self.db.get_group_member(group["group_id"], peer_id)
            if member and member["active"]:
                await self.db.upsert_group_member(
                    group["group_id"], peer_id, peer.display_name,
                    group_capable=peer.supports(CAP_GROUP_CHAT),
                )
                await self._announce_join(group["group_id"], peer_id, peer.display_name)

    async def _announce_join(self, group_id: str, peer_id: str, display_name: str) -> None:
        if not await self.db.claim_group_join_announcement(group_id, peer_id):
            return
        # The TUI resolves sender_id to the current roster name when rendering.
        # Persist the immutable ID so name changes do not rewrite group history.
        content = f"{peer_id} joined the group"
        await self._save_system_event(group_id, peer_id, content, "join")
        await self._emit({
            "event": "group_member_joined", "group_id": group_id,
            "peer_id": peer_id, "display_name": display_name,
        })

    async def send_message(self, group_id: str, plaintext: bytes) -> tuple[str, list[dict]]:
        if len(plaintext) > MAX_GROUP_MESSAGE_CONTENT_SIZE:
            raise ValueError("Message exceeds 30 KiB limit")
        room = self.settings.rooms.get(group_id)
        if room is None or room.group_name is None:
            raise ValueError("Unknown group")
        message_id = str(uuid.uuid4())
        created_at = time.time()
        content = plaintext.decode("utf-8")
        await self.db.save_group_message({
            "message_id": message_id,
            "group_id": group_id,
            "sender_id": self.identity.peer_id,
            "content": content,
            "created_at": created_at,
        })
        await self.db.mark_message_seen(message_id)
        members = [
            member for member in await self.db.get_group_members(group_id)
            if member["peer_id"] != self.identity.peer_id
        ]
        for member in members:
            status = "unavailable" if await self.db.is_peer_blocked(member["peer_id"]) else "pending"
            await self.db.set_group_delivery(message_id, member["peer_id"], status)
        for member in members:
            recipient_id = member["peer_id"]
            if await self.db.is_peer_blocked(recipient_id):
                continue
            peer = self.peer_manager.get_connected_peer(recipient_id)
            stored = await self.db.get_peer(recipient_id)
            key = peer.encryption_public_key if peer else (stored or {}).get("public_key")
            if not key or (peer and not peer.supports(CAP_GROUP_CHAT)) or member.get("group_capable") == 0:
                await self.db.set_group_delivery(message_id, recipient_id, "unavailable")
                continue
            try:
                payload = GroupMessagePayload(
                    message_id, group_id, self.identity.peer_id, recipient_id, created_at, b""
                )
                payload.encrypted_content = encrypt_for_recipient(key, plaintext, payload.associated_data())
                payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
                encoded = payload.encode()
                if len(encoded) > MAX_PACKET_SIZE:
                    raise ValueError("Encrypted group message exceeds packet limit")
            except Exception:
                await self.db.set_group_delivery(message_id, recipient_id, "unavailable")
                continue
            if peer:
                await self.db.set_group_delivery(message_id, recipient_id, "sent")
                try:
                    await self.peer_manager.send_packet(peer, Packet(PacketType.GROUP_MESSAGE, encoded))
                    continue
                except Exception:
                    pass
            try:
                await self.db.add_to_outqueue(
                    recipient_id, PacketType.GROUP_MESSAGE.value, encoded, message_id, group_id
                )
                await self.db.set_group_delivery(message_id, recipient_id, "queued")
            except Exception:
                await self.db.set_group_delivery(message_id, recipient_id, "unavailable")
        return message_id, await self.db.get_group_deliveries(message_id)

    async def handle_packet(self, peer: PeerConnection, packet: Packet) -> bool:
        if packet.type == PacketType.GROUP_MESSAGE:
            await self._handle_message(peer, GroupMessagePayload.decode(packet.payload))
        elif packet.type == PacketType.GROUP_MESSAGE_ACK:
            await self._handle_ack(peer, GroupAckPayload.decode(packet.payload))
        elif packet.type == PacketType.GROUP_LEAVE:
            await self._handle_leave(peer, GroupLeavePayload.decode(packet.payload))
        else:
            return False
        return True

    async def _handle_message(self, peer: PeerConnection, message: GroupMessagePayload) -> None:
        if not peer.supports(CAP_GROUP_CHAT):
            raise ValueError("Peer did not negotiate group chat")
        if await self.db.is_peer_blocked(peer.peer_id):
            return
        if message.recipient_id != self.identity.peer_id or message.sender_id != peer.peer_id:
            raise ValueError("Group message routing mismatch")
        room = self.settings.rooms.get(message.group_id)
        member = await self.db.get_group_member(message.group_id, peer.peer_id)
        if room is None or room.group_name is None or member is None or not member["active"]:
            raise ValueError("Sender is not an active group member")
        if peer.signing_public_key is None:
            raise ValueError("Missing authenticated signing key")
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(
                message.signature, message.signed_bytes()
            )
        except InvalidSignature as exc:
            raise ValueError("Invalid group message signature") from exc
        if await self.db.get_group_message(message.message_id) is None:
            plaintext = decrypt_as_recipient(
                self.identity.encryption_private_key, message.encrypted_content, message.associated_data()
            )
            content = plaintext.decode("utf-8")
            inserted = await self.db.save_group_message({
                "message_id": message.message_id,
                "group_id": message.group_id,
                "sender_id": message.sender_id,
                "content": content,
                "created_at": message.created_at,
                "received_at": time.time(),
            })
            await self.db.mark_message_seen(message.message_id)
            if inserted:
                await self._emit({
                    "event": "group_message", "message_id": message.message_id,
                    "group_id": message.group_id, "sender_id": message.sender_id,
                    "content": content, "created_at": message.created_at,
                })
        acknowledgement = GroupAckPayload(message.message_id, message.group_id, self.identity.peer_id)
        acknowledgement.signature = self.identity.signing_private_key.sign(acknowledgement.signed_bytes())
        await self.peer_manager.send_packet(
            peer, Packet(PacketType.GROUP_MESSAGE_ACK, acknowledgement.encode())
        )

    async def _handle_ack(self, peer: PeerConnection, acknowledgement: GroupAckPayload) -> None:
        if acknowledgement.recipient_id != peer.peer_id or peer.signing_public_key is None:
            raise ValueError("Group acknowledgement identity mismatch")
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(
                acknowledgement.signature, acknowledgement.signed_bytes()
            )
        except InvalidSignature as exc:
            raise ValueError("Invalid group acknowledgement signature") from exc
        message = await self.db.get_group_message(acknowledgement.message_id)
        deliveries = await self.db.get_group_deliveries(acknowledgement.message_id)
        if (
            message is None
            or message["group_id"] != acknowledgement.group_id
            or peer.peer_id not in {delivery["recipient_id"] for delivery in deliveries}
        ):
            raise ValueError("Unknown group acknowledgement")
        await self.db.set_group_delivery(acknowledgement.message_id, peer.peer_id, "delivered")
        await self._emit({
            "event": "group_delivered", "message_id": acknowledgement.message_id,
            "group_id": acknowledgement.group_id, "recipient_id": peer.peer_id,
        })

    async def leave_group(self, group_id: str) -> None:
        room = self.settings.rooms.get(group_id)
        if room is None or room.group_name is None:
            raise ValueError("Unknown group")
        recipients = [
            member for member in await self.db.get_group_members(group_id)
            if member["peer_id"] != self.identity.peer_id
        ]
        leave = GroupLeavePayload(str(uuid.uuid4()), group_id, self.identity.peer_id, time.time())
        leave.signature = self.identity.signing_private_key.sign(leave.signed_bytes())
        encoded = leave.encode()
        await self._save_system_event(
            group_id, self.identity.peer_id, "You left the group", "leave"
        )
        self.settings.leave_room(group_id)
        await self.db.remove_group(group_id)
        for member in recipients:
            peer = self.peer_manager.get_connected_peer(member["peer_id"])
            if peer and peer.supports(CAP_GROUP_CHAT):
                try:
                    await self.peer_manager.send_packet(peer, Packet(PacketType.GROUP_LEAVE, encoded))
                    continue
                except Exception:
                    pass
            if member.get("group_capable") == 1:
                await self.db.add_to_outqueue(
                    member["peer_id"], PacketType.GROUP_LEAVE.value, encoded, group_id=group_id
                )

    async def can_flush(self, peer: PeerConnection, item: dict) -> bool:
        if not item.get("group_id"):
            return True
        if not peer.supports(CAP_GROUP_CHAT):
            return False
        if item["packet_type"] == PacketType.GROUP_LEAVE.value:
            return True
        room = self.settings.rooms.get(item["group_id"])
        member = await self.db.get_group_member(item["group_id"], peer.peer_id)
        return bool(room and room.group_name and member and member["active"] and not await self.db.is_peer_blocked(peer.peer_id))

    async def _handle_leave(self, peer: PeerConnection, leave: GroupLeavePayload) -> None:
        if leave.peer_id != peer.peer_id or peer.signing_public_key is None:
            raise ValueError("Group leave identity mismatch")
        member = await self.db.get_group_member(leave.group_id, peer.peer_id)
        if member is None or not member["active"]:
            return
        if abs(time.time() - leave.created_at) > 86400 or await self.db.is_message_seen(leave.event_id):
            return
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(
                leave.signature, leave.signed_bytes()
            )
        except InvalidSignature as exc:
            raise ValueError("Invalid group leave signature") from exc
        await self.db.mark_message_seen(leave.event_id)
        await self.db.mark_group_member_left(leave.group_id, peer.peer_id)
        await self._save_system_event(
            leave.group_id, peer.peer_id,
            f"{peer.peer_id} left the group", "leave"
        )
        await self._emit({
            "event": "group_member_left", "group_id": leave.group_id,
            "peer_id": peer.peer_id, "display_name": peer.display_name,
        })

    async def _save_system_event(self, group_id: str, peer_id: str, content: str, kind: str) -> None:
        await self.db.save_group_message({
            "message_id": str(uuid.uuid4()), "group_id": group_id, "sender_id": peer_id,
            "content": content, "created_at": time.time(), "received_at": time.time(), "kind": kind,
        })

    async def _emit(self, event: dict) -> None:
        if self.on_event:
            await self.on_event(event)
