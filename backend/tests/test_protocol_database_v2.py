import json
import tempfile
import unittest
from pathlib import Path

from meshtalk.database import Database
from meshtalk.protocol import (
    CAP_FILE_TRANSFER_V2,
    FileAckV2Payload,
    FileChunkV2Payload,
    FileOfferV2Payload,
    PacketType,
    capability_for_packet,
)


FILE_ID = "123456789abc4def8abc123456789abc"
BATCH_ID = "abcdefabcdef4def9abcabcdefabcdef"


class FileProtocolV2Tests(unittest.TestCase):
    def offer(self, **changes):
        values = {
            "file_id": FILE_ID, "filename": "report.txt", "file_size": 10,
            "chunk_size": 4, "total_chunks": 3, "file_sha256": "a" * 64,
            "caption": "notes", "sender_id": "sender", "recipient_id": "recipient",
            "created_at": 1.5, "signature": b"s" * 64,
        }
        values.update(changes)
        return FileOfferV2Payload(**values)

    def test_packet_mappings_and_round_trips(self):
        for packet_type in (PacketType.FILE_OFFER_V2, PacketType.FILE_CHUNK_V2, PacketType.FILE_ACK_V2):
            self.assertEqual(capability_for_packet(packet_type), CAP_FILE_TRANSFER_V2)
        offer = self.offer(batch_id=BATCH_ID, batch_index=0, batch_count=2)
        self.assertEqual(FileOfferV2Payload.decode(offer.encode()), offer)
        chunk = FileChunkV2Payload(FILE_ID, 0, 1, "sender", "recipient", b"x" * 60, b"s" * 64)
        self.assertEqual(FileChunkV2Payload.decode(chunk.encode()), chunk)
        ack = FileAckV2Payload(FILE_ID, "recipient", "missing", b"s" * 64, [(0, 2)])
        self.assertEqual(FileAckV2Payload.decode(ack.encode()), ack)

    def test_offer_strict_validation(self):
        invalid = [
            {"file_sha256": "A" * 64}, {"caption": "x" * 1025},
            {"total_chunks": 2}, {"batch_id": BATCH_ID},
            {"batch_id": BATCH_ID, "batch_index": 2, "batch_count": 2},
        ]
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, "Invalid file offer v2 payload"):
                self.offer(**changes).encode()
        raw = json.loads(self.offer().encode())
        raw["unexpected"] = True
        with self.assertRaisesRegex(ValueError, "Invalid file offer v2 payload"):
            FileOfferV2Payload.decode(json.dumps(raw).encode())

    def test_chunk_and_ack_strict_validation(self):
        with self.assertRaisesRegex(ValueError, "Invalid file chunk v2 payload"):
            FileChunkV2Payload(FILE_ID, 1, 1, "sender", "recipient", b"x" * 60, b"s" * 64).encode()
        for status, ranges in (("ack", None), ("missing", None), ("completed", [(0, 0)])):
            with self.subTest(status=status), self.assertRaisesRegex(ValueError, "Invalid file ack v2 payload"):
                FileAckV2Payload(FILE_ID, "recipient", status, b"s" * 64, ranges).encode()

    def test_ack_ranges_must_be_ordered_and_non_overlapping(self):
        for ranges in ([(0, 2), (1, 3)], [(2, 3), (0, 1)], [(0, 1), (1, 2)]):
            with self.subTest(ranges=ranges), self.assertRaisesRegex(ValueError, "Invalid file ack v2 payload"):
                FileAckV2Payload(FILE_ID, "recipient", "missing", b"s" * 64, ranges).encode()
        valid = FileAckV2Payload(FILE_ID, "recipient", "missing", b"s" * 64, [(0, 1), (3, 4)])
        self.assertEqual(FileAckV2Payload.decode(valid.encode()), valid)


class FileDatabaseV2Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.db = Database(self.root / "db.sqlite")
        await self.db.connect()

    async def asyncTearDown(self):
        await self.db.close()
        self.temporary.cleanup()

    async def save_transfer(self, file_id=FILE_ID, recipient_id="", file_path=None):
        await self.db.save_file_transfer({
            "file_id": file_id, "filename": "report.txt", "file_size": 10,
            "chunk_size": 4, "total_chunks": 3, "sender_id": "sender",
            "recipient_id": recipient_id, "group_id": "a" * 32,
            "direction": "outbound", "status": "pending", "file_path": file_path,
            "created_at": 1.0, "file_sha256": "b" * 64, "caption": "caption",
            "batch_id": BATCH_ID, "batch_index": 0, "batch_count": 1,
        })

    async def test_delivery_crud_and_recipient_scoped_listing(self):
        await self.save_transfer()
        await self.db.set_file_delivery(FILE_ID, "peer", "queued")
        self.assertEqual((await self.db.get_file_delivery(FILE_ID, "peer"))["status"], "queued")
        self.assertEqual(len(await self.db.get_file_deliveries(FILE_ID)), 1)
        self.assertEqual(len(await self.db.get_file_transfers("peer", include_group=True)), 1)
        self.assertEqual(await self.db.get_file_transfers("peer"), [])
        self.assertTrue(await self.db.delete_file_delivery(FILE_ID, "peer"))

    async def test_refcount_and_local_delete_cleanup(self):
        snapshot = self.root / "sent" / "shared.bin"
        snapshot.parent.mkdir()
        snapshot.write_bytes(b"data")
        await self.save_transfer(file_path=str(snapshot))
        other_id = "223456789abc4def8abc123456789abc"
        await self.save_transfer(other_id, file_path=str(snapshot))
        await self.db.set_file_delivery(FILE_ID, "peer", "queued")
        await self.db.record_file_chunk_received(FILE_ID, 0)
        await self.db.mark_message_seen(FILE_ID)
        await self.db.add_to_outqueue("peer", PacketType.FILE_OFFER_V2, b"payload", FILE_ID)
        self.assertEqual(await self.db.count_file_path_references(snapshot), 2)
        await self.db.delete_file_transfer_locally(FILE_ID, self.root)
        self.assertTrue(snapshot.exists())
        self.assertFalse(await self.db.is_message_seen(FILE_ID))
        self.assertEqual(await self.db.get_file_deliveries(FILE_ID), [])
        self.assertEqual(await self.db.get_pending_outgoing("peer"), [])
        await self.db.delete_file_transfer_locally(other_id, self.root)
        self.assertFalse(snapshot.exists())

    async def test_local_delete_does_not_unlink_outside_files_base(self):
        outside = self.root.parent / f"outside-{FILE_ID}.bin"
        outside.write_bytes(b"keep")
        try:
            await self.save_transfer(file_path=str(outside))
            await self.db.delete_file_transfer_locally(FILE_ID, self.root)
            self.assertTrue(outside.exists())
        finally:
            outside.unlink(missing_ok=True)

    async def test_local_delete_preserves_files_base(self):
        snapshot = self.root / "root-file.bin"
        snapshot.write_bytes(b"keep-root")
        await self.save_transfer(file_path=str(snapshot))
        await self.db.delete_file_transfer_locally(FILE_ID, self.root)
        self.assertTrue(self.root.is_dir())
