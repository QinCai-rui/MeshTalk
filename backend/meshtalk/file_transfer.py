"""Cross-platform file transfer over authenticated peer connections.

Files are chunked, per-chunk E2EE encrypted with recipient's X25519 key,
signed with sender's Ed25519 key, and delivered over the same reliable
transports as chat messages (LAN TCP or fragmented Remote UDP).

Cross-platform notes:
- Filenames are sanitized via protocol.sanitize_filename to remove Windows
  illegal chars, POSIX separators, control chars, reserved names, and
  traversal components. Works identically on Linux, macOS, and Windows.
- File content is treated as opaque binary; no line-ending conversion.
- Storage paths use pathlib.Path and DATA_DIR / "files" which resolves
  correctly via Path.home() on all OSes (USERPROFILE on Windows).
- Partial files are written with seek() at chunk-index offsets, so
  out-of-order arrival over UDP does not corrupt data. Preallocation avoids
  sparse-file holes being misinterpreted as complete.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import os
import time
import uuid
from pathlib import Path
from typing import Awaitable, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .database import Database
from .encryption import decrypt_as_recipient, encrypt_for_recipient
from .identity import Identity
from .peer_manager import PeerConnection, PeerManager
from .protocol import (
    CAP_FILE_TRANSFER,
    MAX_FILE_CHUNK_SIZE,
    MAX_FILE_SIZE,
    FileAckPayload,
    FileChunkPayload,
    FileOfferPayload,
    Packet,
    PacketType,
    sanitize_filename,
)

logger = logging.getLogger(__name__)

FILES_SUBDIR = "files"
MAX_EARLY_CHUNKS = 64


def _files_base(data_dir: Path) -> Path:
    return data_dir / FILES_SUBDIR


def _incoming_dir(data_dir: Path, file_id: str) -> Path:
    return _files_base(data_dir) / file_id


class FileTransferManager:
    def __init__(
        self,
        identity: Identity,
        peer_manager: PeerManager,
        db: Database,
        data_dir: Path,
        on_event: Callable[[dict], Awaitable[None]] | None = None,
    ) -> None:
        self.identity = identity
        self.peer_manager = peer_manager
        self.db = db
        self.data_dir = data_dir
        self.on_event = on_event
        self._packet_locks: dict[str, asyncio.Lock] = {}
        self._early_chunks: dict[str, list[tuple[PeerConnection, FileChunkPayload]]] = {}

    def _emit(self, event: dict) -> None:
        if self.on_event:
            asyncio.create_task(self.on_event(event))

    async def send_file(self, recipient_id: str, file_path_str: str, group_id: str | None = None) -> str:
        # Cross-platform path handling: expanduser, handle both separators,
        # resolve without requiring existence of intermediate symlinks.
        raw = file_path_str.strip().strip('"').strip("'")
        # Expanduser works on Windows and POSIX
        p = Path(raw).expanduser()
        # For relative paths, resolve against cwd, but don't fail if file doesn't exist yet
        if not p.is_absolute():
            # Use absolute without resolve to avoid symlink issues on Windows
            p = Path.cwd() / p
        # Normalize separators
        try:
            # exists check cross-platform
            if not p.exists():
                raise ValueError(f"File not found: {p}")
            if not p.is_file():
                raise ValueError(f"Not a file: {p}")
            size = p.stat().st_size
        except OSError as exc:
            raise ValueError(f"Cannot access file: {exc}") from exc
        if size == 0:
            raise ValueError("File is empty")
        if size > MAX_FILE_SIZE:
            raise ValueError(f"File exceeds {MAX_FILE_SIZE // (1024*1024)} MiB limit")
        filename = sanitize_filename(p.name)
        chunk_size = MAX_FILE_CHUNK_SIZE
        total_chunks = math.ceil(size / chunk_size)
        file_id = str(uuid.uuid4())
        created_at = time.time()
        # Save transfer record as outbound
        await self.db.save_file_transfer({
            "file_id": file_id,
            "filename": filename,
            "file_size": size,
            "chunk_size": chunk_size,
            "total_chunks": total_chunks,
            "sender_id": self.identity.peer_id,
            "recipient_id": recipient_id,
            "group_id": group_id,
            "direction": "outbound",
            "status": "pending",
            "file_path": str(p),
            "created_at": created_at,
            "received_chunks": 0,
        })
        # Prepare offer
        offer = FileOfferPayload(
            file_id=file_id,
            filename=filename,
            file_size=size,
            chunk_size=chunk_size,
            total_chunks=total_chunks,
            sender_id=self.identity.peer_id,
            recipient_id=recipient_id,
            group_id=group_id,
            created_at=created_at,
        )
        offer.signature = self.identity.signing_private_key.sign(offer.signed_bytes())
        # Determine if peer online
        peer = self.peer_manager.get_connected_peer(recipient_id)
        encryption_key = None
        if peer:
            if not peer.supports(CAP_FILE_TRANSFER):
                await self.db.update_file_transfer(file_id, status="unavailable")
                raise ValueError("Peer does not support file transfer")
            encryption_key = peer.encryption_public_key
        else:
            stored = await self.db.get_peer(recipient_id)
            if stored and stored.get("public_key"):
                encryption_key = stored["public_key"]
            else:
                await self.db.update_file_transfer(file_id, status="unavailable")
                raise ValueError("No known public key for recipient; connect once before sending offline")
            # Queue for later flush - don't send now
            encoded_offer = offer.encode()
            await self.db.add_to_outqueue(recipient_id, PacketType.FILE_OFFER.value, encoded_offer, message_id=file_id, group_id=group_id)
            # We will re-read file on flush; mark queued
            await self.db.update_file_transfer(file_id, status="queued")
            self._emit({"event": "file_queued", "file_id": file_id, "recipient_id": recipient_id, "filename": filename})
            return file_id
        # Online: send offer then chunks
        await self.db.update_file_transfer(file_id, status="transferring")
        try:
            await self.peer_manager.send_packet(peer, Packet(PacketType.FILE_OFFER, offer.encode()))
        except Exception as exc:
            # Queue for retry
            await self.db.add_to_outqueue(recipient_id, PacketType.FILE_OFFER.value, offer.encode(), message_id=file_id, group_id=group_id)
            await self.db.update_file_transfer(file_id, status="queued")
            logger.warning("Failed to send file offer %s: %s", file_id, exc)
            return file_id
        # Stream chunks
        await self._send_chunks(p, file_id, recipient_id, group_id, chunk_size, total_chunks, encryption_key, peer)
        return file_id

    async def _send_chunks(self, path: Path, file_id: str, recipient_id: str, group_id: str | None, chunk_size: int, total_chunks: int, encryption_key: bytes, peer: PeerConnection) -> None:
        try:
            with open(path, "rb") as f:
                for idx in range(total_chunks):
                    f.seek(idx * chunk_size)
                    plaintext = f.read(chunk_size)
                    # Encrypt per-chunk
                    payload = FileChunkPayload(
                        file_id=file_id,
                        chunk_index=idx,
                        total_chunks=total_chunks,
                        sender_id=self.identity.peer_id,
                        recipient_id=recipient_id,
                        group_id=group_id,
                        encrypted_content=b"",
                    )
                    payload.encrypted_content = encrypt_for_recipient(encryption_key, plaintext, payload.associated_data())
                    payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
                    try:
                        await self.peer_manager.send_packet(peer, Packet(PacketType.FILE_CHUNK, payload.encode()))
                    except Exception as exc:
                        # Queue remaining chunks
                        await self.db.add_to_outqueue(recipient_id, PacketType.FILE_CHUNK.value, payload.encode(), message_id=file_id, group_id=group_id)
                        # Also queue remaining not yet read? Need to continue queuing rest
                        # Read ahead and queue remaining plaintext chunks
                        for remaining in range(idx + 1, total_chunks):
                            f.seek(remaining * chunk_size)
                            pt = f.read(chunk_size)
                            rp = FileChunkPayload(file_id=file_id, chunk_index=remaining, total_chunks=total_chunks, sender_id=self.identity.peer_id, recipient_id=recipient_id, group_id=group_id, encrypted_content=b"")
                            rp.encrypted_content = encrypt_for_recipient(encryption_key, pt, rp.associated_data())
                            rp.signature = self.identity.signing_private_key.sign(rp.signed_bytes())
                            await self.db.add_to_outqueue(recipient_id, PacketType.FILE_CHUNK.value, rp.encode(), message_id=file_id, group_id=group_id)
                        await self.db.update_file_transfer(file_id, status="queued")
                        logger.warning("File %s chunk %d failed, queued remainder: %s", file_id, idx, exc)
                        return
                    # Emit progress
                    self._emit({"event": "file_progress", "file_id": file_id, "chunk_index": idx, "total_chunks": total_chunks, "direction": "outbound"})
                    # Small yield to avoid blocking
                    if idx % 10 == 0:
                        import asyncio
                        await asyncio.sleep(0)
            await self.db.update_file_transfer(file_id, status="sent")
            self._emit({"event": "file_sent", "file_id": file_id, "recipient_id": recipient_id, "filename": Path(path).name})
        except OSError as exc:
            await self.db.update_file_transfer(file_id, status="failed")
            raise ValueError(f"Failed to read file: {exc}") from exc

    async def flush_for_peer(self, peer_id: str) -> int:
        # Flush queued file transfers for this peer - re-read file and resend
        transfers = [t for t in await self.db.get_file_transfers(peer_id) if t["status"] == "queued" and t["direction"] == "outbound"]
        flushed = 0
        for t in transfers:
            peer = self.peer_manager.get_connected_peer(peer_id)
            if not peer or not peer.supports(CAP_FILE_TRANSFER):
                continue
            path = Path(t["file_path"]) if t["file_path"] else None
            if not path or not path.exists():
                await self.db.update_file_transfer(t["file_id"], status="failed")
                continue
            encryption_key = peer.encryption_public_key
            if not encryption_key:
                continue
            # Re-send offer if needed (check if not already acked? For simplicity resend offer)
            offer = FileOfferPayload(
                file_id=t["file_id"], filename=t["filename"], file_size=t["file_size"],
                chunk_size=t["chunk_size"], total_chunks=t["total_chunks"],
                sender_id=t["sender_id"], recipient_id=t["recipient_id"],
                group_id=t["group_id"], created_at=t["created_at"],
            )
            offer.signature = self.identity.signing_private_key.sign(offer.signed_bytes())
            try:
                await self.peer_manager.send_packet(peer, Packet(PacketType.FILE_OFFER, offer.encode()))
            except Exception:
                continue
            # Remove queued offer from outqueue if present
            pending = await self.db.get_pending_outgoing(peer_id)
            for item in pending:
                if item["message_id"] == t["file_id"] and item["packet_type"] == PacketType.FILE_OFFER.value:
                    await self.db.remove_from_outqueue(item["id"])
            await self.db.update_file_transfer(t["file_id"], status="transferring")
            await self._send_chunks(path, t["file_id"], peer_id, t["group_id"], t["chunk_size"], t["total_chunks"], encryption_key, peer)
            updated_transfer = await self.db.get_file_transfer(t["file_id"])
            if updated_transfer and updated_transfer["status"] != "queued":
                flushed += 1
            # Remove queued chunk entries as they are now sent
            pending = await self.db.get_pending_outgoing(peer_id)
            for item in pending:
                if item["message_id"] == t["file_id"] and item["packet_type"] == PacketType.FILE_CHUNK.value:
                    await self.db.remove_from_outqueue(item["id"])
        return flushed

    async def resume_for_peer(self, peer_id: str) -> None:
        peer = self.peer_manager.get_connected_peer(peer_id)
        if not peer or not peer.supports(CAP_FILE_TRANSFER):
            return
        transfers = await self.db.get_file_transfers(peer_id)
        for transfer in transfers:
            if (
                transfer["direction"] != "inbound"
                or transfer["sender_id"] != peer_id
                or transfer["recipient_id"] != self.identity.peer_id
            ):
                continue
            if transfer["status"] == "completed":
                await self._send_completion_ack(peer, transfer["file_id"])
                continue
            if transfer["status"] != "transferring":
                continue
            missing_ranges = await self.db.get_missing_file_chunk_ranges(
                transfer["file_id"], transfer["total_chunks"]
            )
            if missing_ranges:
                await self._send_missing_request(peer, transfer["file_id"], missing_ranges)
            else:
                await self._complete_inbound_transfer(peer, transfer)

    async def handle_packet(self, peer: PeerConnection, packet: Packet) -> bool:
        if packet.type not in (PacketType.FILE_OFFER, PacketType.FILE_CHUNK, PacketType.FILE_ACK):
            return False
        # UDP dispatches application handlers independently. Serialize file
        # packets per peer so an offer creates its transfer before its chunks.
        lock = self._packet_locks.setdefault(peer.peer_id, asyncio.Lock())
        async with lock:
            if packet.type == PacketType.FILE_OFFER:
                await self._handle_offer(peer, packet)
            elif packet.type == PacketType.FILE_CHUNK:
                await self._handle_chunk(peer, packet)
            else:
                await self._handle_ack(peer, packet)
        return True

    async def _handle_offer(self, peer: PeerConnection, packet: Packet) -> None:
        if not peer.supports(CAP_FILE_TRANSFER):
            raise ValueError("Peer did not negotiate file transfer")
        offer = FileOfferPayload.decode(packet.payload)
        if offer.sender_id != peer.peer_id or offer.recipient_id != self.identity.peer_id:
            raise ValueError("File offer routing mismatch")
        if peer.signing_public_key is None:
            raise ValueError("Missing signing key")
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(offer.signature, offer.signed_bytes())
        except InvalidSignature as exc:
            raise ValueError("Invalid file offer signature") from exc
        existing = await self.db.get_file_transfer(offer.file_id)
        if existing:
            if (
                existing["direction"] != "inbound"
                or existing["sender_id"] != offer.sender_id
                or existing["recipient_id"] != offer.recipient_id
                or existing["file_size"] != offer.file_size
                or existing["chunk_size"] != offer.chunk_size
                or existing["total_chunks"] != offer.total_chunks
                or existing["group_id"] != offer.group_id
            ):
                raise ValueError("Conflicting file offer")
            if existing["status"] == "completed":
                await self._send_completion_ack(peer, offer.file_id)
                return
            await self._store_early_chunks(offer.file_id)
            return
        if await self.db.is_message_seen(offer.file_id):
            return
        # Check friend policy: require friend for direct files
        if not offer.group_id:
            is_friend = await self.db.is_friend(peer.peer_id)
            if not is_friend:
                logger.info("Blocked file %s from non-friend %s", offer.file_id, peer.peer_id)
                return
        await self.db.mark_message_seen(offer.file_id)
        # Create inbound transfer record and prepare file
        safe_name = sanitize_filename(offer.filename)
        incoming_path = _incoming_dir(self.data_dir, offer.file_id) / safe_name
        incoming_path.parent.mkdir(parents=True, exist_ok=True)
        # Preallocate file to file_size with zeros (cross-platform)
        try:
            with open(incoming_path, "wb") as f:
                if offer.file_size > 0:
                    f.seek(offer.file_size - 1)
                    f.write(b"\x00")
        except OSError as exc:
            logger.warning("Failed to preallocate file %s: %s", offer.file_id, exc)
            raise
        await self.db.save_file_transfer({
            "file_id": offer.file_id,
            "filename": safe_name,
            "file_size": offer.file_size,
            "chunk_size": offer.chunk_size,
            "total_chunks": offer.total_chunks,
            "sender_id": offer.sender_id,
            "recipient_id": offer.recipient_id,
            "group_id": offer.group_id,
            "direction": "inbound",
            "status": "transferring",
            "file_path": str(incoming_path),
            "created_at": offer.created_at,
            "received_chunks": 0,
        })
        self._emit({"event": "file_offer", "file_id": offer.file_id, "filename": safe_name, "file_size": offer.file_size, "sender_id": peer.peer_id})
        logger.info("Accepted file offer %s (%s, %d bytes, %d chunks) from %s", offer.file_id, safe_name, offer.file_size, offer.total_chunks, peer.peer_id)
        await self._store_early_chunks(offer.file_id)

    async def _handle_chunk(self, peer: PeerConnection, packet: Packet) -> None:
        if not peer.supports(CAP_FILE_TRANSFER):
            raise ValueError("Peer did not negotiate file transfer")
        chunk = FileChunkPayload.decode(packet.payload)
        if chunk.sender_id != peer.peer_id or chunk.recipient_id != self.identity.peer_id:
            raise ValueError("File chunk routing mismatch")
        if peer.signing_public_key is None:
            raise ValueError("Missing signing key")
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(chunk.signature, chunk.signed_bytes())
        except InvalidSignature as exc:
            raise ValueError("Invalid file chunk signature") from exc
        transfer = await self.db.get_file_transfer(chunk.file_id)
        if not transfer:
            if sum(len(chunks) for chunks in self._early_chunks.values()) < MAX_EARLY_CHUNKS:
                self._early_chunks.setdefault(chunk.file_id, []).append((peer, chunk))
                logger.debug("Buffered chunk for file offer %s", chunk.file_id)
            else:
                logger.warning("Dropped early file chunk for %s: buffer is full", chunk.file_id)
            return
        if transfer["status"] == "completed":
            await self._send_completion_ack(peer, chunk.file_id)
            return
        await self._store_chunk(peer, chunk, transfer)

    async def _store_early_chunks(self, file_id: str) -> None:
        for peer, chunk in self._early_chunks.pop(file_id, []):
            transfer = await self.db.get_file_transfer(file_id)
            if transfer:
                await self._store_chunk(peer, chunk, transfer)

    async def _store_chunk(self, peer: PeerConnection, chunk: FileChunkPayload, transfer: dict) -> None:
        if (
            transfer["direction"] != "inbound"
            or transfer["status"] not in ("transferring", "pending")
            or transfer["sender_id"] != chunk.sender_id
            or transfer["recipient_id"] != chunk.recipient_id
            or transfer["group_id"] != chunk.group_id
            or transfer["total_chunks"] != chunk.total_chunks
            or chunk.chunk_index >= transfer["total_chunks"]
        ):
            raise ValueError("File chunk does not match its offer")
        if await self.db.is_file_chunk_received(chunk.file_id, chunk.chunk_index):
            return
        # Decrypt
        try:
            plaintext = decrypt_as_recipient(self.identity.encryption_private_key, chunk.encrypted_content, chunk.associated_data())
        except Exception as exc:
            raise ValueError("Failed to decrypt file chunk") from exc
        expected_size = min(
            transfer["chunk_size"],
            transfer["file_size"] - chunk.chunk_index * transfer["chunk_size"],
        )
        if len(plaintext) != expected_size:
            raise ValueError("Invalid file chunk size")
        # Write at offset
        file_path = Path(transfer["file_path"])
        try:
            # Ensure parent exists
            file_path.parent.mkdir(parents=True, exist_ok=True)
            with open(file_path, "r+b") as f:
                offset = chunk.chunk_index * transfer["chunk_size"]
                f.seek(offset)
                f.write(plaintext)
        except OSError as exc:
            logger.warning("Failed to write chunk %d for %s: %s", chunk.chunk_index, chunk.file_id, exc)
            raise
        received_count = await self.db.record_file_chunk_received(chunk.file_id, chunk.chunk_index)
        self._emit({"event": "file_progress", "file_id": chunk.file_id, "chunk_index": chunk.chunk_index, "total_chunks": chunk.total_chunks, "direction": "inbound", "received": received_count})
        # Check completion
        if received_count == transfer["total_chunks"]:
            await self._complete_inbound_transfer(peer, transfer)

    async def _complete_inbound_transfer(self, peer: PeerConnection, transfer: dict) -> None:
        file_path = Path(transfer["file_path"])
        if file_path.stat().st_size != transfer["file_size"]:
            raise ValueError("Received file has an invalid size")
        await self.db.complete_file_transfer(transfer["file_id"], time.time())
        await self._send_completion_ack(peer, transfer["file_id"])
        self._emit({"event": "file_completed", "file_id": transfer["file_id"], "filename": transfer["filename"], "file_path": str(file_path), "file_size": transfer["file_size"], "sender_id": peer.peer_id})
        logger.info("Completed file %s from %s -> %s", transfer["file_id"], peer.peer_id, file_path)
        try:
            os.chmod(file_path, 0o600)
        except OSError:
            pass

    async def _send_completion_ack(self, peer: PeerConnection, file_id: str) -> None:
        ack = FileAckPayload(file_id=file_id, recipient_id=self.identity.peer_id, status="completed")
        ack.signature = self.identity.signing_private_key.sign(ack.signed_bytes())
        try:
            await self.peer_manager.send_packet(peer, Packet(PacketType.FILE_ACK, ack.encode()))
        except Exception:
            pass

    async def _send_missing_request(self, peer: PeerConnection, file_id: str, missing_ranges: list[tuple[int, int]]) -> None:
        ack = FileAckPayload(
            file_id=file_id,
            recipient_id=self.identity.peer_id,
            status="missing",
            missing_ranges=missing_ranges,
        )
        ack.signature = self.identity.signing_private_key.sign(ack.signed_bytes())
        await self.peer_manager.send_packet(peer, Packet(PacketType.FILE_ACK, ack.encode()))

    async def _handle_ack(self, peer: PeerConnection, packet: Packet) -> None:
        ack = FileAckPayload.decode(packet.payload)
        if ack.recipient_id != peer.peer_id or peer.signing_public_key is None:
            raise ValueError("File ack identity mismatch")
        try:
            Ed25519PublicKey.from_public_bytes(peer.signing_public_key).verify(ack.signature, ack.signed_bytes())
        except InvalidSignature as exc:
            raise ValueError("Invalid file ack signature") from exc
        transfer = await self.db.get_file_transfer(ack.file_id)
        if (
            not transfer
            or transfer["direction"] != "outbound"
            or transfer["sender_id"] != self.identity.peer_id
            or transfer["recipient_id"] != peer.peer_id
        ):
            return
        if ack.status == "completed":
            await self.db.update_file_transfer(ack.file_id, status="completed", completed_at=time.time())
            self._emit({"event": "file_delivered", "file_id": ack.file_id, "recipient_id": peer.peer_id})
            logger.info("File %s delivered to %s", ack.file_id, peer.peer_id)
        elif ack.status == "missing":
            if any(end >= transfer["total_chunks"] for _, end in ack.missing_ranges):
                raise ValueError("Invalid missing file chunk range")
            await self._resend_missing_chunks(peer, transfer, ack.missing_ranges)

    async def _resend_missing_chunks(self, peer: PeerConnection, transfer: dict, missing_ranges: list[tuple[int, int]]) -> None:
        path = Path(transfer["file_path"]) if transfer["file_path"] else None
        if not path or not path.is_file() or not peer.encryption_public_key:
            await self.db.update_file_transfer(transfer["file_id"], status="failed")
            return
        try:
            with open(path, "rb") as file:
                for start, end in missing_ranges:
                    for index in range(start, end + 1):
                        file.seek(index * transfer["chunk_size"])
                        plaintext = file.read(transfer["chunk_size"])
                        payload = FileChunkPayload(
                            file_id=transfer["file_id"],
                            chunk_index=index,
                            total_chunks=transfer["total_chunks"],
                            sender_id=self.identity.peer_id,
                            recipient_id=peer.peer_id,
                            group_id=transfer["group_id"],
                            encrypted_content=b"",
                        )
                        payload.encrypted_content = encrypt_for_recipient(
                            peer.encryption_public_key, plaintext, payload.associated_data()
                        )
                        payload.signature = self.identity.signing_private_key.sign(payload.signed_bytes())
                        await self.peer_manager.send_packet(peer, Packet(PacketType.FILE_CHUNK, payload.encode()))
        except (OSError, ConnectionError) as exc:
            await self.db.update_file_transfer(transfer["file_id"], status="queued")
            logger.warning("Failed to resume file %s: %s", transfer["file_id"], exc)

    async def list_transfers(self) -> list[dict]:
        return await self.db.get_file_transfers()

    async def get_transfer(self, file_id: str) -> dict | None:
        return await self.db.get_file_transfer(file_id)

    async def download_file(self, file_id: str, dest_path_str: str) -> str:
        """Copy a completed file to a user-chosen destination (cross-platform).

        dest_path may be a directory (file will be placed inside with original
        filename) or a full file path. Returns the final absolute destination.
        """
        transfer = await self.db.get_file_transfer(file_id)
        if not transfer:
            raise ValueError("Unknown file_id")
        if transfer["status"] not in ("completed", "sent"):
            raise ValueError(f"File not ready for download (status={transfer['status']})")
        src = Path(transfer["file_path"]) if transfer["file_path"] else None
        if not src or not src.exists() or not src.is_file():
            raise ValueError("Source file not found; it may have been moved or deleted")
        raw = dest_path_str.strip().strip('"').strip("'")
        if not raw:
            raise ValueError("Destination path required")
        # Handle file:// URLs from drag/drop
        if raw.startswith("file://"):
            raw = raw[7:]
            if raw.startswith("/") and len(raw) > 3 and raw[2] == ":":
                raw = raw[1:]  # strip leading slash for Windows drive
            raw = raw.replace("/", os.sep)
        dest = Path(raw).expanduser()
        if not dest.is_absolute():
            dest = Path.cwd() / dest
        # If dest is an existing directory, place file inside
        try:
            if dest.exists() and dest.is_dir():
                dest = dest / transfer["filename"]
        except OSError:
            pass
        # Ensure parent exists (cross-platform mkdir -p)
        dest.parent.mkdir(parents=True, exist_ok=True)
        # If dest is a directory path ending with separator, append filename
        if str(dest).endswith(os.sep) or dest.name == "":
            dest = dest / transfer["filename"]
        # Stream copy for large files and cross-filesystem safety (binary, no newline conversion)
        import shutil
        try:
            # Use copyfile for exact bytes; preserve permissions where possible
            with open(src, "rb") as fsrc, open(dest, "wb") as fdst:
                shutil.copyfileobj(fsrc, fdst, length=1024*1024)
            try:
                shutil.copystat(src, dest)
            except OSError:
                pass
            try:
                os.chmod(dest, 0o600)
            except OSError:
                pass
        except OSError as exc:
            raise ValueError(f"Failed to copy file: {exc}") from exc
        return str(dest.resolve() if dest.exists() else dest)
