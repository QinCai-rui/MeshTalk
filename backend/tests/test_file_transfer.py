import asyncio
import hashlib
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from meshtalk.database import Database
from meshtalk.encryption import encrypt_for_recipient
from meshtalk.file_transfer import (
    MAX_PROGRESS_EVENTS,
    FileTransferManager,
)
from meshtalk.identity import Identity
from meshtalk.protocol import (
    CAP_FILE_TRANSFER,
    FileAckPayload,
    FileChunkPayload,
    FileOfferPayload,
    MAX_FILENAME_LENGTH,
    Packet,
    PacketType,
)
from meshtalk.settings import Settings


class FakePeer:
    def __init__(self, identity: Identity):
        self.peer_id = identity.peer_id
        self.display_name = identity.display_name
        self.signing_public_key = identity.signing_public_key_bytes()
        self.encryption_public_key = identity.encryption_public_key_bytes()

    def supports(self, capability: str) -> bool:
        return capability == CAP_FILE_TRANSFER


class FakePeerManager:
    def __init__(self, peer: FakePeer | None = None):
        self.peer = peer
        self.sent: list[Packet] = []

    def get_connected_peer(self, peer_id: str) -> FakePeer | None:
        return self.peer if self.peer and self.peer.peer_id == peer_id else None

    async def send_packet(self, peer: FakePeer, packet: Packet) -> None:
        self.sent.append(packet)


class FileTransferRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.sender = Identity.generate("Sender")
        self.recipient = Identity.generate("Recipient")
        self.sender_peer = FakePeer(self.sender)
        self.recipient_peer = FakePeer(self.recipient)
        self.db = Database(self.root / "transfers.db")
        await self.db.connect()
        self.settings = Settings(self.root / "settings.json")
        self.group_id = self.settings.create_room("Test group").id
        await self.db.upsert_group_member(
            self.group_id, self.sender.peer_id, self.sender.display_name
        )
        self.recipient_manager = FakePeerManager(self.sender_peer)
        self.receiver = FileTransferManager(
            self.recipient, self.recipient_manager, self.db, self.root / "recipient-files",
            settings=self.settings,
        )
        self.file_id = "transfer-recovery-test"
        self.content = b"abcdefgh"
        self.offer = FileOfferPayload(
            file_id=self.file_id,
            filename="document.bin",
            file_size=len(self.content),
            chunk_size=4,
            total_chunks=2,
            sender_id=self.sender.peer_id,
            recipient_id=self.recipient.peer_id,
            group_id=self.group_id,
            created_at=1.0,
        )
        self.offer.signature = self.sender.signing_private_key.sign(self.offer.signed_bytes())
        await self.receiver.handle_packet(
            self.sender_peer, Packet(PacketType.FILE_OFFER, self.offer.encode())
        )

    async def asyncTearDown(self):
        await self.db.close()
        self.tempdir.cleanup()

    def _chunk(self, index: int) -> Packet:
        payload = FileChunkPayload(
            file_id=self.file_id,
            chunk_index=index,
            total_chunks=2,
            sender_id=self.sender.peer_id,
            recipient_id=self.recipient.peer_id,
            group_id=self.group_id,
            encrypted_content=b"",
        )
        payload.encrypted_content = encrypt_for_recipient(
            self.recipient.encryption_public_key_bytes(),
            self.content[index * 4:(index + 1) * 4],
            payload.associated_data(),
        )
        payload.signature = self.sender.signing_private_key.sign(payload.signed_bytes())
        return Packet(PacketType.FILE_CHUNK, payload.encode())

    async def test_received_chunks_survive_manager_restart(self):
        await self.receiver.handle_packet(self.sender_peer, self._chunk(0))
        self.receiver = FileTransferManager(
            self.recipient, self.recipient_manager, self.db, self.root / "recipient-files",
            settings=self.settings,
        )
        await self.receiver.handle_packet(self.sender_peer, self._chunk(1))

        transfer = await self.db.get_file_transfer(self.file_id)
        self.assertEqual(transfer["status"], "completed")
        stored_path = Path(transfer["file_path"])
        self.assertEqual(stored_path.parent.name, self.group_id)
        self.assertEqual(stored_path.name, "document_1.bin")
        self.assertEqual(stored_path.read_bytes(), self.content)
        await self.receiver.handle_packet(self.sender_peer, self._chunk(1))
        self.assertEqual((await self.db.get_file_transfer(self.file_id))["status"], "completed")

    async def test_direct_files_use_sender_folder_and_timestamped_name(self):
        await self.db.add_friend(self.sender.peer_id, self.sender.display_name)
        file_id = "direct-transfer-test"
        offer = FileOfferPayload(
            file_id=file_id,
            filename="document.bin",
            file_size=len(self.content),
            chunk_size=4,
            total_chunks=2,
            sender_id=self.sender.peer_id,
            recipient_id=self.recipient.peer_id,
            created_at=123.75,
        )
        offer.signature = self.sender.signing_private_key.sign(offer.signed_bytes())

        await self.receiver.handle_packet(
            self.sender_peer, Packet(PacketType.FILE_OFFER, offer.encode())
        )

        transfer = await self.db.get_file_transfer(file_id)
        stored_path = Path(transfer["file_path"])
        self.assertEqual(stored_path.parent.name, self.sender.peer_id)
        self.assertEqual(stored_path.name, "document_123.bin")

    async def test_incoming_path_retries_when_suffixed_path_exists(self):
        first = self.receiver._incoming_path_for(
            self.file_id, self.sender.peer_id, None, "document.bin", 1.0
        )
        first.parent.mkdir(parents=True, exist_ok=True)
        first.touch()
        suffixed = self.receiver._incoming_path_for(
            self.file_id, self.sender.peer_id, None, "document.bin", 1.0
        )
        suffixed.touch()

        candidate = self.receiver._incoming_path_for(
            self.file_id, self.sender.peer_id, None, "document.bin", 1.0
        )

        file_id_suffix = hashlib.sha256(self.file_id.encode("utf-8")).hexdigest()[:16]
        self.assertNotEqual(candidate, suffixed)
        self.assertIn(file_id_suffix, candidate.stem)
        self.assertFalse(candidate.exists())

    async def test_collision_path_respects_maximum_filename_length(self):
        filename = "a" * (MAX_FILENAME_LENGTH - len(".bin")) + ".bin"
        first = self.receiver._incoming_path_for(
            self.file_id, self.sender.peer_id, None, filename, 1.0
        )
        first.parent.mkdir(parents=True, exist_ok=True)
        first.touch()

        candidate = self.receiver._incoming_path_for(
            self.file_id, self.sender.peer_id, None, filename, 1.0
        )

        self.assertLessEqual(len(candidate.name), MAX_FILENAME_LENGTH)
        self.assertEqual(candidate.suffix, ".bin")

    async def test_reconnect_requests_only_missing_ranges(self):
        await self.receiver.handle_packet(self.sender_peer, self._chunk(0))
        restarted = FileTransferManager(
            self.recipient, self.recipient_manager, self.db, self.root / "recipient-files",
            settings=self.settings,
        )
        await restarted.resume_for_peer(self.sender.peer_id)

        self.assertEqual(len(self.recipient_manager.sent), 1)
        ack = FileAckPayload.decode(self.recipient_manager.sent[0].payload)
        self.assertEqual(ack.status, "missing")
        self.assertEqual(ack.missing_ranges, [(1, 1)])

    async def test_missing_request_resends_only_requested_chunks(self):
        sender_db = Database(self.root / "sender.db")
        await sender_db.connect()
        source = self.root / "source.bin"
        source.write_bytes(self.content)
        await sender_db.save_file_transfer({
            "file_id": self.file_id,
            "filename": "document.bin",
            "file_size": len(self.content),
            "chunk_size": 4,
            "total_chunks": 2,
            "sender_id": self.sender.peer_id,
            "recipient_id": self.recipient.peer_id,
            "group_id": self.group_id,
            "direction": "outbound",
            "status": "sent",
            "file_path": str(source),
            "created_at": 1.0,
        })
        sender_manager = FakePeerManager(self.recipient_peer)
        sender_transfer = FileTransferManager(self.sender, sender_manager, sender_db, self.root / "sender-files")
        ack = FileAckPayload(
            file_id=self.file_id,
            recipient_id=self.recipient.peer_id,
            status="missing",
            missing_ranges=[(1, 1)],
        )
        ack.signature = self.recipient.signing_private_key.sign(ack.signed_bytes())
        await sender_transfer.handle_packet(
            self.recipient_peer, Packet(PacketType.FILE_ACK, ack.encode())
        )

        self.assertEqual(len(sender_manager.sent), 1)
        resent = FileChunkPayload.decode(sender_manager.sent[0].payload)
        self.assertEqual(resent.chunk_index, 1)
        await sender_db.close()

    async def test_outgoing_file_is_snapshotted_before_sending(self):
        source = self.root / "source.bin"
        source.write_bytes(self.content)
        sender_db = Database(self.root / "sender.db")
        await sender_db.connect()
        sender_manager = FakePeerManager(self.recipient_peer)
        sender_transfer = FileTransferManager(
            self.sender, sender_manager, sender_db, self.root / "sender-files"
        )

        file_id = await sender_transfer.send_file(self.recipient.peer_id, str(source))
        source.unlink()
        transfer = await sender_db.get_file_transfer(file_id)
        snapshot = Path(transfer["file_path"])

        self.assertTrue(snapshot.exists())
        self.assertEqual(snapshot.read_bytes(), self.content)
        self.assertEqual(stat.S_IMODE(snapshot.stat().st_mode), 0o600)
        self.assertIn("sent", snapshot.parts)
        await sender_db.close()

    async def test_outgoing_snapshot_rejects_content_over_copy_limit(self):
        source = self.root / "growing-source.bin"
        source.write_bytes(b"12345")
        sender_transfer = FileTransferManager(
            self.sender, FakePeerManager(self.recipient_peer), self.db, self.root / "sender-files"
        )

        with patch("meshtalk.file_transfer.MAX_FILE_SIZE", 4):
            with self.assertRaisesRegex(ValueError, "File exceeds"):
                sender_transfer._snapshot_outgoing_file(source, "oversize", source.name)

        destination = sender_transfer._outgoing_path_for("oversize", source.name)
        self.assertFalse(destination.exists())
        self.assertEqual(list(destination.parent.glob("*.tmp")), [])

    async def test_duplicate_completed_ack_is_ignored(self):
        sender_db = Database(self.root / "sender.db")
        await sender_db.connect()
        await sender_db.save_file_transfer({
            "file_id": self.file_id,
            "filename": "document.bin",
            "file_size": len(self.content),
            "chunk_size": 4,
            "total_chunks": 2,
            "sender_id": self.sender.peer_id,
            "recipient_id": self.recipient.peer_id,
            "group_id": self.group_id,
            "direction": "outbound",
            "status": "sent",
            "file_path": str(self.root / "source.bin"),
            "created_at": 1.0,
        })
        events: list[dict] = []

        async def on_event(event: dict) -> None:
            events.append(event)

        sender_manager = FakePeerManager(self.recipient_peer)
        sender_transfer = FileTransferManager(
            self.sender, sender_manager, sender_db, self.root / "sender-files", on_event=on_event
        )
        ack = FileAckPayload(
            file_id=self.file_id, recipient_id=self.recipient.peer_id, status="completed"
        )
        ack.signature = self.recipient.signing_private_key.sign(ack.signed_bytes())
        packet = Packet(PacketType.FILE_ACK, ack.encode())

        await sender_transfer.handle_packet(self.recipient_peer, packet)
        await sender_transfer.handle_packet(self.recipient_peer, packet)
        await asyncio.sleep(0)

        self.assertEqual((await sender_db.get_file_transfer(self.file_id))["status"], "completed")
        self.assertEqual(events, [{"event": "file_delivered", "file_id": self.file_id, "recipient_id": self.recipient.peer_id, "group_id": self.group_id}])
        await sender_db.close()

    async def test_missing_ack_after_completion_does_not_resend_file(self):
        sender_db = Database(self.root / "sender.db")
        await sender_db.connect()
        source = self.root / "source.bin"
        source.write_bytes(self.content)
        await sender_db.save_file_transfer({
            "file_id": self.file_id,
            "filename": "document.bin",
            "file_size": len(self.content),
            "chunk_size": 4,
            "total_chunks": 2,
            "sender_id": self.sender.peer_id,
            "recipient_id": self.recipient.peer_id,
            "group_id": self.group_id,
            "direction": "outbound",
            "status": "completed",
            "file_path": str(source),
            "created_at": 1.0,
        })
        sender_manager = FakePeerManager(self.recipient_peer)
        sender_transfer = FileTransferManager(self.sender, sender_manager, sender_db, self.root / "sender-files")
        ack = FileAckPayload(
            file_id=self.file_id,
            recipient_id=self.recipient.peer_id,
            status="missing",
            missing_ranges=[(1, 1)],
        )
        ack.signature = self.recipient.signing_private_key.sign(ack.signed_bytes())

        await sender_transfer.handle_packet(self.recipient_peer, Packet(PacketType.FILE_ACK, ack.encode()))

        self.assertEqual(sender_manager.sent, [])
        await sender_db.close()

    async def test_progress_updates_are_coalesced_for_large_transfers(self):
        with patch("meshtalk.file_transfer.time.monotonic", return_value=1.0):
            emitted = [
                index
                for index in range(1, 1_001)
                if self.receiver._should_emit_progress(self.file_id, index, 1_000)
            ]

        self.assertEqual(emitted[0], 1)
        self.assertEqual(emitted[-1], 1_000)
        self.assertLessEqual(len(emitted), MAX_PROGRESS_EVENTS + 1)

    async def test_partial_progress_is_flushed_after_a_bounded_delay(self):
        commit = AsyncMock()
        self.receiver.db.commit = commit

        with patch("meshtalk.file_transfer.FILE_PROGRESS_COMMIT_INTERVAL", 0.01):
            self.receiver._schedule_progress_commit(self.file_id)
            await asyncio.sleep(0.02)

        commit.assert_awaited_once()


