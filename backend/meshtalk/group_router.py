"""Room-backed, pairwise encrypted group messaging with mesh relay."""

from __future__ import annotations

import hashlib
import logging
import time
import uuid
from typing import Awaitable, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .database import Database, MAX_QUEUED_GROUP_PER_PEER, extract_mentions, render_mentions_plain
from .encryption import decrypt_as_recipient, encrypt_for_recipient
from .identity import Identity
from .peer_manager import PeerConnection, PeerManager
from .protocol import (
    CAP_AT_MENTIONS,
    CAP_GROUP_CHAT,
    CAP_MESSAGE_REPLIES,
    MAX_PACKET_SIZE,
    GroupAckPayload,
    GroupLeavePayload,
    GroupMessagePayload,
    Packet,
    PacketType,
    group_origin_signed_bytes,
)
from .settings import Settings

logger = logging.getLogger(__name__)

MAX_GROUP_MESSAGE_CONTENT_SIZE = 30 * 1024
# Suppress repeat relay sends to the same peer within this window. Sends use a
# reliable transport, so a successful send means the recipient persists the
# message; re-sending on every reconnect flap only wastes bandwidth (the
# recipient would discard the duplicate by message_id anyway). In-memory only:
# a restart may resend, which duplicates safely discard.
RELAY_RESEND_SUPPRESS_SECONDS = 86400
# Upper bound on live relay sends per peer per sweep. Large backlogs drain
# across reconnects instead of amplifying one flap into a burst.
MAX_RELAY_PER_SWEEP = 50
# Upper bound on remembered relay sends; oldest entries are evicted first.
MAX_RECENT_RELAYS = 5000
# Inbound group-message rate limit per sender (burst per minute). Human chat
# never approaches this; floods are dropped before signature verification.
GROUP_INBOUND_BURST = 30
GROUP_INBOUND_WINDOW_SECONDS = 60
# Relayed messages arrive in sweep bursts (up to MAX_RELAY_PER_SWEEP per
# sweep), so they get a separate, roomier bucket rather than tripping the
# direct-send limit and silently losing relayed history.
GROUP_RELAY_INBOUND_BURST = 120
# Coarse per-transport-peer limiter, checked before any database I/O.
GROUP_PEER_BURST = 240
# Relay send budget per peer: at most this many relayed messages per minute.
# Bounds sustained flap-driven egress regardless of reconnect rate, while
# never blocking legitimate drain below the rate.
GROUP_RELAY_SENDS_PER_MINUTE = 100
# ACK forwards (live or queued) share one small per-transport-peer bucket:
# recipients legitimately ACK in bursts after a relay sweep.
GROUP_ACK_BURST = 120
# Upper bound on queued forwarded ACKs per sender; replays beyond this are dropped.
MAX_QUEUED_ACKS_PER_PEER = 100
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
        self._recent_relays: dict[tuple[str, str], float] = {}
        self._relay_budgets: dict[str, list[float]] = {}
        self._inbound_hits: dict[tuple[str, str], list[float]] = {}

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

    async def record_room_member(self, group_id: str, peer_id: str, announce_join: bool, signing_public_key: bytes | None = None) -> None:
        room = self.settings.rooms.get(group_id)
        if room is None or room.group_name is None or peer_id == self.identity.peer_id:
            return
        peer = self.peer_manager.get_connected_peer(peer_id)
        stored = await self.db.get_peer(peer_id)
        display_name = peer.display_name if peer else (stored or {}).get("display_name", "Anonymous")
        capable = peer.supports(CAP_GROUP_CHAT) if peer else None
        await self.db.upsert_group_member(group_id, peer_id, display_name, group_capable=capable)
        if signing_public_key is not None:
            # Endpoint cards are room-encrypted and carry a self-certifying
            # signing key, so members learn each other's verify keys without a
            # direct handshake. Relayed-message verification depends on this.
            try:
                await self.db.upsert_peer_signing_key(peer_id, signing_public_key)
            except Exception:  # noqa: BLE001
                pass
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
        try:
            relayed = await self.relay_for_peer(peer_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Group relay sweep for %s failed: %s", peer_id, exc)
        else:
            if relayed:
                logger.info("Relayed %d group message(s) to %s", relayed, peer_id)

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

    async def send_message(self, group_id: str, plaintext: bytes, reply_to_message_id: str | None = None) -> tuple[str, list[dict]]:
        if len(plaintext) > MAX_GROUP_MESSAGE_CONTENT_SIZE:
            raise ValueError("Message exceeds 30 KiB limit")
        room = self.settings.rooms.get(group_id)
        if room is None or room.group_name is None:
            raise ValueError("Unknown group")
        message_id = str(uuid.uuid4())
        created_at = time.time()
        content = plaintext.decode("utf-8")
        content_sha256 = hashlib.sha256(plaintext).hexdigest()
        origin_signature = self.identity.signing_private_key.sign(
            group_origin_signed_bytes(
                message_id, group_id, self.identity.peer_id, created_at,
                reply_to_message_id, content_sha256,
            )
        )
        await self.db.save_group_message({
            "message_id": message_id,
            "group_id": group_id,
            "sender_id": self.identity.peer_id,
            "content": content,
            "created_at": created_at,
            "reply_to_message_id": reply_to_message_id,
            "origin_signature": origin_signature,
        })
        await self.db.mark_message_seen(message_id)
        members = [
            member for member in await self.db.get_group_members(group_id)
            if member["peer_id"] != self.identity.peer_id
        ]
        for member in members:
            status = "unavailable" if await self.db.is_peer_blocked(member["peer_id"]) else "pending"
            await self.db.set_group_delivery(message_id, member["peer_id"], status)
        plain_names: dict[str, str] | None = None
        for member in members:
            recipient_id = member["peer_id"]
            if await self.db.is_peer_blocked(recipient_id):
                continue
            peer = self.peer_manager.get_connected_peer(recipient_id)
            stored = await self.db.get_peer(recipient_id)
            key = peer.encryption_public_key if peer else (stored or {}).get("public_key")
            if not key or (peer and not peer.supports(CAP_GROUP_CHAT)) or member.get("group_capable") == 0 or (
                reply_to_message_id and not ((peer and peer.supports(CAP_MESSAGE_REPLIES)) or (peer is None and await self.db.peer_supports(recipient_id, CAP_MESSAGE_REPLIES)))
            ):
                await self.db.set_group_delivery(message_id, recipient_id, "unavailable")
                continue
            if peer is not None:
                mentions_supported = peer.supports(CAP_AT_MENTIONS)
            else:
                mentions_supported = await self.db.peer_supports(recipient_id, CAP_AT_MENTIONS)
            if mentions_supported:
                outgoing = plaintext
            else:
                # Peers without mention support would display raw `<@id>`
                # tokens; send pre-rendered `@Display Name` text instead so
                # mentions stay readable for them.
                if plain_names is None:
                    plain_names = {m["peer_id"]: m["display_name"] for m in members}
                    plain_names["everyone"] = "everyone"
                    plain_names[self.identity.peer_id] = self.identity.display_name
                outgoing = render_mentions_plain(content, plain_names).encode("utf-8")
            if len(outgoing) > MAX_GROUP_MESSAGE_CONTENT_SIZE:
                await self.db.set_group_delivery(message_id, recipient_id, "unavailable")
                continue
            try:
                recipient_origin = self.identity.signing_private_key.sign(
                    group_origin_signed_bytes(
                        message_id, group_id, self.identity.peer_id, created_at,
                        reply_to_message_id, hashlib.sha256(outgoing).hexdigest(),
                    )
                )
                payload = GroupMessagePayload(
                    message_id, group_id, self.identity.peer_id, recipient_id, created_at, b"", reply_to_message_id=reply_to_message_id,
                    origin_signature=recipient_origin,
                )
                payload.encrypted_content = encrypt_for_recipient(key, outgoing, payload.associated_data())
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
                # Bound per-recipient queue growth: a vanished member must not
                # accumulate rows forever via honest fan-out.
                if await self.db.count_queued_packets(recipient_id, PacketType.GROUP_MESSAGE.value) >= MAX_QUEUED_GROUP_PER_PEER:
                    await self.db.set_group_delivery(message_id, recipient_id, "unavailable")
                    continue
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
        if message.reply_to_message_id and not peer.supports(CAP_MESSAGE_REPLIES):
            raise ValueError("Peer sent a group reply without negotiating support")
        if not self._check_rate("peer", peer.peer_id, GROUP_PEER_BURST, GROUP_INBOUND_WINDOW_SECONDS):
            return
        if await self.db.is_peer_blocked(peer.peer_id):
            return
        if message.recipient_id != self.identity.peer_id:
            raise ValueError("Group message routing mismatch")
        if message.sender_id == self.identity.peer_id:
            raise ValueError("Group message routing mismatch")
        relayed = message.sender_id != peer.peer_id
        room = self.settings.rooms.get(message.group_id)
        sender_member = await self.db.get_group_member(message.group_id, message.sender_id)
        if room is None or room.group_name is None or sender_member is None or not sender_member["active"]:
            raise ValueError("Sender is not an active group member")
        if relayed:
            relay_member = await self.db.get_group_member(message.group_id, peer.peer_id)
            if relay_member is None or not relay_member["active"]:
                raise ValueError("Relay is not an active group member")
        if await self.db.is_peer_blocked(message.sender_id):
            return
        if relayed:
            if not self._check_relay_rate(message.sender_id):
                return
        elif not self._check_inbound_rate(message.sender_id):
            return
        if peer.signing_public_key is None:
            raise ValueError("Missing authenticated signing key")
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(
                message.signature, message.signed_bytes()
            )
        except InvalidSignature as exc:
            raise ValueError("Invalid group message signature") from exc
        try:
            plaintext = decrypt_as_recipient(
                self.identity.encryption_private_key, message.encrypted_content, message.associated_data()
            )
            content = plaintext.decode("utf-8")
        except Exception as exc:
            raise ValueError("Invalid encrypted group message") from exc
        if len(plaintext) > MAX_GROUP_MESSAGE_CONTENT_SIZE:
            raise ValueError("Group message exceeds 30 KiB limit")
        sender_key = peer.signing_public_key if not relayed else None
        if sender_key is None:
            stored_sender = await self.db.get_peer(message.sender_id)
            sender_key = (stored_sender or {}).get("signing_public_key")
            if sender_key is None:
                raise ValueError("Unknown original sender signing key")
        if len(message.origin_signature) == 64:
            try:
                Ed25519PublicKey.from_public_bytes(sender_key).verify(
                    message.origin_signature,
                    group_origin_signed_bytes(
                        message.message_id, message.group_id, message.sender_id,
                        message.created_at, message.reply_to_message_id,
                        hashlib.sha256(plaintext).hexdigest(),
                    ),
                )
            except InvalidSignature as exc:
                raise ValueError("Invalid group message origin signature") from exc
        elif relayed:
            raise ValueError("Relayed group message missing origin signature")
        if await self.db.get_group_message(message.message_id) is None:
            inserted = await self.db.save_group_message({
                "message_id": message.message_id,
                "group_id": message.group_id,
                "sender_id": message.sender_id,
                "content": content,
                "created_at": message.created_at,
                "received_at": time.time(),
                "reply_to_message_id": message.reply_to_message_id,
                "origin_signature": message.origin_signature or None,
            })
            await self.db.mark_message_seen(message.message_id)
            if inserted:
                await self._emit({
                    "event": "group_message", "message_id": message.message_id,
                    "group_id": message.group_id, "sender_id": message.sender_id,
                    "content": content, "created_at": message.created_at, "reply_to_message_id": message.reply_to_message_id,
                    "mentions": extract_mentions(content),
                })
        acknowledgement = GroupAckPayload(message.message_id, message.group_id, self.identity.peer_id)
        acknowledgement.signature = self.identity.signing_private_key.sign(acknowledgement.signed_bytes())
        await self.peer_manager.send_packet(
            peer, Packet(PacketType.GROUP_MESSAGE_ACK, acknowledgement.encode())
        )

    def _check_rate(self, bucket: str, key: str, burst: int, window: float) -> bool:
        """Sliding-window flood guard, checked before expensive work.

        Over-limit traffic is dropped like blocked-peer traffic (no store, no
        ACK). Buckets are keyed (bucket, key); direct sends use per-sender
        buckets, relayed sends a roomier per-sender bucket, and all traffic
        additionally counts against a coarse per-transport-peer bucket.
        """
        now = time.time()
        store_key = (bucket, key)
        hits = [hit for hit in self._inbound_hits.get(store_key, []) if now - hit < window]
        if len(hits) >= burst:
            self._inbound_hits[store_key] = hits
            return False
        hits.append(now)
        self._inbound_hits[store_key] = hits
        if len(self._inbound_hits) > 4096:
            for old_key in list(self._inbound_hits)[: len(self._inbound_hits) - 4096]:
                del self._inbound_hits[old_key]
        return True

    def _check_inbound_rate(self, sender_id: str) -> bool:
        return self._check_rate("direct", sender_id, GROUP_INBOUND_BURST, GROUP_INBOUND_WINDOW_SECONDS)

    def _check_relay_rate(self, sender_id: str) -> bool:
        return self._check_rate("relayed", sender_id, GROUP_RELAY_INBOUND_BURST, GROUP_INBOUND_WINDOW_SECONDS)

    def _relay_budget_left(self, peer_id: str) -> int:
        """Remaining relay sends for a peer in the current minute window."""
        now = time.time()
        hits = [hit for hit in self._relay_budgets.get(peer_id, []) if now - hit < 60]
        self._relay_budgets[peer_id] = hits
        if len(self._relay_budgets) > 4096:
            for old_key in list(self._relay_budgets)[: len(self._relay_budgets) - 4096]:
                del self._relay_budgets[old_key]
        return max(0, GROUP_RELAY_SENDS_PER_MINUTE - len(hits))

    async def relay_for_peer(self, peer_id: str) -> int:
        """Re-encrypt stored group messages from other senders for a reachable peer.

        Always-on mesh relay: the relay already knows the plaintext as a group
        member, so this exposes nothing beyond the group chat. Relayed copies
        keep the original message_id/created_at/sender and carry the sender's
        unmodified origin signature; recipients verify it with the sender's
        cached signing key and discard duplicates by message_id. Live sends
        only — no queue rows, so a failed send retries on the next connect.
        Successful sends are remembered briefly to avoid re-sending the same
        message on every reconnect flap, and a persistent per-peer rowid
        cursor resumes past relayed rows across restarts. Only messages
        created at or after the target joined are relayed (no pre-membership
        history), and each sweep sends at most MAX_RELAY_PER_SWEEP messages
        per peer within a per-minute send budget shared across sweeps.
        Candidates are fetched SQL-side already bounded, so sweeps never
        decrypt more than they can send.
        """
        peer = self.peer_manager.get_connected_peer(peer_id)
        if peer is None or not peer.supports(CAP_GROUP_CHAT):
            return 0
        if await self.db.is_peer_blocked(peer_id):
            return 0
        target_key = peer.encryption_public_key
        if not target_key:
            stored_target = await self.db.get_peer(peer_id)
            target_key = (stored_target or {}).get("public_key")
        if not target_key:
            return 0
        relayed_count = 0
        now = time.time()
        if self._relay_budget_left(peer_id) <= 0:
            return 0
        self._recent_relays = {
            key: sent_at for key, sent_at in self._recent_relays.items()
            if now - sent_at < RELAY_RESEND_SUPPRESS_SECONDS
        }
        if len(self._recent_relays) > MAX_RECENT_RELAYS:
            self._recent_relays = dict(list(self._recent_relays.items())[-MAX_RECENT_RELAYS:])
        for group in await self.db.get_groups(self.identity.peer_id):
            if relayed_count >= MAX_RELAY_PER_SWEEP:
                break
            if self._relay_budget_left(peer_id) <= 0:
                break
            group_id = group["group_id"]
            self_member = await self.db.get_group_member(group_id, self.identity.peer_id)
            target_member = await self.db.get_group_member(group_id, peer_id)
            if not self_member or not self_member["active"] or not target_member or not target_member["active"]:
                continue
            # Never relay pre-membership history: the target only receives
            # messages created at or after it joined the group. The persistent
            # per-peer cursor resumes past already-relayed rows, so
            # suppressed or unrelayable head rows cannot stall the backlog.
            target_joined_at = target_member.get("joined_at") or 0
            try:
                messages = await self.db.get_group_messages_for_relay(
                    group_id, target_joined_at, MAX_RELAY_PER_SWEEP - relayed_count,
                    after=await self.db.get_relay_cursor(peer_id, group_id),
                )
            except Exception:
                continue
            max_covered: int | None = None
            for stored in messages:
                if relayed_count >= MAX_RELAY_PER_SWEEP:
                    break
                if self._relay_budget_left(peer_id) <= 0:
                    break
                # Every examined row gets a terminal disposition here (sent or
                # skipped), so the cursor advances past it. Only an actual
                # send failure or a cap/budget stop leaves rows uncovered for
                # the next sweep. In particular, permanently-unrelayable head
                # rows (legacy rows without an origin signature, blocked or
                # departed senders) must not pin newer backlog behind them.
                covered_rowid = stored["rowid"]
                prev_covered = max_covered
                if max_covered is None or covered_rowid > max_covered:
                    max_covered = covered_rowid
                try:
                    sender_id = stored["sender_id"]
                    if sender_id == self.identity.peer_id or sender_id == peer_id:
                        continue
                    if await self.db.is_peer_blocked(sender_id):
                        continue
                    sender_member = await self.db.get_group_member(group_id, sender_id)
                    if sender_member is None or not sender_member["active"]:
                        continue
                    origin_signature = stored.get("origin_signature")
                    if not isinstance(origin_signature, (bytes, bytearray)) or len(origin_signature) != 64:
                        continue
                    if stored.get("reply_to_message_id") and not peer.supports(CAP_MESSAGE_REPLIES):
                        continue
                    relay_key = (stored["message_id"], peer_id)
                    if now - self._recent_relays.get(relay_key, 0) < RELAY_RESEND_SUPPRESS_SECONDS:
                        continue
                    # Forward the exact bytes this member received: the origin
                    # signature binds those bytes, so re-rendering mentions for
                    # the target would break authentication. Legacy targets may
                    # therefore see raw `<@id>` tokens on relayed copies, unlike
                    # direct sends which are pre-rendered per recipient.
                    canonical = stored.get("content") or ""
                    if not isinstance(canonical, str):
                        continue
                    canonical_bytes = canonical.encode("utf-8")
                    if len(canonical_bytes) > MAX_GROUP_MESSAGE_CONTENT_SIZE:
                        continue
                    payload = GroupMessagePayload(
                        stored["message_id"], group_id, sender_id, peer_id,
                        stored["created_at"], b"",
                        reply_to_message_id=stored.get("reply_to_message_id"),
                        origin_signature=bytes(origin_signature),
                    )
                    payload.encrypted_content = encrypt_for_recipient(
                        target_key, canonical_bytes, payload.associated_data()
                    )
                    payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
                    encoded = payload.encode()
                    if len(encoded) > MAX_PACKET_SIZE:
                        continue
                except Exception:  # noqa: BLE001
                    continue
                try:
                    await self.peer_manager.send_packet(peer, Packet(PacketType.GROUP_MESSAGE, encoded))
                except Exception:  # noqa: BLE001
                    # Transport is likely gone; stop this group and roll the
                    # failed row back out of the covered range so it retries
                    # next connect instead of being skipped forever.
                    max_covered = prev_covered
                    break
                self._recent_relays[relay_key] = time.time()
                self._relay_budgets.setdefault(peer_id, []).append(time.time())
                relayed_count += 1
            if max_covered is not None:
                try:
                    await self.db.set_relay_cursor(peer_id, group_id, max_covered)
                except Exception:  # noqa: BLE001
                    pass
        return relayed_count

    async def _handle_ack(self, peer: PeerConnection, acknowledgement: GroupAckPayload) -> None:
        direct = acknowledgement.recipient_id == peer.peer_id
        if not self._check_rate("ack", peer.peer_id, GROUP_ACK_BURST, GROUP_INBOUND_WINDOW_SECONDS):
            return
        if direct:
            if peer.signing_public_key is None:
                raise ValueError("Group acknowledgement identity mismatch")
            try:
                Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(
                    acknowledgement.signature, acknowledgement.signed_bytes()
                )
            except InvalidSignature as exc:
                raise ValueError("Invalid group acknowledgement signature") from exc
        else:
            if await self.db.is_peer_blocked(peer.peer_id):
                return
            stored_signer = await self.db.get_peer(acknowledgement.recipient_id)
            signer_key = (stored_signer or {}).get("signing_public_key")
            if signer_key is None:
                raise ValueError("Unknown acknowledgement signing key")
            try:
                Ed25519PublicKey.from_public_bytes(signer_key).verify(
                    acknowledgement.signature, acknowledgement.signed_bytes()
                )
            except InvalidSignature as exc:
                raise ValueError("Invalid forwarded group acknowledgement signature") from exc
            forward_member = await self.db.get_group_member(acknowledgement.group_id, peer.peer_id)
            if forward_member is None or not forward_member["active"]:
                raise ValueError("Unknown group acknowledgement")
        message = await self.db.get_group_message(acknowledgement.message_id)
        if (
            message is None
            or message["group_id"] != acknowledgement.group_id
        ):
            raise ValueError("Unknown group acknowledgement")
        if message["sender_id"] != self.identity.peer_id:
            if not direct:
                return
            await self._forward_ack(peer, acknowledgement, message)
            return
        deliveries = await self.db.get_group_deliveries(acknowledgement.message_id)
        if acknowledgement.recipient_id not in {delivery["recipient_id"] for delivery in deliveries}:
            raise ValueError("Unknown group acknowledgement")
        await self.db.set_group_delivery(acknowledgement.message_id, acknowledgement.recipient_id, "delivered")
        await self._emit({
            "event": "group_delivered", "message_id": acknowledgement.message_id,
            "group_id": acknowledgement.group_id, "recipient_id": acknowledgement.recipient_id,
        })

    async def _forward_ack(self, peer: PeerConnection, acknowledgement: GroupAckPayload, message: dict) -> None:
        """Forward a recipient's ACK toward the original sender.

        The ACK bytes keep the recipient's signature, so the sender verifies
        them with the recipient's cached key even though the transport peer
        (this relay) differs. Live-send when connected, else hold one queue
        row (message_id unset so flush never touches delivery state).
        """
        target_id = message["sender_id"]
        if target_id == self.identity.peer_id or target_id == peer.peer_id:
            return
        target_member = await self.db.get_group_member(message["group_id"], target_id)
        if target_member is None or not target_member["active"]:
            return
        if await self.db.is_peer_blocked(target_id):
            return
        encoded = acknowledgement.encode()
        if len(encoded) > MAX_PACKET_SIZE:
            return
        target_peer = self.peer_manager.get_connected_peer(target_id)
        if target_peer is not None and target_peer.supports(CAP_GROUP_CHAT):
            try:
                await self.peer_manager.send_packet(
                    target_peer, Packet(PacketType.GROUP_MESSAGE_ACK, encoded)
                )
                return
            except Exception:  # noqa: BLE001
                pass
        try:
            # A malicious recipient could replay the same ACK while the sender
            # is offline; the queue would grow without bound. Identical ACK
            # bytes verify identically, so one queued copy suffices. The
            # per-peer cap bounds distinct ACKs.
            if await self.db.has_queued_payload(
                target_id, PacketType.GROUP_MESSAGE_ACK.value, encoded
            ):
                return
            if await self.db.count_queued_packets(
                target_id, PacketType.GROUP_MESSAGE_ACK.value
            ) >= MAX_QUEUED_ACKS_PER_PEER:
                return
            await self.db.add_to_outqueue(
                target_id, PacketType.GROUP_MESSAGE_ACK.value, encoded, None, message["group_id"]
            )
        except Exception:  # noqa: BLE001
            pass

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
