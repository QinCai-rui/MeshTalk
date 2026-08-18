"""Friend requests and friend-only message delivery.

Messages are only accepted from peers on the local friend list. A peer who is
not a friend can still send a friend request; the recipient accepts or declines
it. Once accepted, both sides treat each other as friends and chat messages
flow normally.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Awaitable, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .database import Database
from .identity import Identity
from .peer_manager import PeerConnection, PeerManager
from .protocol import (
    CAP_BLOCK_REPORTS,
    CAP_FRIEND_REQUESTS,
    FriendRequestCancelledPayload,
    FriendRequestPayload,
    FriendRequestResponsePayload,
    MessageBlockedPayload,
    Packet,
    PacketType,
)

logger = logging.getLogger(__name__)
MAX_FRIEND_NOTE_LENGTH = 1024


class FriendManager:
    def __init__(
        self,
        identity: Identity,
        peer_manager: PeerManager,
        db: Database,
        on_friend_request: Callable[[dict], Awaitable[None]] | None = None,
        on_friend_response: Callable[[dict], Awaitable[None]] | None = None,
        on_friend_cancelled: Callable[[dict], Awaitable[None]] | None = None,
        on_message_blocked: Callable[[dict], Awaitable[None]] | None = None,
    ) -> None:
        self.identity, self.peer_manager, self.db = identity, peer_manager, db
        self.on_friend_request = on_friend_request
        self.on_friend_response = on_friend_response
        self.on_friend_cancelled = on_friend_cancelled
        self.on_message_blocked = on_message_blocked

    async def is_friend(self, peer_id: str) -> bool:
        return await self.db.is_friend(peer_id)

    async def send_friend_request(self, peer_id: str, note: str = "") -> str:
        note = (note or "").strip()
        if len(note) > MAX_FRIEND_NOTE_LENGTH:
            raise ValueError("Friend request note is too long")
        if peer_id == self.identity.peer_id:
            raise ValueError("Cannot send a friend request to yourself")
        if await self.is_friend(peer_id):
            raise ValueError("This peer is already your friend")
        if await self.db.is_peer_blocked(peer_id):
            raise ValueError("This peer is blocked; unblock them to send a friend request")
        if await self.db.get_pending_request_with(peer_id, "outgoing"):
            raise ValueError("A friend request to this peer is already pending")
        peer = self.peer_manager.get_connected_peer(peer_id)
        if peer is not None and not peer.supports(CAP_FRIEND_REQUESTS):
            raise ValueError("Peer does not support friend requests")
        now = time.time()
        payload = FriendRequestPayload(str(uuid.uuid4()), self.identity.peer_id, note, now, b"")
        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
        stored = await self.db.get_peer(peer_id)
        recipient_name = peer.display_name if peer is not None else (stored["display_name"] if stored else "Anonymous")
        await self.db.save_friend_request({
            "request_id": payload.request_id,
            "sender_id": self.identity.peer_id,
            "sender_name": self.identity.display_name,
            "recipient_id": peer_id,
            "recipient_name": recipient_name,
            "note": note or None,
            "created_at": now,
            "direction": "outgoing",
            "status": "pending",
        })
        if peer is not None:
            await self.peer_manager.send_packet(peer, Packet(PacketType.FRIEND_REQUEST, payload.encode()))
            logger.info("Sent friend request %s to %s", payload.request_id, peer_id)
        else:
            await self.db.add_to_outqueue(peer_id, PacketType.FRIEND_REQUEST.value, payload.encode(), payload.request_id)
            logger.info("Queued friend request %s to %s (offline)", payload.request_id, peer_id)
        return payload.request_id

    async def respond_to_friend_request(self, request_id: str, accept: bool) -> None:
        request = await self.db.get_friend_request(request_id)
        if request is None or request["direction"] != "incoming" or request["status"] != "pending":
            raise ValueError("Unknown or already answered friend request")
        requester_id = request["sender_id"]
        peer = self.peer_manager.get_connected_peer(requester_id)
        if peer is not None and not peer.supports(CAP_FRIEND_REQUESTS):
            raise ValueError("Peer does not support friend requests")
        payload = FriendRequestResponsePayload(request_id, self.identity.peer_id, accept, b"")
        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
        await self.db.update_friend_request_status(request_id, "accepted" if accept else "declined")
        if accept:
            await self.db.add_friend(requester_id, request["sender_name"])
            # If we also sent an outgoing request to this peer, cancel it
            outgoing = await self.db.get_pending_request_with(requester_id, "outgoing")
            if outgoing:
                await self.db.cancel_friend_request(outgoing["request_id"])
                cancel_payload = FriendRequestCancelledPayload(outgoing["request_id"], self.identity.peer_id, b"")
                cancel_payload.signature = self.identity.signing_private_key.sign(cancel_payload.signed_bytes())
                cancel_peer = self.peer_manager.get_connected_peer(requester_id)
                if cancel_peer:
                    await self.peer_manager.send_packet(cancel_peer, Packet(PacketType.FRIEND_REQUEST_CANCELLED, cancel_payload.encode()))
                else:
                    await self.db.add_to_outqueue(requester_id, PacketType.FRIEND_REQUEST_CANCELLED.value, cancel_payload.encode(), outgoing["request_id"])
        if peer is not None:
            await self.peer_manager.send_packet(peer, Packet(PacketType.FRIEND_REQUEST_RESPONSE, payload.encode()))
            logger.info(
                "Responded to friend request %s from %s: %s",
                request_id,
                requester_id,
                "accepted" if accept else "declined",
            )
        else:
            await self.db.add_to_outqueue(requester_id, PacketType.FRIEND_REQUEST_RESPONSE.value, payload.encode(), request_id)
            logger.info("Queued friend request response %s to %s (offline)", request_id, requester_id)

    async def cancel_friend_request(self, request_id: str) -> None:
        request = await self.db.get_friend_request(request_id)
        if request is None or request["direction"] != "outgoing" or request["status"] != "pending":
            raise ValueError("Unknown or already answered friend request")
        recipient_id = request["recipient_id"]
        peer = self.peer_manager.get_connected_peer(recipient_id)
        if peer is not None and not peer.supports(CAP_FRIEND_REQUESTS):
            raise ValueError("Peer does not support friend requests")
        payload = FriendRequestCancelledPayload(request_id, self.identity.peer_id, b"")
        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
        await self.db.cancel_friend_request(request_id)
        if peer is not None:
            await self.peer_manager.send_packet(peer, Packet(PacketType.FRIEND_REQUEST_CANCELLED, payload.encode()))
            logger.info("Cancelled friend request %s to %s", request_id, recipient_id)
        else:
            await self.db.add_to_outqueue(recipient_id, PacketType.FRIEND_REQUEST_CANCELLED.value, payload.encode(), request_id)
            logger.info("Queued friend request cancel %s to %s (offline)", request_id, recipient_id)

    async def unfriend(self, peer_id: str) -> None:
        if not await self.is_friend(peer_id):
            raise ValueError("This peer is not your friend")
        await self.db.remove_friend(peer_id)
        logger.info("Removed %s as a friend", peer_id)

    async def block_peer(self, peer_id: str) -> None:
        if peer_id == self.identity.peer_id:
            raise ValueError("You cannot block yourself")
        if await self.db.is_peer_blocked(peer_id):
            raise ValueError("This peer is already blocked")
        display_name = "Anonymous"
        stored = await self.db.get_peer(peer_id)
        if stored is not None:
            display_name = stored["display_name"]
        else:
            peer = self.peer_manager.get_connected_peer(peer_id)
            if peer is not None:
                display_name = peer.display_name
        await self.db.remove_friend(peer_id)
        await self.db.decline_pending_requests_with(peer_id)
        await self.db.block_peer(peer_id, display_name)
        logger.info("Blocked %s", peer_id)

    async def unblock_peer(self, peer_id: str) -> None:
        if not await self.db.is_peer_blocked(peer_id):
            raise ValueError("This peer is not blocked")
        await self.db.unblock_peer(peer_id)
        logger.info("Unblocked %s", peer_id)

    async def is_peer_blocked(self, peer_id: str) -> bool:
        return await self.db.is_peer_blocked(peer_id)

    async def get_blocked_peers(self) -> list[dict]:
        return await self.db.get_blocked_peers()

    async def handle_packet(self, peer: PeerConnection, packet: Packet) -> None:
        if packet.type == PacketType.FRIEND_REQUEST:
            await self._handle_friend_request(peer, FriendRequestPayload.decode(packet.payload))
        elif packet.type == PacketType.FRIEND_REQUEST_RESPONSE:
            await self._handle_friend_response(peer, FriendRequestResponsePayload.decode(packet.payload))
        elif packet.type == PacketType.FRIEND_REQUEST_CANCELLED:
            await self._handle_friend_cancelled(peer, FriendRequestCancelledPayload.decode(packet.payload))
        elif packet.type == PacketType.MESSAGE_BLOCKED:
            await self._handle_message_blocked(peer, MessageBlockedPayload.decode(packet.payload))

    def _verify_peer_signature(self, peer: PeerConnection, signed_bytes: bytes, signature: bytes) -> None:
        if peer.signing_public_key is None:
            raise ValueError("Friend packet received before authentication")
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(signature, signed_bytes)
        except InvalidSignature as exc:
            raise ValueError("Invalid friend packet signature") from exc

    async def _handle_friend_request(self, peer: PeerConnection, payload: FriendRequestPayload) -> None:
        if payload.sender_id != peer.peer_id:
            raise ValueError("Friend request sender does not match authenticated peer")
        if not peer.supports(CAP_FRIEND_REQUESTS):
            logger.info("Ignored friend request from %s: capability not negotiated", peer.peer_id)
            return
        self._verify_peer_signature(peer, payload.signed_bytes(), payload.signature)
        if await self.db.is_peer_blocked(payload.sender_id):
            logger.info("Ignored friend request %s from blocked peer %s", payload.request_id, peer.peer_id)
            return
        if await self.db.get_friend_request(payload.request_id):
            return
        if await self.is_friend(payload.sender_id):
            # Already friends with this peer: acknowledge so their client syncs.
            response = FriendRequestResponsePayload(payload.request_id, self.identity.peer_id, True, b"")
            response.signature = self.identity.signing_private_key.sign(response.signed_bytes())
            await self.peer_manager.send_packet(peer, Packet(PacketType.FRIEND_REQUEST_RESPONSE, response.encode()))
            return
        if await self.db.get_pending_request_with(payload.sender_id, "incoming"):
            return
        await self.db.save_friend_request({
            "request_id": payload.request_id,
            "sender_id": payload.sender_id,
            "sender_name": peer.display_name,
            "recipient_id": self.identity.peer_id,
            "recipient_name": self.identity.display_name,
            "note": payload.note or None,
            "created_at": payload.created_at,
            "direction": "incoming",
            "status": "pending",
        })
        logger.info("Received friend request %s from %s", payload.request_id, peer.peer_id)
        if self.on_friend_request:
            await self.on_friend_request({
                "request_id": payload.request_id,
                "sender_id": payload.sender_id,
                "sender_name": peer.display_name,
                "note": payload.note,
                "created_at": payload.created_at,
            })

    async def _handle_friend_response(self, peer: PeerConnection, payload: FriendRequestResponsePayload) -> None:
        if payload.responder_id != peer.peer_id:
            raise ValueError("Friend response peer does not match authenticated peer")
        if not peer.supports(CAP_FRIEND_REQUESTS):
            logger.info("Ignored friend response from %s: capability not negotiated", peer.peer_id)
            return
        self._verify_peer_signature(peer, payload.signed_bytes(), payload.signature)
        request = await self.db.get_friend_request(payload.request_id)
        if request is None or request["direction"] != "outgoing" or request["status"] != "pending":
            return
        await self.db.update_friend_request_status(payload.request_id, "accepted" if payload.accept else "declined")
        if payload.accept:
            await self.db.add_friend(payload.responder_id, peer.display_name)
        logger.info(
            "Friend request %s was %s by %s",
            payload.request_id,
            "accepted" if payload.accept else "declined",
            peer.peer_id,
        )
        if self.on_friend_response:
            await self.on_friend_response({
                "request_id": payload.request_id,
                "peer_id": peer.peer_id,
                "display_name": peer.display_name,
                "accepted": payload.accept,
            })

    async def _handle_friend_cancelled(self, peer: PeerConnection, payload: FriendRequestCancelledPayload) -> None:
        if payload.sender_id != peer.peer_id:
            raise ValueError("Friend cancelled peer does not match authenticated peer")
        if not peer.supports(CAP_FRIEND_REQUESTS):
            logger.info("Ignored friend cancel from %s: capability not negotiated", peer.peer_id)
            return
        self._verify_peer_signature(peer, payload.signed_bytes(), payload.signature)
        request = await self.db.get_friend_request(payload.request_id)
        if request is None or request["direction"] != "incoming" or request["status"] != "pending":
            return
        await self.db.cancel_friend_request(payload.request_id)
        logger.info("Friend request %s was cancelled by %s", payload.request_id, peer.peer_id)
        if self.on_friend_cancelled:
            await self.on_friend_cancelled({
                "request_id": payload.request_id,
                "peer_id": peer.peer_id,
                "display_name": peer.display_name,
            })

    async def _handle_message_blocked(self, peer: PeerConnection, payload: MessageBlockedPayload) -> None:
        if payload.blocked_by != peer.peer_id:
            raise ValueError("Blocked notice peer does not match authenticated peer")
        if not peer.supports(CAP_BLOCK_REPORTS):
            logger.info("Ignored block report from %s: capability not negotiated", peer.peer_id)
            return
        self._verify_peer_signature(peer, payload.signed_bytes(), payload.signature)
        removed_friend = await self.is_friend(peer.peer_id)
        if removed_friend:
            # The peer no longer considers us a friend (they unfriended locally).
            # Mirror that on our side so both views converge.
            await self.db.remove_friend(peer.peer_id)
            logger.info("Removed %s as a friend after blocked message notice", peer.peer_id)
        await self.db.mark_message_blocked(payload.message_id)
        logger.info("Message %s was blocked by %s", payload.message_id, peer.peer_id)
        if self.on_message_blocked:
            await self.on_message_blocked({
                "message_id": payload.message_id,
                "peer_id": peer.peer_id,
                "display_name": peer.display_name,
                "removed_friend": removed_friend,
            })