class GroupDeliveryPreservationTest(unittest.IsolatedAsyncioTestCase):
    """Queued/inbound group rows must still flush/resume per peer.

    DM listings exclude group fan-out rows, but the per-peer delivery
    paths opt into include_group=True. These tests pin that behavior so a
    future change to the delivery flag cannot silently break group delivery
    while the listing tests stay green.
    """

    async def asyncSetUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.sender = Identity.generate("Sender")
        self.recipient = Identity.generate("Recipient")
        self.sender_peer = FakePeer(self.sender)
        self.recipient_peer = FakePeer(self.recipient)
        self.content = b"abcdefgh"

    async def asyncTearDown(self):
        self.tempdir.cleanup()

    async def test_flush_for_peer_delivers_queued_group_row(self):
        sender_db = Database(self.root / "sender.db")
        await sender_db.connect()
        try:
            source = self.root / "source.bin"
            source.write_bytes(self.content)
            await sender_db.save_file_transfer({
                "file_id": "queued-group-file",
                "filename": "group.bin",
                "file_size": len(self.content),
                "chunk_size": 4,
                "total_chunks": 2,
                "sender_id": self.sender.peer_id,
                "recipient_id": self.recipient.peer_id,
                "group_id": "a" * 32,
                "direction": "outbound",
                "status": "queued",
                "file_path": str(source),
                "created_at": 1.0,
            })
            sender_manager = FakePeerManager(self.recipient_peer)
            sender_transfer = FileTransferManager(
                self.sender, sender_manager, sender_db, self.root / "sender-files"
            )

            flushed = await sender_transfer.flush_for_peer(self.recipient.peer_id)

            self.assertEqual(flushed, 1)
            self.assertEqual(
                (await sender_db.get_file_transfer("queued-group-file"))["status"], "sent"
            )
            types = [packet.type for packet in sender_manager.sent]
            self.assertEqual(types[0], PacketType.FILE_OFFER)
            self.assertTrue(all(t == PacketType.FILE_CHUNK for t in types[1:]))
            self.assertEqual(len(types), 3)
        finally:
            await sender_db.close()

    async def test_resume_for_peer_requests_missing_group_chunks(self):
        recipient_db = Database(self.root / "recipient.db")
        await recipient_db.connect()
        try:
            await recipient_db.save_file_transfer({
                "file_id": "inbound-group-file",
                "filename": "group.bin",
                "file_size": len(self.content),
                "chunk_size": 4,
                "total_chunks": 2,
                "sender_id": self.sender.peer_id,
                "recipient_id": self.recipient.peer_id,
                "group_id": "a" * 32,
                "direction": "inbound",
                "status": "transferring",
                "file_path": str(self.root / "incoming.bin"),
                "created_at": 1.0,
            })
            recipient_manager = FakePeerManager(self.sender_peer)
            recipient_transfer = FileTransferManager(
                self.recipient, recipient_manager, recipient_db,
                self.root / "recipient-files",
            )

            await recipient_transfer.resume_for_peer(self.sender.peer_id)

            self.assertEqual(len(recipient_manager.sent), 1)
            ack = FileAckPayload.decode(recipient_manager.sent[0].payload)
            self.assertEqual(ack.status, "missing")
            self.assertEqual(ack.missing_ranges, [(0, 1)])
        finally:
            await recipient_db.close()


