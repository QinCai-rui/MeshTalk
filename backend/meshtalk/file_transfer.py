"""Authenticated, resumable v2 file transfer with a read-only v1 receiver."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Awaitable, Callable, Iterable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .database import Database
from .encryption import decrypt_as_recipient, encrypt_for_recipient
from .identity import Identity
from .peer_manager import PeerConnection, PeerManager
from .protocol import (
    CAP_BLOCK_REPORTS,
    CAP_FILE_TRANSFER,
    CAP_FILE_TRANSFER_V2,
    MAX_FILE_BATCH_SIZE,
    MAX_FILE_CAPTION_BYTES,
    MAX_FILE_CHUNK_SIZE,
    MAX_FILE_SIZE,
    MAX_FILENAME_LENGTH,
    FileAckPayload,
    FileAckV2Payload,
    FileChunkPayload,
    FileChunkV2Payload,
    FileOfferPayload,
    FileOfferV2Payload,
    Packet,
    PacketType,
    sanitize_filename,
)

logger = logging.getLogger(__name__)

FILES_SUBDIR = "files"
GROUP_FILE_SENDER_ROW_RECIPIENT = ""
MAX_EARLY_CHUNKS = 64
MAX_EARLY_CHUNKS_PER_FILE = 8
EARLY_CHUNK_TTL = 30
PROGRESS_EVENT_INTERVAL = 0.25
MAX_PROGRESS_EVENTS = 100
FILE_PROGRESS_COMMIT_CHUNKS = 32
FILE_PROGRESS_COMMIT_INTERVAL = 1.0
MAX_PROGRESS_TRACKERS = 256
AWAITING_ACK_TIMEOUT = 30.0


def _files_base(data_dir: Path) -> Path:
    configured = os.environ.get("MESHTALK_FILES_DIR", "").strip()
    return Path(configured).expanduser() if configured else data_dir / FILES_SUBDIR


def _resolve_files_base(data_dir: Path, settings=None) -> Path:
    if settings is not None:
        try:
            return settings.files_dir
        except Exception:
            pass
    return _files_base(data_dir)


def _suffixed_filename(filename: str, suffix_text: str) -> str:
    safe = sanitize_filename(filename)
    suffix = Path(safe).suffix
    stem = safe[:-len(suffix)] if suffix else safe
    available = MAX_FILENAME_LENGTH - len(suffix_text) - len(suffix) - 1
    return sanitize_filename(f"{stem[:max(1, available)].rstrip(' ._') or 'file'}_{suffix_text}{suffix}")


def _timestamped_filename(filename: str, created_at: float) -> str:
    return _suffixed_filename(filename, str(int(created_at)))


class FileTransferManager:
    """Own file snapshots, delivery state, wire handling, retries, and resume."""

    def __init__(
        self,
        identity: Identity,
        peer_manager: PeerManager,
        db: Database,
        data_dir: Path,
        on_event: Callable[[dict], Awaitable[None]] | None = None,
        settings=None,
        analytics=None,
    ) -> None:
        self.identity = identity
        self.peer_manager = peer_manager
        self.db = db
        self.data_dir = data_dir
        self.settings = settings
        self.on_event = on_event
        self.analytics = analytics
        self._packet_locks: dict[str, asyncio.Lock] = {}
        self._flush_locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._early_chunks: dict[str, tuple[float, list[tuple[PeerConnection, object, bool]]]] = {}
        self._last_progress_events: dict[str, tuple[float, int]] = {}
        self._pending_progress_commits: dict[str, asyncio.Task[None]] = {}
        self._integrity_retries: set[str] = set()
        self._awaiting_ack_since: dict[tuple[str, str], float] = {}

    @property
    def files_base(self) -> Path:
        return _resolve_files_base(self.data_dir, self.settings)

    def _incoming_path_for(
        self, file_id: str, sender_id: str, group_id: str | None, filename: str, created_at: float
    ) -> Path:
        base = self.files_base / sanitize_filename(group_id or sender_id) / _timestamped_filename(filename, created_at)
        suffix = hashlib.sha256(file_id.encode()).hexdigest()[:16]
        candidate = base
        attempt = 1
        while candidate.exists():
            candidate = base.with_name(_suffixed_filename(base.name, suffix if attempt == 1 else f"{suffix}_{attempt}"))
            attempt += 1
        return candidate

    def _outgoing_path_for(self, file_id: str, filename: str) -> Path:
        return self.files_base / "sent" / file_id / sanitize_filename(filename)

    def _snapshot_with_hash(self, source: Path, file_id: str, filename: str) -> tuple[Path, str]:
        """Copy and hash in one source pass, rejecting growth beyond the limit."""
        destination = self._outgoing_path_for(file_id, filename)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
        digest = hashlib.sha256()
        copied = 0
        try:
            with open(source, "rb") as src, open(
                temporary, "xb", opener=lambda path, flags: os.open(path, flags, 0o600)
            ) as dst:
                while copied <= MAX_FILE_SIZE:
                    block = src.read(min(1024 * 1024, MAX_FILE_SIZE + 1 - copied))
                    if not block:
                        break
                    copied += len(block)
                    digest.update(block)
                    dst.write(block)
                dst.flush()
                os.fsync(dst.fileno())
            if copied > MAX_FILE_SIZE:
                raise ValueError(f"File exceeds {MAX_FILE_SIZE // (1024 * 1024)} MiB limit")
            if copied == 0:
                raise ValueError("File is empty")
            os.chmod(temporary, 0o600)
            os.replace(temporary, destination)
            return destination, digest.hexdigest()
        except ValueError:
            temporary.unlink(missing_ok=True)
            try:
                destination.parent.rmdir()
            except OSError:
                pass
            raise
        except OSError as exc:
            temporary.unlink(missing_ok=True)
            try:
                destination.parent.rmdir()
            except OSError:
                pass
            raise ValueError(f"Could not store a local copy of file: {exc}") from exc

    def _snapshot_outgoing_file(self, source: Path, file_id: str, filename: str) -> Path:
        """Compatibility wrapper for callers that only need the snapshot path."""
        return self._snapshot_with_hash(source, file_id, filename)[0]

    def _emit(self, event: dict) -> None:
        if self.on_event:
            asyncio.create_task(self.on_event(event))

    def _should_emit_progress(self, file_id: str, received: int, total_chunks: int) -> bool:
        now = time.monotonic()
        previous = self._last_progress_events.get(file_id)
        advance = max(1, math.ceil(total_chunks / MAX_PROGRESS_EVENTS))
        if previous is None or received == total_chunks or received - previous[1] >= advance or now - previous[0] >= PROGRESS_EVENT_INTERVAL:
            self._last_progress_events[file_id] = (now, received)
            while len(self._last_progress_events) > MAX_PROGRESS_TRACKERS:
                self._last_progress_events.pop(next(iter(self._last_progress_events)))
            return True
        return False

    def _schedule_progress_commit(self, file_id: str) -> None:
        if file_id not in self._pending_progress_commits:
            self._pending_progress_commits[file_id] = asyncio.create_task(self._flush_progress_commit(file_id))

    async def _flush_progress_commit(self, file_id: str) -> None:
        try:
            await asyncio.sleep(FILE_PROGRESS_COMMIT_INTERVAL)
            await self.db.commit()
        except Exception:
            logger.exception("Failed to flush file progress for %s", file_id)
        finally:
            if self._pending_progress_commits.get(file_id) is asyncio.current_task():
                self._pending_progress_commits.pop(file_id, None)

    async def _commit_file_progress(self, file_id: str) -> None:
        task = self._pending_progress_commits.pop(file_id, None)
        if task and task is not asyncio.current_task():
            task.cancel()
        await self.db.commit()

    def _validate_source(self, value: str | Path) -> Path:
        raw = str(value).strip().strip('"').strip("'")
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = Path.cwd() / path
        try:
            if not path.exists():
                raise ValueError(f"File not found: {path}")
            if not path.is_file():
                raise ValueError(f"Not a file: {path}")
            size = path.stat().st_size
        except OSError as exc:
            raise ValueError(f"Cannot access file: {exc}") from exc
        if size == 0:
            raise ValueError("File is empty")
        if size > MAX_FILE_SIZE:
            raise ValueError(f"File exceeds {MAX_FILE_SIZE // (1024 * 1024)} MiB limit")
        return path

    @staticmethod
    def _validate_caption(caption: str) -> str:
        if not isinstance(caption, str):
            raise ValueError("Caption must be text")
        try:
            valid = len(caption.encode("utf-8")) <= MAX_FILE_CAPTION_BYTES
        except UnicodeEncodeError:
            valid = False
        if not valid:
            raise ValueError(f"Caption exceeds {MAX_FILE_CAPTION_BYTES} UTF-8 bytes")
        return caption

    async def send_file(
        self, recipient_id: str, file_path_str: str, group_id: str | None = None, caption: str = ""
    ) -> str:
        """Send one v2 DM; ``group_id`` is rejected to fail closed on routing mistakes."""
        if group_id:
            raise ValueError("Pass either a DM recipient or a group_id, not both")
        if await self.db.is_peer_blocked(recipient_id) or not await self.db.is_friend(recipient_id):
            raise ValueError("Recipient is blocked or is not a friend")
        return await self._create_send(file_path_str, caption, None, [recipient_id])

    async def send_group_file(self, group_id: str, file_path: str, caption: str = "") -> str:
        """Send one snapshot under one file ID to every non-self member."""
        group = (self.settings.rooms.get(group_id) if self.settings else None) or await self.db.get_group(group_id)
        local = await self.db.get_group_member(group_id, self.identity.peer_id)
        if not group or not local or not local["active"]:
            raise ValueError("Not an active member of this group")
        members = await self.db.get_group_members(group_id, include_inactive=True)
        recipients = [member["peer_id"] for member in members if member["peer_id"] != self.identity.peer_id]
        return await self._create_send(file_path, caption, group_id, recipients)

    async def send_batch(
        self,
        target_id: str,
        files: Iterable[str | Path | tuple[str | Path, str]],
        *,
        group_id: str | None = None,
        caption: str = "",
    ) -> dict:
        """Send up to 32 files and return ``{batch_id, results, errors}``.

        ``group_id`` selects a group target. Tuple entries may carry captions;
        a caller-level caption is attached to the first file only.
        """
        entries = list(files)
        if not entries or len(entries) > MAX_FILE_BATCH_SIZE:
            raise ValueError(f"Batch must contain 1..{MAX_FILE_BATCH_SIZE} files")
        batch_id = uuid.uuid4().hex
        results, errors = [], []
        for index, entry in enumerate(entries):
            path, item_caption = entry if isinstance(entry, tuple) else (entry, caption if index == 0 else "")
            try:
                if group_id is not None:
                    file_id = await self._prepare_group_send(group_id, path, item_caption, batch_id, index, len(entries))
                else:
                    if await self.db.is_peer_blocked(target_id) or not await self.db.is_friend(target_id):
                        raise ValueError("Recipient is blocked or is not a friend")
                    file_id = await self._create_send(path, item_caption, None, [target_id], batch_id, index, len(entries))
                results.append({"recipient_id": GROUP_FILE_SENDER_ROW_RECIPIENT if group_id else target_id, "file_id": file_id})
            except Exception as exc:
                errors.append({"path": str(path), "error": str(exc)})
        return {"batch_id": batch_id, "results": results, "errors": errors}

    async def _prepare_group_send(self, group_id, path, caption, batch_id, index, count) -> str:
        group = (self.settings.rooms.get(group_id) if self.settings else None) or await self.db.get_group(group_id)
        local = await self.db.get_group_member(group_id, self.identity.peer_id)
        if not group or not local or not local["active"]:
            raise ValueError("Not an active member of this group")
        members = await self.db.get_group_members(group_id, include_inactive=True)
        recipients = [m["peer_id"] for m in members if m["peer_id"] != self.identity.peer_id]
        return await self._create_send(path, caption, group_id, recipients, batch_id, index, count)

    async def _create_send(
        self, file_path, caption, group_id, recipients, batch_id=None, batch_index=None, batch_count=None
    ) -> str:
        if group_id and not recipients:
            raise ValueError("No other members to send to")
        source = self._validate_source(file_path)
        caption = self._validate_caption(caption)
        file_id = uuid.uuid4().hex
        filename = sanitize_filename(source.name)
        snapshot, digest = self._snapshot_with_hash(source, file_id, filename)
        try:
            size = snapshot.stat().st_size
        except OSError as exc:
            snapshot.unlink(missing_ok=True)
            try:
                snapshot.parent.rmdir()
            except OSError:
                pass
            raise ValueError(f"Could not inspect local copy: {exc}") from exc
        total = math.ceil(size / MAX_FILE_CHUNK_SIZE)
        created = time.time()
        await self.db.save_file_transfer({
            "file_id": file_id, "filename": filename, "file_size": size,
            "chunk_size": MAX_FILE_CHUNK_SIZE, "total_chunks": total,
            "sender_id": self.identity.peer_id,
            "recipient_id": GROUP_FILE_SENDER_ROW_RECIPIENT if group_id else recipients[0],
            "group_id": group_id, "direction": "outbound", "status": "pending",
            "file_path": str(snapshot), "created_at": created, "received_chunks": 0,
            "file_sha256": digest, "caption": caption, "batch_id": batch_id,
            "batch_index": batch_index, "batch_count": batch_count,
        })
        if group_id:
            for recipient in recipients:
                eligible = await self._group_recipient_eligible(group_id, recipient)
                await self.db.set_file_delivery(file_id, recipient, "pending" if eligible else "unavailable")
        for recipient in recipients:
            if group_id and not await self._group_recipient_eligible(group_id, recipient):
                continue
            await self._deliver_v2(await self.db.get_file_transfer(file_id), recipient)
        await self._recompute_aggregate(file_id)
        return file_id

    async def _group_recipient_eligible(self, group_id: str, recipient: str) -> bool:
        member = await self.db.get_group_member(group_id, recipient)
        return bool(member and member["active"] and not await self.db.is_peer_blocked(recipient) and await self._supports_v2(recipient))

    async def _active_group_sender(self, group_id: str) -> bool:
        group = (self.settings.rooms.get(group_id) if self.settings else None) or await self.db.get_group(group_id)
        local = await self.db.get_group_member(group_id, self.identity.peer_id)
        return bool(group and local and local["active"])

    async def _supports_v2(self, recipient: str) -> bool:
        peer = self.peer_manager.get_connected_peer(recipient)
        return peer.supports(CAP_FILE_TRANSFER_V2) if peer else await self.db.peer_supports(recipient, CAP_FILE_TRANSFER_V2)

    def _offer(self, transfer: dict, recipient: str) -> FileOfferV2Payload:
        offer = FileOfferV2Payload(
            file_id=transfer["file_id"], filename=transfer["filename"], file_size=transfer["file_size"],
            chunk_size=transfer["chunk_size"], total_chunks=transfer["total_chunks"],
            file_sha256=transfer["file_sha256"], caption=transfer.get("caption", ""),
            sender_id=self.identity.peer_id, recipient_id=recipient, group_id=transfer["group_id"],
            created_at=transfer["created_at"], batch_id=transfer.get("batch_id"),
            batch_index=transfer.get("batch_index"), batch_count=transfer.get("batch_count"),
        )
        offer.signature = self.identity.signing_private_key.sign(offer.signed_bytes())
        return offer

    def _chunk(self, transfer: dict, recipient: str, index: int, plaintext: bytes, key: bytes) -> FileChunkV2Payload:
        payload = FileChunkV2Payload(
            file_id=transfer["file_id"], chunk_index=index, total_chunks=transfer["total_chunks"],
            sender_id=self.identity.peer_id, recipient_id=recipient, group_id=transfer["group_id"],
            encrypted_content=b"",
        )
        payload.encrypted_content = encrypt_for_recipient(key, plaintext, payload.associated_data())
        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
        return payload

    async def _set_delivery(self, transfer: dict, recipient: str, status: str) -> None:
        if status != "sent":
            self._awaiting_ack_since.pop((transfer["file_id"], recipient), None)
        if transfer["group_id"]:
            await self.db.set_file_delivery(transfer["file_id"], recipient, status)
            await self._recompute_aggregate(transfer["file_id"])
        else:
            await self.db.update_file_transfer(
                transfer["file_id"], status=status,
                awaiting_ack_at=time.time() if status == "sent" else None,
            )

    async def _deliver_v2(self, transfer: dict, recipient: str) -> None:
        if transfer["group_id"]:
            authorized = await self._active_group_sender(transfer["group_id"]) and await self._group_recipient_eligible(transfer["group_id"], recipient)
        else:
            authorized = not await self.db.is_peer_blocked(recipient) and await self.db.is_friend(recipient)
        if not authorized:
            await self._set_delivery(transfer, recipient, "unavailable")
            return
        if not await self._supports_v2(recipient):
            await self._set_delivery(transfer, recipient, "unavailable")
            return
        peer = self.peer_manager.get_connected_peer(recipient)
        stored = await self.db.get_peer(recipient)
        key = peer.encryption_public_key if peer else (stored or {}).get("public_key")
        if not key:
            await self._set_delivery(transfer, recipient, "unavailable")
            return
        offer = self._offer(transfer, recipient)
        if not peer:
            await self.db.add_to_outqueue(recipient, PacketType.FILE_OFFER_V2.value, offer.encode(), transfer["file_id"], transfer["group_id"])
            if not await self._queue_ranges(transfer, recipient, key, [(0, transfer["total_chunks"] - 1)]):
                self._emit({"event": "file_failed", "file_id": transfer["file_id"], "recipient_id": recipient, "group_id": transfer["group_id"]})
                return
            await self._set_delivery(transfer, recipient, "queued")
            self._emit({"event": "file_queued", "file_id": transfer["file_id"], "recipient_id": recipient, "filename": transfer["filename"], "group_id": transfer["group_id"]})
            return
        await self._set_delivery(transfer, recipient, "transferring")
        try:
            await self.peer_manager.send_packet(peer, Packet(PacketType.FILE_OFFER_V2, offer.encode()))
        except Exception as exc:
            await self.db.add_to_outqueue(recipient, PacketType.FILE_OFFER_V2.value, offer.encode(), transfer["file_id"], transfer["group_id"])
            if not await self._queue_ranges(transfer, recipient, key, [(0, transfer["total_chunks"] - 1)]):
                self._emit({"event": "file_failed", "file_id": transfer["file_id"], "recipient_id": recipient, "group_id": transfer["group_id"]})
                return
            await self._set_delivery(transfer, recipient, "queued")
            logger.warning("Failed to send v2 file offer %s: %s", transfer["file_id"], exc)
            return
        await self._stream_ranges(peer, transfer, recipient, [(0, transfer["total_chunks"] - 1)])

    async def _queue_ranges(self, transfer, recipient, key, ranges) -> bool:
        path = Path(transfer["file_path"])
        try:
            with open(path, "rb") as src:
                for start, end in ranges:
                    for index in range(start, end + 1):
                        src.seek(index * transfer["chunk_size"])
                        payload = self._chunk(transfer, recipient, index, src.read(transfer["chunk_size"]), key)
                        await self.db.add_to_outqueue(recipient, PacketType.FILE_CHUNK_V2.value, payload.encode(), transfer["file_id"], transfer["group_id"])
        except Exception as exc:
            await self._set_delivery(transfer, recipient, "failed")
            logger.warning("Could not queue file %s: %s", transfer["file_id"], exc)
            return False
        return True

    async def _mark_sent_unless_completed(self, transfer: dict, recipient: str) -> None:
        """Record awaiting-ACK state unless a completion ACK landed mid-stream."""
        current = await self.db.get_file_transfer(transfer["file_id"])
        if transfer["group_id"]:
            delivery = await self.db.get_file_delivery(transfer["file_id"], recipient)
            if delivery and delivery["status"] == "completed":
                return
        elif current and current["status"] == "completed":
            return
        self._awaiting_ack_since[(transfer["file_id"], recipient)] = time.monotonic()
        await self._set_delivery(transfer, recipient, "sent")

    async def _stream_ranges(self, peer, transfer, recipient, ranges) -> bool:
        path = Path(transfer["file_path"]) if transfer.get("file_path") else None
        if not path or not path.is_file() or not peer.encryption_public_key:
            await self._set_delivery(transfer, recipient, "failed")
            self._emit({"event": "file_failed", "file_id": transfer["file_id"], "recipient_id": recipient, "group_id": transfer["group_id"]})
            return False
        try:
            sent = 0
            full_stream = ranges == [(0, transfer["total_chunks"] - 1)]
            with open(path, "rb") as src:
                for start, end in ranges:
                    for index in range(start, end + 1):
                        src.seek(index * transfer["chunk_size"])
                        payload = self._chunk(transfer, recipient, index, src.read(transfer["chunk_size"]), peer.encryption_public_key)
                        try:
                            await self.peer_manager.send_packet(peer, Packet(PacketType.FILE_CHUNK_V2, payload.encode()))
                        except Exception:
                            await self.db.add_to_outqueue(recipient, PacketType.FILE_CHUNK_V2.value, payload.encode(), transfer["file_id"], transfer["group_id"])
                            remaining = [(index + 1, end)] if index < end else []
                            pos = ranges.index((start, end))
                            remaining.extend(ranges[pos + 1:])
                            if not await self._queue_ranges(transfer, recipient, peer.encryption_public_key, remaining):
                                self._emit({"event": "file_failed", "file_id": transfer["file_id"], "recipient_id": recipient, "group_id": transfer["group_id"]})
                                return False
                            await self._set_delivery(transfer, recipient, "queued")
                            return False
                        sent += 1
                        if full_stream and self._should_emit_progress(transfer["file_id"], sent, transfer["total_chunks"]):
                            self._emit({"event": "file_progress", "file_id": transfer["file_id"], "received": sent, "total_chunks": transfer["total_chunks"], "direction": "outbound", "group_id": transfer["group_id"], "recipient_id": recipient})
                        if index % 10 == 0:
                            await asyncio.sleep(0)
            await self._mark_sent_unless_completed(transfer, recipient)
            self._emit({"event": "file_sent", "file_id": transfer["file_id"], "recipient_id": recipient, "filename": transfer["filename"], "group_id": transfer["group_id"]})
            return True
        except Exception as exc:
            await self._set_delivery(transfer, recipient, "failed")
            logger.warning("Failed to stream file %s: %s", transfer["file_id"], exc)
            return False

    async def _recompute_aggregate(self, file_id: str) -> None:
        transfer = await self.db.get_file_transfer(file_id)
        if not transfer or not transfer["group_id"]:
            return
        states = [d["status"] for d in await self.db.get_file_deliveries(file_id)]
        if not states or all(state == "unavailable" for state in states):
            status = "unavailable"
        elif all(state == "completed" for state in states):
            status = "completed"
        elif any(state in ("pending", "transferring", "sent") for state in states):
            status = "transferring"
        elif any(state == "failed" for state in states):
            status = "failed"
        elif any(state == "blocked" for state in states):
            status = "blocked"
        elif any(state == "queued" for state in states):
            status = "queued"
        else:
            status = "unavailable"
        fields = {"status": status}
        if status == "completed":
            fields["completed_at"] = time.time()
        await self.db.update_file_transfer(file_id, **fields)

    async def flush_for_peer(self, peer_id: str) -> int:
        """Flush durable v2 ACKs and queued file packets, serialized per file/peer."""
        peer = self.peer_manager.get_connected_peer(peer_id)
        if not peer or await self.db.is_peer_blocked(peer_id):
            return 0
        flushed = 0
        pending = await self.db.get_pending_outgoing(peer_id)
        legacy_types = {
            PacketType.FILE_OFFER.value, PacketType.FILE_CHUNK.value, PacketType.FILE_ACK.value,
        }
        legacy = [item for item in pending if item["packet_type"] in legacy_types]
        if legacy:
            logger.info("Purging %d legacy queued file packet(s) for %s", len(legacy), peer_id)
            for item in legacy:
                await self.db.remove_from_outqueue(item["id"])
            for file_id in {item["message_id"] for item in legacy if item["message_id"]}:
                transfer = await self.db.get_file_transfer(file_id)
                if transfer and transfer["direction"] == "outbound" and not transfer.get("file_sha256") and transfer["status"] != "completed":
                    await self.db.update_file_transfer(file_id, status="failed")
                    self._emit({"event": "file_failed", "file_id": file_id, "group_id": transfer["group_id"]})
            pending = [item for item in pending if item["packet_type"] not in legacy_types]
        # ACKs are receiver-owned and have no sender transfer row.
        for item in pending:
            if item["packet_type"] == PacketType.FILE_ACK_V2.value and peer.supports(CAP_FILE_TRANSFER_V2):
                try:
                    await self.peer_manager.send_packet(peer, Packet(PacketType.FILE_ACK_V2, item["encrypted_payload"]))
                except Exception:
                    continue
                await self.db.remove_from_outqueue(item["id"])
                flushed += 1
        file_ids = {item["message_id"] for item in pending if item["packet_type"] in (PacketType.FILE_OFFER_V2.value, PacketType.FILE_CHUNK_V2.value) and item["message_id"]}
        for file_id in file_ids:
            lock_key = (file_id, peer_id)
            lock = self._flush_locks.setdefault(lock_key, asyncio.Lock())
            try:
                async with lock:
                    transfer = await self.db.get_file_transfer(file_id)
                    if not transfer or not peer.supports(CAP_FILE_TRANSFER_V2):
                        continue
                    if transfer["group_id"]:
                        authorized = await self._active_group_sender(transfer["group_id"]) and await self._group_recipient_eligible(transfer["group_id"], peer_id)
                    else:
                        authorized = not await self.db.is_peer_blocked(peer_id) and await self.db.is_friend(peer_id)
                    if not authorized:
                        await self.db.remove_file_from_outqueue(file_id, peer_id)
                        await self._set_delivery(transfer, peer_id, "unavailable")
                        continue
                    if transfer["direction"] == "outbound" and transfer["status"] == "completed":
                        for item in await self.db.get_pending_outgoing(peer_id):
                            if item["message_id"] == file_id:
                                await self.db.remove_from_outqueue(item["id"])
                        continue
                    if transfer["group_id"]:
                        delivery = await self.db.get_file_delivery(file_id, peer_id)
                        if delivery and delivery["status"] == "completed":
                            for item in await self.db.get_pending_outgoing(peer_id):
                                if item["message_id"] == file_id:
                                    await self.db.remove_from_outqueue(item["id"])
                            continue
                    items = [i for i in await self.db.get_pending_outgoing(peer_id) if i["message_id"] == file_id]
                    offer_items = [i for i in items if i["packet_type"] == PacketType.FILE_OFFER_V2.value]
                    chunk_items = [i for i in items if i["packet_type"] == PacketType.FILE_CHUNK_V2.value]
                    failed = False
                    for item in offer_items[:1]:
                        try:
                            await self.peer_manager.send_packet(peer, Packet(PacketType.FILE_OFFER_V2, item["encrypted_payload"]))
                        except Exception:
                            failed = True
                            break
                        await self.db.remove_from_outqueue(item["id"])
                    if failed:
                        continue
                    for item in chunk_items:
                        try:
                            await self.peer_manager.send_packet(peer, Packet(PacketType.FILE_CHUNK_V2, item["encrypted_payload"]))
                        except Exception:
                            failed = True
                            break
                        await self.db.remove_from_outqueue(item["id"])
                    if not failed:
                        await self._mark_sent_unless_completed(transfer, peer_id)
                        flushed += 1
            finally:
                self._release_flush_lock(file_id, peer_id, lock)
        return flushed

    async def retry_file(self, file_id: str, recipient_id: str | None = None) -> str:
        transfer = await self.db.get_file_transfer(file_id)
        if not transfer or transfer["direction"] != "outbound":
            raise ValueError("Unknown outbound file_id")
        if transfer["group_id"]:
            if not await self._active_group_sender(transfer["group_id"]):
                raise ValueError("Not an active member of this group")
            deliveries = await self.db.get_file_deliveries(file_id)
            targets = [d for d in deliveries if recipient_id is None or d["recipient_id"] == recipient_id]
            targets = [d for d in targets if self._retryable(file_id, d["recipient_id"], d["status"], d.get("awaiting_ack_at"))]
        else:
            target = recipient_id or transfer["recipient_id"]
            if target != transfer["recipient_id"] or not self._retryable(file_id, target, transfer["status"], transfer.get("awaiting_ack_at")):
                targets = []
            else:
                targets = [{"recipient_id": target}]
        if not targets:
            raise ValueError("Transfer has no retryable delivery")
        if not transfer["group_id"]:
            recipient = targets[0]["recipient_id"]
            if await self.db.is_peer_blocked(recipient):
                await self.db.update_file_transfer(file_id, status="blocked")
                raise ValueError("This peer is blocked; unblock them to retry")
            if not await self.db.is_friend(recipient):
                await self.db.update_file_transfer(file_id, status="unavailable")
                raise ValueError("Recipient is blocked or is not a friend")
        path = Path(transfer["file_path"] or "")
        if not path.is_file():
            await self.db.update_file_transfer(file_id, status="failed")
            raise ValueError("Source file not found; it may have been moved or deleted")
        for target in targets:
            recipient = target["recipient_id"]
            lock = self._flush_lock(file_id, recipient)
            try:
                async with lock:
                    await self.db.remove_file_from_outqueue(file_id, recipient)
                    if transfer["group_id"] and not await self._group_recipient_eligible(transfer["group_id"], recipient):
                        await self._set_delivery(transfer, recipient, "unavailable")
                        continue
                    await self._deliver_v2(transfer, recipient)
            finally:
                self._release_flush_lock(file_id, recipient, lock)
        return file_id

    def _retryable(self, file_id: str, recipient: str, status: str, awaiting_ack_at: float | None = None) -> bool:
        if status in ("failed", "blocked", "queued", "unavailable"):
            return True
        since = self._awaiting_ack_since.get((file_id, recipient))
        if since is not None:
            return status == "sent" and time.monotonic() - since >= AWAITING_ACK_TIMEOUT
        if awaiting_ack_at is not None:
            return status == "sent" and time.time() - awaiting_ack_at >= AWAITING_ACK_TIMEOUT
        # A persisted sent transfer has no monotonic timestamp after restart.
        # Treat it as expired so it cannot remain stranded indefinitely.
        return status == "sent"

    def _flush_lock(self, file_id: str, peer_id: str) -> asyncio.Lock:
        """Return the per-file/peer lock serializing flush, resend, and retry queueing."""
        return self._flush_locks.setdefault((file_id, peer_id), asyncio.Lock())

    def _release_flush_lock(self, file_id: str, peer_id: str, lock: asyncio.Lock) -> None:
        """Retain locks so queued waiters cannot be split across lock instances."""

    def forget_transfer(self, file_id: str) -> None:
        """Drop bounded in-memory state after local transfer deletion."""
        self._integrity_retries.discard(file_id)
        self._last_progress_events.pop(file_id, None)
        task = self._pending_progress_commits.pop(file_id, None)
        if task:
            task.cancel()
        for key in [key for key in self._awaiting_ack_since if key[0] == file_id]:
            self._awaiting_ack_since.pop(key, None)

    async def resume_for_peer(self, peer_id: str) -> None:
        peer = self.peer_manager.get_connected_peer(peer_id)
        if not peer or await self.db.is_peer_blocked(peer_id):
            return
        transfers = await self.db.get_file_transfers(peer_id, include_group=True)
        for transfer in transfers:
            if transfer["direction"] != "inbound" or transfer["sender_id"] != peer_id:
                continue
            v2 = bool(transfer.get("file_sha256"))
            capability = CAP_FILE_TRANSFER_V2 if v2 else CAP_FILE_TRANSFER
            if not peer.supports(capability):
                continue
            if transfer["status"] == "completed":
                await self._send_ack(peer, transfer["file_id"], "completed", v2=v2)
            elif transfer["status"] in ("transferring", "failed"):
                missing = await self.db.get_missing_file_chunk_ranges(transfer["file_id"], transfer["total_chunks"])
                if not missing and transfer["status"] == "failed":
                    missing = [(0, transfer["total_chunks"] - 1)]
                if missing:
                    await self._send_ack(peer, transfer["file_id"], "missing", missing, v2=v2)
                else:
                    await self._complete_inbound_transfer(peer, transfer, v2=v2)

    async def handle_packet(self, peer: PeerConnection, packet: Packet) -> bool:
        types = {
            PacketType.FILE_OFFER, PacketType.FILE_CHUNK, PacketType.FILE_ACK,
            PacketType.FILE_OFFER_V2, PacketType.FILE_CHUNK_V2, PacketType.FILE_ACK_V2,
        }
        if packet.type not in types:
            return False
        lock = self._packet_locks.setdefault(peer.peer_id, asyncio.Lock())
        async with lock:
            try:
                if packet.type in (PacketType.FILE_OFFER, PacketType.FILE_OFFER_V2):
                    await self._handle_offer(peer, packet, packet.type == PacketType.FILE_OFFER_V2)
                elif packet.type in (PacketType.FILE_CHUNK, PacketType.FILE_CHUNK_V2):
                    await self._handle_chunk(peer, packet, packet.type == PacketType.FILE_CHUNK_V2)
                else:
                    await self._handle_ack(peer, packet, packet.type == PacketType.FILE_ACK_V2)
            except ValueError:
                logger.warning("Dropped invalid file packet %s from %s", packet.type, peer.peer_id, exc_info=True)
            except Exception:
                logger.exception("Failed to handle file packet %s from %s", packet.type, peer.peer_id)
        return True

    @staticmethod
    def _verify(peer, payload, description: str) -> None:
        if peer.signing_public_key is None:
            raise ValueError("Missing signing key")
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(payload.signature, payload.signed_bytes())
        except InvalidSignature as exc:
            raise ValueError(f"Invalid {description} signature") from exc

    async def _authorized_inbound(self, peer, group_id, *, v2: bool) -> bool:
        if await self.db.is_peer_blocked(peer.peer_id):
            return False
        if not group_id:
            return await self.db.is_friend(peer.peer_id)
        member = await self.db.get_group_member(group_id, peer.peer_id)
        room = self.settings.rooms.get(group_id) if self.settings else await self.db.get_group(group_id)
        if not v2:
            return bool(room and member and member["active"])
        local = await self.db.get_group_member(group_id, self.identity.peer_id)
        return bool(room and member and member["active"] and local and local["active"])

    async def _handle_offer(self, peer, packet, v2: bool) -> None:
        capability = CAP_FILE_TRANSFER_V2 if v2 else CAP_FILE_TRANSFER
        if not peer.supports(capability):
            raise ValueError("Peer did not negotiate file transfer")
        offer = (FileOfferV2Payload if v2 else FileOfferPayload).decode(packet.payload)
        if offer.sender_id != peer.peer_id or offer.recipient_id != self.identity.peer_id:
            raise ValueError("File offer routing mismatch")
        self._verify(peer, offer, "file offer")
        existing = await self.db.get_file_transfer(offer.file_id)
        if existing:
            expected_hash = offer.file_sha256 if v2 else existing.get("file_sha256", "")
            if existing["direction"] != "inbound" or existing["sender_id"] != offer.sender_id or existing["recipient_id"] != offer.recipient_id or existing["file_size"] != offer.file_size or existing["chunk_size"] != offer.chunk_size or existing["total_chunks"] != offer.total_chunks or existing["group_id"] != offer.group_id or existing.get("file_sha256", "") != expected_hash:
                raise ValueError("Conflicting file offer")
            if existing["status"] == "completed":
                await self._send_ack(peer, offer.file_id, "completed", v2=v2)
            await self._replay_early(offer.file_id)
            return
        if not await self._authorized_inbound(peer, offer.group_id, v2=v2):
            await self._send_ack(peer, offer.file_id, "blocked", v2=v2)
            return
        if await self.db.is_message_seen(offer.file_id):
            return
        safe = sanitize_filename(offer.filename)
        path = self._incoming_path_for(offer.file_id, offer.sender_id, offer.group_id, safe, offer.created_at)
        for _ in range(100):
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                with open(path, "xb", opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
                    output.seek(offer.file_size - 1)
                    output.write(b"\0")
                os.chmod(path, 0o600)
                break
            except FileExistsError:
                path = self._incoming_path_for(offer.file_id, offer.sender_id, offer.group_id, safe, offer.created_at)
                continue
            except OSError as exc:
                logger.warning("Failed to preallocate file %s: %s", offer.file_id, exc)
                return
        else:
            logger.warning("Failed to preallocate file %s: no free filename", offer.file_id)
            return
        await self.db.save_file_transfer({
            "file_id": offer.file_id, "filename": safe, "file_size": offer.file_size,
            "chunk_size": offer.chunk_size, "total_chunks": offer.total_chunks,
            "sender_id": offer.sender_id, "recipient_id": offer.recipient_id,
            "group_id": offer.group_id, "direction": "inbound", "status": "transferring",
            "file_path": str(path), "created_at": offer.created_at, "received_chunks": 0,
            "file_sha256": offer.file_sha256 if v2 else "", "caption": offer.caption if v2 else "",
            "batch_id": offer.batch_id if v2 else None, "batch_index": offer.batch_index if v2 else None,
            "batch_count": offer.batch_count if v2 else None,
        })
        await self.db.mark_message_seen(offer.file_id)
        self._emit({"event": "file_offer", "file_id": offer.file_id, "filename": safe, "file_size": offer.file_size, "sender_id": peer.peer_id, "group_id": offer.group_id, "caption": offer.caption if v2 else "", "batch_id": offer.batch_id if v2 else None})
        await self._replay_early(offer.file_id)

    async def _handle_chunk(self, peer, packet, v2: bool) -> None:
        capability = CAP_FILE_TRANSFER_V2 if v2 else CAP_FILE_TRANSFER
        if not peer.supports(capability):
            raise ValueError("Peer did not negotiate file transfer")
        chunk = (FileChunkV2Payload if v2 else FileChunkPayload).decode(packet.payload)
        if chunk.sender_id != peer.peer_id or chunk.recipient_id != self.identity.peer_id:
            raise ValueError("File chunk routing mismatch")
        self._verify(peer, chunk, "file chunk")
        transfer = await self.db.get_file_transfer(chunk.file_id)
        if not transfer:
            self._evict_stale_early_chunks()
            total = sum(len(values) for _, values in self._early_chunks.values())
            received, values = self._early_chunks.get(chunk.file_id, (time.monotonic(), []))
            if total < MAX_EARLY_CHUNKS and len(values) < MAX_EARLY_CHUNKS_PER_FILE:
                values.append((peer, chunk, v2))
                self._early_chunks[chunk.file_id] = (received, values)
            return
        if transfer["status"] == "completed":
            await self._send_ack(peer, chunk.file_id, "completed", v2=v2)
            return
        if not await self._authorized_inbound(peer, transfer["group_id"], v2=v2):
            await self._send_ack(peer, chunk.file_id, "blocked", v2=v2)
            return
        try:
            await self._store_chunk(peer, chunk, transfer, v2)
        except Exception:
            logger.warning("Dropped invalid file chunk for %s", chunk.file_id, exc_info=True)

    async def _replay_early(self, file_id: str) -> None:
        _, values = self._early_chunks.pop(file_id, (0, []))
        for peer, chunk, v2 in values:
            try:
                transfer = await self.db.get_file_transfer(file_id)
                if not transfer or transfer["status"] == "completed":
                    continue
                if not await self._authorized_inbound(peer, transfer["group_id"], v2=v2):
                    await self._send_ack(peer, file_id, "blocked", v2=v2)
                    continue
                await self._store_chunk(peer, chunk, transfer, v2)
            except Exception:
                logger.warning("Dropped invalid early chunk for %s", file_id, exc_info=True)

    def _evict_stale_early_chunks(self) -> None:
        cutoff = time.monotonic() - EARLY_CHUNK_TTL
        for file_id, (received, _) in list(self._early_chunks.items()):
            if received < cutoff:
                self._early_chunks.pop(file_id, None)

    async def _store_chunk(self, peer, chunk, transfer, v2: bool) -> None:
        expected_v2 = bool(transfer.get("file_sha256"))
        if expected_v2 != v2 or transfer["direction"] != "inbound" or transfer["status"] not in ("transferring", "pending", "failed") or transfer["sender_id"] != chunk.sender_id or transfer["recipient_id"] != chunk.recipient_id or transfer["group_id"] != chunk.group_id or transfer["total_chunks"] != chunk.total_chunks:
            raise ValueError("File chunk does not match its offer")
        if await self.db.is_file_chunk_received(chunk.file_id, chunk.chunk_index):
            return
        try:
            plaintext = decrypt_as_recipient(self.identity.encryption_private_key, chunk.encrypted_content, chunk.associated_data())
        except Exception as exc:
            raise ValueError("Failed to decrypt file chunk") from exc
        expected = min(transfer["chunk_size"], transfer["file_size"] - chunk.chunk_index * transfer["chunk_size"])
        if len(plaintext) != expected:
            raise ValueError("Invalid file chunk size")
        try:
            with open(Path(transfer["file_path"]), "r+b") as output:
                output.seek(chunk.chunk_index * transfer["chunk_size"])
                output.write(plaintext)
        except OSError as exc:
            await self.db.update_file_transfer(chunk.file_id, status="failed")
            self._emit({"event": "file_failed", "file_id": chunk.file_id, "group_id": transfer["group_id"]})
            logger.warning("Failed to write chunk for %s: %s", chunk.file_id, exc)
            return
        received = await self.db.record_file_chunk_received(chunk.file_id, chunk.chunk_index, commit=False)
        if received % FILE_PROGRESS_COMMIT_CHUNKS == 0 or received == transfer["total_chunks"]:
            await self._commit_file_progress(chunk.file_id)
        else:
            self._schedule_progress_commit(chunk.file_id)
        if self._should_emit_progress(chunk.file_id, received, chunk.total_chunks):
            self._emit({"event": "file_progress", "file_id": chunk.file_id, "received": received, "total_chunks": chunk.total_chunks, "direction": "inbound", "group_id": transfer["group_id"]})
        if received == transfer["total_chunks"]:
            await self._complete_inbound_transfer(peer, transfer, v2=v2)

    async def _complete_inbound_transfer(self, peer, transfer, v2: bool | None = None) -> None:
        v2 = bool(transfer.get("file_sha256")) if v2 is None else v2
        path = Path(transfer["file_path"])
        try:
            valid_size = path.stat().st_size == transfer["file_size"]
            digest = ""
            if valid_size and v2:
                hasher = hashlib.sha256()
                with open(path, "rb") as source:
                    for block in iter(lambda: source.read(1024 * 1024), b""):
                        hasher.update(block)
                digest = hasher.hexdigest()
            valid = valid_size and (not v2 or digest == transfer["file_sha256"])
        except OSError:
            valid = False
        if not valid:
            await self.db.update_file_transfer(transfer["file_id"], status="failed")
            if v2 and transfer["file_id"] not in self._integrity_retries:
                self._integrity_retries.add(transfer["file_id"])
                path.unlink(missing_ok=True)
                try:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with open(path, "xb", opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
                        output.seek(transfer["file_size"] - 1)
                        output.write(b"\0")
                    os.chmod(path, 0o600)
                    # A full retry must overwrite every previously accepted chunk.
                    await self.db._db.execute("DELETE FROM file_received_chunks WHERE file_id = ?", (transfer["file_id"],))
                    await self.db._db.execute("UPDATE file_transfers SET received_chunks = 0 WHERE file_id = ?", (transfer["file_id"],))
                    await self.db.update_file_transfer(transfer["file_id"], status="transferring")
                    await self.db.commit()
                    await self._send_ack(peer, transfer["file_id"], "missing", [(0, transfer["total_chunks"] - 1)], v2=True)
                except OSError:
                    pass
            return
        self._integrity_retries.discard(transfer["file_id"])
        await self.db.complete_file_transfer(transfer["file_id"], time.time())
        await self._send_ack(peer, transfer["file_id"], "completed", v2=v2)
        self._emit({"event": "file_completed", "file_id": transfer["file_id"], "filename": transfer["filename"], "file_path": str(path), "file_size": transfer["file_size"], "sender_id": peer.peer_id, "group_id": transfer["group_id"], "caption": transfer.get("caption", ""), "batch_id": transfer.get("batch_id")})

    async def _send_ack(self, peer, file_id, status, ranges=None, *, v2: bool) -> None:
        if v2:
            if not peer.supports(CAP_FILE_TRANSFER_V2) or (
                status == "blocked" and not peer.supports(CAP_BLOCK_REPORTS)
            ):
                return
            ack = FileAckV2Payload(file_id=file_id, recipient_id=self.identity.peer_id, status=status, missing_ranges=ranges)
            packet_type = PacketType.FILE_ACK_V2
        else:
            if not peer.supports(CAP_FILE_TRANSFER) or (status == "blocked" and not peer.supports(CAP_BLOCK_REPORTS)):
                return
            ack = FileAckPayload(file_id=file_id, recipient_id=self.identity.peer_id, status=status, missing_ranges=ranges or [])
            packet_type = PacketType.FILE_ACK
        ack.signature = self.identity.signing_private_key.sign(ack.signed_bytes())
        encoded = ack.encode()
        try:
            await self.peer_manager.send_packet(peer, Packet(packet_type, encoded))
        except Exception as exc:
            if v2:
                await self.db.add_to_outqueue(peer.peer_id, packet_type.value, encoded, file_id)
            logger.warning("Failed to send file ACK %s to %s: %s", file_id, peer.peer_id, exc)

    async def _handle_ack(self, peer, packet, v2: bool) -> None:
        if v2 and not peer.supports(CAP_FILE_TRANSFER_V2):
            raise ValueError("Peer did not negotiate file transfer v2")
        ack = (FileAckV2Payload if v2 else FileAckPayload).decode(packet.payload)
        if ack.recipient_id != peer.peer_id:
            raise ValueError("File ack identity mismatch")
        self._verify(peer, ack, "file ack")
        transfer = await self.db.get_file_transfer(ack.file_id)
        if not transfer or transfer["direction"] != "outbound" or transfer["sender_id"] != self.identity.peer_id:
            return
        if bool(transfer.get("file_sha256")) != v2:
            return
        delivery = await self.db.get_file_delivery(ack.file_id, peer.peer_id) if transfer["group_id"] else None
        if transfer["group_id"] and (v2 or delivery):
            if not delivery or delivery["status"] == "completed":
                return
        elif transfer["recipient_id"] != peer.peer_id or transfer["status"] == "completed":
            return
        if ack.status == "completed":
            await self._set_delivery(transfer, peer.peer_id, "completed")
            self._awaiting_ack_since.pop((ack.file_id, peer.peer_id), None)
            await self.db.remove_file_from_outqueue(ack.file_id, peer.peer_id)
            self._emit({"event": "file_delivered", "file_id": ack.file_id, "recipient_id": peer.peer_id, "group_id": transfer["group_id"]})
        elif ack.status == "blocked":
            await self._set_delivery(transfer, peer.peer_id, "blocked")
            await self.db.remove_file_from_outqueue(ack.file_id, peer.peer_id)
            self._emit({"event": "file_blocked", "file_id": ack.file_id, "recipient_id": peer.peer_id, "display_name": peer.display_name, "group_id": transfer["group_id"]})
        elif ack.status == "missing":
            if any(end >= transfer["total_chunks"] for _, end in (ack.missing_ranges or [])):
                logger.warning("Dropped invalid missing range for %s from %s", ack.file_id, peer.peer_id)
                return
            if transfer["group_id"]:
                if not await self._authorized_inbound(peer, transfer["group_id"], v2=v2):
                    await self._set_delivery(transfer, peer.peer_id, "unavailable")
                    await self.db.remove_file_from_outqueue(ack.file_id, peer.peer_id)
                    return
            elif await self.db.is_peer_blocked(peer.peer_id):
                await self.db.update_file_transfer(ack.file_id, status="blocked")
                await self.db.remove_file_from_outqueue(ack.file_id, peer.peer_id)
                return
            elif not await self.db.is_friend(peer.peer_id):
                await self.db.update_file_transfer(ack.file_id, status="unavailable")
                await self.db.remove_file_from_outqueue(ack.file_id, peer.peer_id)
                return
            if v2:
                await self._resend_missing_chunks(peer, transfer, ack.missing_ranges or [])
            else:
                await self._resend_missing_chunks_v1(peer, transfer, ack.missing_ranges or [])

    async def _resend_missing_chunks_v1(self, peer, transfer, ranges) -> None:
        try:
            with open(Path(transfer["file_path"]), "rb") as source:
                for start, end in ranges:
                    for index in range(start, end + 1):
                        source.seek(index * transfer["chunk_size"])
                        payload = FileChunkPayload(
                            file_id=transfer["file_id"], chunk_index=index,
                            total_chunks=transfer["total_chunks"], sender_id=self.identity.peer_id,
                            recipient_id=peer.peer_id, group_id=transfer["group_id"], encrypted_content=b"",
                        )
                        payload.encrypted_content = encrypt_for_recipient(
                            peer.encryption_public_key, source.read(transfer["chunk_size"]), payload.associated_data()
                        )
                        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
                        await self.peer_manager.send_packet(peer, Packet(PacketType.FILE_CHUNK, payload.encode()))
        except Exception as exc:
            await self.db.update_file_transfer(transfer["file_id"], status="queued")
            logger.warning("Failed to resume legacy file %s: %s", transfer["file_id"], exc)

    async def _resend_missing_chunks(self, peer, transfer, ranges) -> None:
        lock = self._flush_lock(transfer["file_id"], peer.peer_id)
        try:
            async with lock:
                try:
                    await self.db.remove_file_from_outqueue(transfer["file_id"], peer.peer_id)
                    if not await self._stream_ranges(peer, transfer, peer.peer_id, ranges):
                        await self._set_delivery(transfer, peer.peer_id, "queued")
                        return
                except Exception as exc:
                    logger.warning("Failed to resume file %s: %s", transfer["file_id"], exc)
                    if peer.encryption_public_key:
                        try:
                            if await self._queue_ranges(transfer, peer.peer_id, peer.encryption_public_key, ranges):
                                await self._set_delivery(transfer, peer.peer_id, "queued")
                        except Exception:
                            logger.warning("Failed to queue resumed file %s", transfer["file_id"], exc_info=True)
        finally:
            self._release_flush_lock(transfer["file_id"], peer.peer_id, lock)

    async def list_transfers(self, peer_id: str | None = None, group_id: str | None = None) -> list[dict]:
        transfers = await self.db.get_file_transfers(peer_id=peer_id, group_id=group_id)
        for transfer in transfers:
            if transfer["group_id"] and transfer["direction"] == "outbound":
                transfer["deliveries"] = await self.db.get_file_deliveries(transfer["file_id"])
        return transfers

    async def get_transfer(self, file_id: str) -> dict | None:
        transfer = await self.db.get_file_transfer(file_id)
        if transfer and transfer["group_id"] and transfer["direction"] == "outbound":
            transfer["deliveries"] = await self.db.get_file_deliveries(file_id)
        return transfer

    async def download_file(self, file_id: str, dest_path_str: str) -> str:
        transfer = await self.db.get_file_transfer(file_id)
        if not transfer:
            raise ValueError("Unknown file_id")
        source = Path(transfer["file_path"] or "")
        if transfer["direction"] == "outbound":
            # Senders copy from their own immutable snapshot: gate on local
            # completeness, never on the delivery aggregate.
            try:
                complete = source.is_file() and source.stat().st_size == transfer["file_size"]
            except OSError:
                complete = False
            if not complete:
                raise ValueError(f"File not ready for download (status={transfer['status']})")
        else:
            if transfer["status"] != "completed":
                raise ValueError(f"File not ready for download (status={transfer['status']})")
            if not source.is_file():
                raise ValueError("Source file not found; it may have been moved or deleted")
        raw = dest_path_str.strip().strip('"').strip("'")
        if not raw:
            raise ValueError("Destination path required")
        if raw.startswith("file://"):
            raw = raw[7:]
            if raw.startswith("/") and len(raw) > 3 and raw[2] == ":":
                raw = raw[1:]
            raw = raw.replace("/", os.sep)
        destination = Path(raw).expanduser()
        if not destination.is_absolute():
            destination = Path.cwd() / destination
        if destination.exists() and destination.is_dir():
            destination /= transfer["filename"]
        if os.path.islink(destination):
            raise ValueError("Destination is a symlink; choose a different path")
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with open(source, "rb") as src, open(fd, "wb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
            try:
                shutil.copystat(source, destination)
                os.chmod(destination, 0o600)
            except OSError:
                pass
        except OSError as exc:
            raise ValueError(f"Failed to copy file: {exc}") from exc
        return str(destination.resolve())
