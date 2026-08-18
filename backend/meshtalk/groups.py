"""Named group chat over the existing authenticated peer transports."""

from __future__ import annotations

import hashlib
import os
import re
import time
import uuid
from typing import Awaitable, Callable

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .database import Database
from .encryption import decrypt_as_recipient, encrypt_for_recipient
from .identity import Identity
from .peer_manager import PeerConnection, PeerManager
from .protocol import (
    CAP_GROUP_CHAT,
    GroupMembershipPayload,
    GroupMessagePayload,
    GroupMetadataPayload,
    GroupRekeyPayload,
    Packet,
    PacketType,
)
from .settings import MAX_GROUP_MEMBERS, Room, Settings

MAX_GROUP_MESSAGE_BYTES = 30 * 1024


class GroupManager:
    def __init__(
        self,
        identity: Identity,
        settings: Settings,
        peer_manager: PeerManager,
        db: Database,
        on_received: Callable[[dict], Awaitable[None]] | None = None,
        on_changed: Callable[[str], Awaitable[None]] | None = None,
    ) -> None:
        self.identity = identity
        self.settings = settings
        self.peer_manager = peer_manager
        self.db = db
        self.on_received = on_received
        self.on_changed = on_changed

    def _room(self, group_id: str) -> Room:
        room = self.settings.groups.get(group_id)
        if room is None:
            raise ValueError("Unknown group ID")
        return room

    async def start(self) -> None:
        for room in self.settings.groups.values():
            await self.db.save_group(room.id, room.name, room.owner_id, room.epoch)
            await self.db.save_group_member(room.id, self.identity.peer_id, self.identity.display_name, room.epoch)

    async def flush_pending_rekeys(self, peer_id: str | None = None) -> None:
        for item in await self.db.get_pending_group_rekeys():
            if peer_id is not None and item["peer_id"] != peer_id:
                continue
            peer = self.peer_manager.get_connected_peer(item["peer_id"])
            if not peer or not peer.supports(CAP_GROUP_CHAT):
                continue
            try:
                await self.peer_manager.send_packet(peer, Packet(PacketType.GROUP_REKEY, item["payload"]))
                await self.db.remove_pending_group_rekey(item["group_id"], item["peer_id"], item["epoch"])
            except Exception:
                continue

    async def list_groups(self) -> list[dict]:
        unread = await self.db.get_group_unread_counts()
        result = []
        for room in self.settings.groups.values():
            members = await self.db.get_group_members(room.id)
            result.append({
                "group_id": room.id,
                "room_id": room.id,
                "name": room.name,
                "owner_id": room.owner_id,
                "epoch": room.epoch,
                "members": len(members),
                "unread_count": unread.get(room.id, 0),
                "is_owner": room.owner_id == self.identity.peer_id,
            })
        return result

    async def create_group(self, name: str) -> Room:
        room = self.settings.create_group(
            name,
            self.identity.peer_id,
            self.identity.signing_public_key_bytes(),
            self.identity.signing_private_key,
        )
        await self.db.save_group(room.id, room.name, room.owner_id, room.epoch)
        await self.db.save_group_member(room.id, self.identity.peer_id, self.identity.display_name, room.epoch)
        return room

    async def join_group(self, invite: str) -> Room:
        room = self.settings.join_group(invite)
        await self.db.save_group(room.id, room.name, room.owner_id, room.epoch)
        await self.db.save_group_member(room.id, self.identity.peer_id, self.identity.display_name, room.epoch)
        if room.owner_id and room.owner_id != self.identity.peer_id:
            owner = self.peer_manager.get_connected_peer(room.owner_id)
            if owner and owner.supports(CAP_GROUP_CHAT):
                await self.peer_manager.send_packet(owner, Packet(PacketType.GROUP_MEMBERSHIP, await self._join_payload(room)))
        return room

    async def leave_group(self, group_id: str) -> None:
        room = self._room(group_id)
        if room.owner_id == self.identity.peer_id:
            members = await self.db.get_group_members(group_id)
            for member in members:
                if member["peer_id"] != self.identity.peer_id:
                    peer = self.peer_manager.get_connected_peer(member["peer_id"])
                    if peer:
                        await self.peer_manager.send_packet(peer, Packet(PacketType.GROUP_MEMBERSHIP, await self._membership_payload(room, [])))
        else:
            owner = self.peer_manager.get_connected_peer(room.owner_id)
            if owner and owner.supports(CAP_GROUP_CHAT):
                payload = GroupMembershipPayload(room.id, room.epoch, room.owner_id, [], b"")
                payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
                await self.peer_manager.send_packet(owner, Packet(PacketType.GROUP_MEMBERSHIP, payload.encode()))
        self.settings.leave_room(group_id)

    async def rename_group(self, group_id: str, name: str) -> Room:
        room = self._room(group_id)
        if room.owner_id != self.identity.peer_id:
            raise ValueError("Only the group owner can rename the group")
        room = self.settings.rename_group(group_id, name)
        await self.db.save_group(room.id, room.name, room.owner_id, room.epoch)
        payload = self._metadata_payload(room)
        await self._fanout(room, Packet(PacketType.GROUP_METADATA, payload))
        return room

    async def remove_member(self, group_id: str, peer_id: str) -> Room:
        room = self._room(group_id)
        if room.owner_id != self.identity.peer_id:
            raise ValueError("Only the group owner can remove members")
        if peer_id == self.identity.peer_id:
            raise ValueError("The owner cannot remove itself")
        await self.db.remove_group_member(group_id, peer_id)
        room = self.settings.rotate_group(group_id, os.urandom(32), room.epoch + 1, self.identity.signing_private_key)
        await self.db.save_group(room.id, room.name, room.owner_id, room.epoch)
        await self.db.save_group_member(group_id, self.identity.peer_id, self.identity.display_name, room.epoch)
        await self._send_rekeys(room)
        return room

    async def send_group(self, group_id: str, content: str) -> str:
        room = self._room(group_id)
        raw = content.encode()
        if not raw or len(raw) > MAX_GROUP_MESSAGE_BYTES:
            raise ValueError("Group message is empty or exceeds the 30 KiB limit")
        members = await self.db.get_group_members(group_id)
        peers = [self.peer_manager.get_connected_peer(m["peer_id"]) for m in members if m["peer_id"] != self.identity.peer_id]
        peers = [peer for peer in peers if peer and peer.supports(CAP_GROUP_CHAT)]
        if not peers:
            raise ValueError("No reachable group members")
        message_id = str(uuid.uuid4())
        nonce = os.urandom(12)
        aad = self._message_aad(group_id, room.epoch, message_id, self.identity.peer_id)
        ciphertext = AESGCM(room.secret).encrypt(nonce, raw, aad)
        payload = GroupMessagePayload(group_id, room.epoch, message_id, self.identity.peer_id, time.time(), nonce, ciphertext, b"")
        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
        await self.db.save_group_message({
            "message_id": message_id, "group_id": group_id, "sender_id": self.identity.peer_id,
            "sender_name": self.identity.display_name, "content": content, "created_at": payload.created_at,
            "epoch": room.epoch, "read_at": payload.created_at,
        })
        packet = Packet(PacketType.GROUP_MESSAGE, payload.encode())
        for peer in peers:
            await self.peer_manager.send_packet(peer, packet)
        return message_id

    async def handle_packet(self, peer: PeerConnection, packet: Packet) -> None:
        if not peer.supports(CAP_GROUP_CHAT):
            return
        if packet.type == PacketType.GROUP_MESSAGE:
            await self._handle_message(peer, GroupMessagePayload.decode(packet.payload))
        elif packet.type == PacketType.GROUP_MEMBERSHIP:
            await self._handle_membership(peer, GroupMembershipPayload.decode(packet.payload))
        elif packet.type == PacketType.GROUP_METADATA:
            await self._handle_metadata(peer, GroupMetadataPayload.decode(packet.payload))
        elif packet.type == PacketType.GROUP_REKEY:
            await self._handle_rekey(peer, GroupRekeyPayload.decode(packet.payload))

    async def _handle_message(self, peer: PeerConnection, payload: GroupMessagePayload) -> None:
        room = self.settings.groups.get(payload.group_id)
        if room is None or payload.epoch != room.epoch or payload.sender_id != peer.peer_id:
            return
        member = next((m for m in await self.db.get_group_members(payload.group_id) if m["peer_id"] == peer.peer_id), None)
        if member is None or peer.signing_public_key is None:
            return
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(payload.signature, payload.signed_bytes())
            content = AESGCM(room.secret).decrypt(payload.nonce, payload.ciphertext, self._message_aad(payload.group_id, payload.epoch, payload.message_id, payload.sender_id)).decode()
        except (InvalidSignature, InvalidTag, UnicodeDecodeError) as exc:
            raise ValueError("Invalid group message") from exc
        if await self.db.is_group_message_seen(payload.message_id):
            return
        await self.db.save_group_message({
            "message_id": payload.message_id, "group_id": payload.group_id, "sender_id": payload.sender_id,
            "sender_name": member["display_name"], "content": content, "created_at": payload.created_at,
            "epoch": payload.epoch,
        })
        if self.on_received:
            mention = bool(re.search(
                rf"(?:^|\s)@{re.escape(self.identity.display_name)}(?=\s|$|[.,!?;:])",
                content,
                flags=re.IGNORECASE,
            ))
            await self.on_received({
                "conversation": "group", "group_id": payload.group_id, "message_id": payload.message_id,
                "sender_id": payload.sender_id, "sender_name": member["display_name"], "content": content,
                "created_at": payload.created_at, "mention": mention,
            })
        if self.on_changed:
            await self.on_changed(payload.group_id)

    async def _handle_membership(self, peer: PeerConnection, payload: GroupMembershipPayload) -> None:
        room = self.settings.groups.get(payload.group_id)
        if room is None or peer.signing_public_key is None:
            return
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(payload.signature, payload.signed_bytes())
        except InvalidSignature as exc:
            raise ValueError("Invalid group membership signature") from exc
        if peer.peer_id == room.owner_id:
            if payload.epoch < room.epoch:
                return
            if not payload.members:
                if room.owner_id != self.identity.peer_id:
                    self.settings.leave_room(payload.group_id)
                    if self.on_changed:
                        await self.on_changed(payload.group_id)
                return
            for member in payload.members:
                member_id = member.get("peer_id")
                if member_id and len(await self.db.get_group_members(payload.group_id)) < MAX_GROUP_MEMBERS:
                    await self.db.save_group_member(payload.group_id, member_id, member.get("display_name", "Anonymous"), payload.epoch)
            if payload.epoch > room.epoch:
                self.settings.apply_group_rekey(payload.group_id, room.secret, payload.epoch)
                await self.db.save_group(payload.group_id, room.name, room.owner_id, payload.epoch)
            if self.on_changed:
                await self.on_changed(payload.group_id)
            return
        if room.owner_id != self.identity.peer_id or payload.owner_id != self.identity.peer_id:
            return
        if not payload.members:
            await self.db.remove_group_member(payload.group_id, peer.peer_id)
            await self._send_membership_snapshot(room)
            return
        if len(await self.db.get_group_members(payload.group_id)) >= MAX_GROUP_MEMBERS and not any(
            member.get("peer_id") == peer.peer_id for member in payload.members
        ):
            return
        for member in payload.members:
            if member.get("peer_id") == peer.peer_id:
                await self.db.save_group_member(payload.group_id, peer.peer_id, member.get("display_name", peer.display_name), room.epoch)
        await self._send_membership_snapshot(room)
        if self.on_changed:
            await self.on_changed(payload.group_id)

    async def _handle_metadata(self, peer: PeerConnection, payload: GroupMetadataPayload) -> None:
        room = self.settings.groups.get(payload.group_id)
        if room is None or payload.owner_id != room.owner_id or peer.peer_id != room.owner_id or peer.signing_public_key is None:
            return
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(payload.signature, payload.signed_bytes())
        except InvalidSignature as exc:
            raise ValueError("Invalid group metadata signature") from exc
        if payload.epoch < room.epoch:
            return
        updated = Room(room.room_id, room.secret, payload.name, room.owner_id, room.owner_signing_public_key, payload.epoch, room.invite_signature)
        self.settings.rooms[payload.group_id] = updated
        self.settings.save()
        await self.db.save_group(payload.group_id, payload.name, payload.owner_id, payload.epoch)
        if self.on_changed:
            await self.on_changed(payload.group_id)

    async def _handle_rekey(self, peer: PeerConnection, payload: GroupRekeyPayload) -> None:
        room = self.settings.groups.get(payload.group_id)
        if room is None or payload.recipient_id != self.identity.peer_id or payload.owner_id != room.owner_id or peer.peer_id != room.owner_id or peer.signing_public_key is None:
            return
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(payload.signature, payload.signed_bytes())
            secret = decrypt_as_recipient(
                self.identity.encryption_private_key,
                payload.encrypted_key,
                self._rekey_aad(payload.group_id, payload.epoch, payload.recipient_id),
            )
        except (InvalidSignature, ValueError, InvalidTag) as exc:
            raise ValueError("Invalid group rekey") from exc
        if payload.epoch <= room.epoch or len(secret) != 32:
            return
        self.settings.apply_group_rekey(payload.group_id, secret, payload.epoch)
        await self.db.save_group(payload.group_id, room.name, room.owner_id, payload.epoch)
        await self.db.save_group_member(payload.group_id, self.identity.peer_id, self.identity.display_name, payload.epoch)
        if self.on_changed:
            await self.on_changed(payload.group_id)

    async def _send_rekeys(self, room: Room) -> None:
        for member in await self.db.get_group_members(room.id):
            if member["peer_id"] == self.identity.peer_id:
                continue
            peer = self.peer_manager.get_connected_peer(member["peer_id"])
            if not peer or peer.encryption_public_key is None or not peer.supports(CAP_GROUP_CHAT):
                continue
            payload = GroupRekeyPayload(room.id, room.epoch, self.identity.peer_id, member["peer_id"], b"", b"")
            payload.encrypted_key = encrypt_for_recipient(
                peer.encryption_public_key,
                room.secret,
                self._rekey_aad(room.id, room.epoch, member["peer_id"]),
            )
            payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
            try:
                await self.peer_manager.send_packet(peer, Packet(PacketType.GROUP_REKEY, payload.encode()))
                await self.db.remove_pending_group_rekey(room.id, member["peer_id"], room.epoch)
            except Exception:
                await self.db.save_pending_group_rekey(room.id, member["peer_id"], room.epoch, payload.encode())

    async def _send_membership_snapshot(self, room: Room) -> None:
        await self._fanout(room, Packet(PacketType.GROUP_MEMBERSHIP, await self._membership_payload(room)))

    async def _join_payload(self, room: Room) -> bytes:
        payload = GroupMembershipPayload(room.id, room.epoch, room.owner_id, [{"peer_id": self.identity.peer_id, "display_name": self.identity.display_name}], b"")
        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
        return payload.encode()

    async def _membership_payload(self, room: Room, members: list[dict] | None = None) -> bytes:
        members = members if members is not None else await self.db.get_group_members(room.id)
        payload = GroupMembershipPayload(room.id, room.epoch, room.owner_id, [{"peer_id": m["peer_id"], "display_name": m["display_name"]} for m in members], b"")
        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
        return payload.encode()

    def _metadata_payload(self, room: Room) -> bytes:
        payload = GroupMetadataPayload(room.id, room.name, room.owner_id, room.epoch, b"")
        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
        return payload.encode()

    async def _fanout(self, room: Room, packet: Packet) -> None:
        for member in await self.db.get_group_members(room.id):
            if member["peer_id"] == self.identity.peer_id:
                continue
            peer = self.peer_manager.get_connected_peer(member["peer_id"])
            if peer and peer.supports(CAP_GROUP_CHAT):
                await self.peer_manager.send_packet(peer, packet)

    @staticmethod
    def _message_aad(group_id: str, epoch: int, message_id: str, sender_id: str) -> bytes:
        return f"meshtalk-group-v1:{group_id}:{epoch}:{message_id}:{sender_id}".encode()

    @staticmethod
    def _rekey_aad(group_id: str, epoch: int, recipient_id: str) -> bytes:
        return f"meshtalk-group-rekey-v1:{group_id}:{epoch}:{recipient_id}".encode()