class DictPeerManager:
    """Fake manager serving several connected peers by ID."""

    def __init__(self, peers: dict[str, FakePeer]):
        self._peers = peers
        self.sent: list[Packet] = []

    def get_connected_peer(self, peer_id: str) -> FakePeer | None:
        return self._peers.get(peer_id)

    async def send_packet(self, peer: FakePeer, packet: Packet) -> None:
        self.sent.append(packet)


class GroupFileMirrorTest(unittest.IsolatedAsyncioTestCase):
    """Group sends mirror group messages: one shared row, per-member deliveries."""

    async def asyncSetUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.sender = Identity.generate("Sender")
        self.member_a = Identity.generate("MemberA")
        self.member_b = Identity.generate("MemberB")
        self.db = Database(self.root / "mirror.db")
        await self.db.connect()
        self.settings = Settings(self.root / "settings.json")
        self.group_id = self.settings.create_room("Mirror group").id
        await self.db.upsert_group_member(self.group_id, self.sender.peer_id, "Sender")
        await self.db.upsert_group_member(self.group_id, self.member_a.peer_id, "MemberA")
        await self.db.upsert_group_member(self.group_id, self.member_b.peer_id, "MemberB")
        # Member B is offline but known, with file-transfer capability.
        await self.db.upsert_peer(
            self.member_b.peer_id, "MemberB",
            self.member_b.encryption_public_key_bytes(),
            self.member_b.signing_public_key_bytes(),
            capabilities=[CAP_FILE_TRANSFER],
        )
        self.events: list[dict] = []

        async def on_event(event: dict) -> None:
            self.events.append(event)

        self.manager = DictPeerManager({self.member_a.peer_id: FakePeer(self.member_a)})
        self.sender_transfer = FileTransferManager(
            self.sender, self.manager, self.db, self.root / "sender-files",
            on_event=on_event, settings=self.settings,
        )
        self.source = self.root / "source.bin"
        self.source.write_bytes(b"abcdefgh")

    async def asyncTearDown(self):
        await self.db.close()
        self.tempdir.cleanup()

    def _ack(self, member: Identity, file_id: str, status: str) -> Packet:
        ack = FileAckPayload(file_id=file_id, recipient_id=member.peer_id, status=status)
        ack.signature = member.signing_private_key.sign(ack.signed_bytes())
        return Packet(PacketType.FILE_ACK, ack.encode())

    async def test_group_send_creates_single_shared_row(self):
        file_id = await self.sender_transfer.send_group_file(self.group_id, str(self.source))

        rows = await self.db.get_file_transfers(group_id=self.group_id)
        self.assertEqual([r["file_id"] for r in rows], [file_id])
        self.assertEqual(rows[0]["recipient_id"], "")
        deliveries = {d["recipient_id"]: d["status"] for d in await self.db.get_file_deliveries(file_id)}
        self.assertEqual(deliveries, {self.member_a.peer_id: "sent", self.member_b.peer_id: "queued"})
        # One snapshot shared by the whole fan-out (single sender row).
        snapshot = Path(rows[0]["file_path"])
        self.assertTrue(snapshot.exists())
        self.assertEqual(snapshot.name, "source.bin")
        self.assertEqual(snapshot.parent.name, file_id)
        # DM listings stay clean; the group query returns the single row.
        self.assertEqual(await self.db.get_file_transfers(self.member_a.peer_id), [])
        listed = await self.sender_transfer.list_transfers(group_id=self.group_id)
        self.assertEqual(len(listed), 1)
        self.assertEqual(len(listed[0]["deliveries"]), 2)
        # Only the online member got packets (offer + chunks).
        self.assertEqual(len(self.manager.sent), 1 + rows[0]["total_chunks"])
        self.assertEqual(self.manager.sent[0].type, PacketType.FILE_OFFER)
        self.assertTrue(all(p.type == PacketType.FILE_CHUNK for p in self.manager.sent[1:]))

    async def test_group_ack_fan_in_completes_row(self):
        file_id = await self.sender_transfer.send_group_file(self.group_id, str(self.source))
        await self.sender_transfer.handle_packet(
            FakePeer(self.member_a), self._ack(self.member_a, file_id, "completed"))
        await asyncio.sleep(0)

        deliveries = {d["recipient_id"]: d["status"] for d in await self.db.get_file_deliveries(file_id)}
        self.assertEqual(deliveries[self.member_a.peer_id], "completed")
        # Sibling still queued: the shared row must not flip to completed yet.
        self.assertNotEqual((await self.db.get_file_transfer(file_id))["status"], "completed")
        delivered = [e for e in self.events if e.get("event") == "file_delivered"]
        self.assertEqual(len(delivered), 1)

        await self.sender_transfer.handle_packet(
            FakePeer(self.member_b), self._ack(self.member_b, file_id, "completed"))
        await asyncio.sleep(0)
        self.assertEqual((await self.db.get_file_transfer(file_id))["status"], "completed")

        # Duplicate ACKs stay silent.
        await self.sender_transfer.handle_packet(
            FakePeer(self.member_a), self._ack(self.member_a, file_id, "completed"))
        await asyncio.sleep(0)
        delivered = [e for e in self.events if e.get("event") == "file_delivered"]
        self.assertEqual(len(delivered), 2)

    async def test_group_blocked_ack_marks_only_that_delivery(self):
        file_id = await self.sender_transfer.send_group_file(self.group_id, str(self.source))
        await self.sender_transfer.handle_packet(
            FakePeer(self.member_a), self._ack(self.member_a, file_id, "blocked"))
        await asyncio.sleep(0)

        deliveries = {d["recipient_id"]: d["status"] for d in await self.db.get_file_deliveries(file_id)}
        self.assertEqual(deliveries[self.member_a.peer_id], "blocked")
        self.assertEqual(deliveries[self.member_b.peer_id], "queued")
        blocked = [e for e in self.events if e.get("event") == "file_blocked"]
        self.assertEqual(len(blocked), 1)
        self.assertEqual(blocked[0]["recipient_id"], self.member_a.peer_id)

    async def test_flush_delivers_queued_group_delivery(self):
        file_id = await self.sender_transfer.send_group_file(self.group_id, str(self.source))
        # Member B comes online; the queued delivery must flush from the snapshot.
        self.manager._peers[self.member_b.peer_id] = FakePeer(self.member_b)
        flushed = await self.sender_transfer.flush_for_peer(self.member_b.peer_id)

        self.assertEqual(flushed, 1)
        deliveries = {d["recipient_id"]: d["status"] for d in await self.db.get_file_deliveries(file_id)}
        self.assertEqual(deliveries[self.member_b.peer_id], "sent")

    async def test_retry_repairs_failed_group_delivery(self):
        file_id = await self.sender_transfer.send_group_file(self.group_id, str(self.source))
        await self.db.set_file_delivery(file_id, self.member_a.peer_id, "failed")

        retried = await self.sender_transfer.retry_file(file_id, self.member_a.peer_id)

        self.assertEqual(retried, file_id)
        deliveries = {d["recipient_id"]: d["status"] for d in await self.db.get_file_deliveries(file_id)}
        self.assertEqual(deliveries[self.member_a.peer_id], "sent")

    async def test_delete_clears_whole_group_send(self):
        file_id = await self.sender_transfer.send_group_file(self.group_id, str(self.source))
        transfer = await self.db.get_file_transfer(file_id)
        snapshot = transfer["file_path"]
        self.assertTrue(Path(snapshot).exists())

        deleted = await self.db.delete_file_transfer_locally(file_id)

        self.assertIsNotNone(deleted)
        self.assertIsNone(await self.db.get_file_transfer(file_id))
        self.assertEqual(await self.db.get_file_deliveries(file_id), [])
        self.assertEqual(await self.db.count_file_path_references(snapshot), 0)
        self.assertEqual(await self.db.get_file_transfers(group_id=self.group_id), [])


class DatabaseCloseTest(unittest.IsolatedAsyncioTestCase):
    async def test_close_releases_connection_after_commit_failure(self):
        db = Database(Path("unused.db"))
        connection = type("Connection", (), {})()
        connection.commit = AsyncMock(side_effect=OSError("commit failed"))
        connection.close = AsyncMock()
        db._db = connection

        with self.assertRaisesRegex(OSError, "commit failed"):
            await db.close()

        connection.close.assert_awaited_once()
        self.assertIsNone(db._db)
