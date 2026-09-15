import ast
import asyncio
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

from meshtalk.database import Database
from meshtalk.file_transfer import FileTransferManager
from meshtalk.identity import Identity
from meshtalk.protocol import (
    CAP_BLOCK_REPORTS,
    CAP_FILE_TRANSFER,
    CAP_FILE_TRANSFER_V2,
    FileAckV2Payload,
    FileOfferV2Payload,
    Packet,
    PacketType,
)
from meshtalk.settings import Settings


class FakePeer:
    def __init__(self, identity: Identity, capabilities: tuple[str, ...] | None = None):
        self.peer_id = identity.peer_id
        self.display_name = identity.display_name
        self.signing_public_key = identity.signing_public_key_bytes()
        self.encryption_public_key = identity.encryption_public_key_bytes()
        self.capabilities = capabilities or (CAP_FILE_TRANSFER, CAP_FILE_TRANSFER_V2, CAP_BLOCK_REPORTS)

    def supports(self, capability: str) -> bool:
        return capability in self.capabilities


class FakePeerManager:
    def __init__(self, peer: FakePeer | None = None):
        self.peer = peer
        self.sent: list[Packet] = []

    def get_connected_peer(self, peer_id: str) -> FakePeer | None:
        return self.peer if self.peer and self.peer.peer_id == peer_id else None

    async def send_packet(self, peer: FakePeer, packet: Packet) -> None:
        self.sent.append(packet)


class FileTransferV2IntegrationTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.sender = Identity.generate("Sender")
        self.recipient = Identity.generate("Recipient")
        self.sender_peer = FakePeer(self.sender)
        self.recipient_peer = FakePeer(self.recipient)
        self.sender_db = Database(self.root / "sender.db")
        self.recipient_db = Database(self.root / "recipient.db")
        await self.sender_db.connect()
        await self.recipient_db.connect()
        self.sender_settings = Settings(self.root / "sender-settings.json")
        self.recipient_settings = Settings(self.root / "recipient-settings.json")
        await self.sender_db.add_friend(self.recipient.peer_id, "Recipient")
        await self.recipient_db.add_friend(self.sender.peer_id, "Sender")
        self.sender_manager = FakePeerManager(self.recipient_peer)
        self.recipient_manager = FakePeerManager(self.sender_peer)
        self.sender_transfer = FileTransferManager(
            self.sender, self.sender_manager, self.sender_db, self.root / "sender-files",
            settings=self.sender_settings,
        )
        self.recipient_transfer = FileTransferManager(
            self.recipient, self.recipient_manager, self.recipient_db, self.root / "recipient-files",
            settings=self.recipient_settings,
        )

    async def asyncTearDown(self):
        await self.sender_db.close()
        await self.recipient_db.close()
        self.tempdir.cleanup()

    async def _pump(self, source: FakePeerManager, target: FileTransferManager, peer: FakePeer):
        packets = list(source.sent)
        source.sent.clear()
        for packet in packets:
            await target.handle_packet(peer, packet)
        return packets

    async def test_dm_send_completes_with_hash_and_caption(self):
        source = self.root / "hello.txt"
        source.write_bytes(b"hello meshtalk v2")
        file_id = await self.sender_transfer.send_file(
            self.recipient.peer_id, str(source), caption="Here is an image of it in action:"
        )
        sender_row = await self.sender_db.get_file_transfer(file_id)
        self.assertEqual(len(sender_row["file_sha256"]), 64)
        self.assertEqual(sender_row["caption"], "Here is an image of it in action:")
        await self._pump(self.sender_manager, self.recipient_transfer, self.sender_peer)
        inbound = await self.recipient_db.get_file_transfer(file_id)
        self.assertEqual(inbound["status"], "completed")
        self.assertEqual(Path(inbound["file_path"]).read_bytes(), b"hello meshtalk v2")
        self.assertEqual(inbound["caption"], "Here is an image of it in action:")
        await self._pump(self.recipient_manager, self.sender_transfer, self.recipient_peer)
        updated = await self.sender_db.get_file_transfer(file_id)
        self.assertEqual(updated["status"], "completed")
        self.assertEqual(await self.sender_db.get_pending_outgoing(self.recipient.peer_id), [])

    async def test_completed_ack_clears_outqueue(self):
        source = self.root / "queued.txt"
        source.write_bytes(b"queued-data")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        await self.sender_db.add_to_outqueue(
            self.recipient.peer_id, PacketType.FILE_CHUNK_V2.value, b"stale", file_id
        )
        await self._pump(self.sender_manager, self.recipient_transfer, self.sender_peer)
        await self._pump(self.recipient_manager, self.sender_transfer, self.recipient_peer)
        self.assertEqual(await self.sender_db.get_pending_outgoing(self.recipient.peer_id), [])
        self.assertEqual((await self.sender_db.get_file_transfer(file_id))["status"], "completed")

    async def test_retry_blocked_peer_marks_blocked_without_sending(self):
        source = self.root / "blocked.txt"
        source.write_bytes(b"blocked-data")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        await self.sender_db.update_file_transfer(file_id, status="failed")
        await self.sender_db.block_peer(self.recipient.peer_id, "Recipient")
        self.sender_manager.sent.clear()
        with self.assertRaisesRegex(ValueError, "blocked"):
            await self.sender_transfer.retry_file(file_id)
        self.assertEqual((await self.sender_db.get_file_transfer(file_id))["status"], "blocked")
        self.assertEqual(self.sender_manager.sent, [])

    async def test_sent_transfer_retries_after_restart_timeout(self):
        source = self.root / "restart.txt"
        source.write_bytes(b"restart-data")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        row = await self.sender_db.get_file_transfer(file_id)
        self.assertIsNotNone(row["awaiting_ack_at"])
        restarted = FileTransferManager(
            self.sender, self.sender_manager, self.sender_db, self.root / "sender-files",
            settings=self.sender_settings,
        )
        with self.assertRaisesRegex(ValueError, "awaiting acknowledgement"):
            await restarted.retry_file(file_id)
        await self.sender_db.update_file_transfer(file_id, awaiting_ack_at=0)
        self.sender_manager.sent.clear()
        await restarted.retry_file(file_id)
        self.assertTrue(self.sender_manager.sent)

    async def test_group_failed_delivery_beats_queued_aggregate(self):
        group_id = self.sender_settings.create_room("Group").id
        await self.sender_db.upsert_group_member(group_id, self.sender.peer_id, "Sender")
        await self.sender_db.upsert_group_member(group_id, self.recipient.peer_id, "Recipient")
        source = self.root / "aggregate.txt"
        source.write_bytes(b"aggregate-data")
        file_id = await self.sender_transfer.send_group_file(group_id, str(source))
        await self.sender_db.set_file_delivery(file_id, self.recipient.peer_id, "queued")
        second = Identity.generate("Second")
        await self.sender_db.set_file_delivery(file_id, second.peer_id, "failed")
        await self.sender_transfer._recompute_aggregate(file_id)
        self.assertEqual((await self.sender_db.get_file_transfer(file_id))["status"], "failed")

    async def test_empty_group_send_fails_without_snapshot(self):
        group_id = self.sender_settings.create_room("Solo").id
        await self.sender_db.upsert_group_member(group_id, self.sender.peer_id, "Sender")
        source = self.root / "solo.txt"
        source.write_bytes(b"solo-data")
        with self.assertRaisesRegex(ValueError, "No other members"):
            await self.sender_transfer.send_group_file(group_id, str(source))
        sent_dir = self.root / "sender-files" / "sent"
        self.assertFalse(sent_dir.exists() and any(sent_dir.iterdir()))

    async def test_resume_skips_blocked_peer(self):
        source = self.root / "resume.txt"
        source.write_bytes(b"resume-data")
        await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        packets = list(self.sender_manager.sent)
        self.sender_manager.sent.clear()
        await self.recipient_transfer.handle_packet(self.sender_peer, packets[0])
        await self.recipient_db.block_peer(self.sender.peer_id, "Sender")
        await self.recipient_transfer.resume_for_peer(self.sender.peer_id)
        self.assertEqual(self.recipient_manager.sent, [])

    async def test_early_chunk_from_blocked_peer_dropped(self):
        source = self.root / "early.txt"
        source.write_bytes(b"early-data")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        packets = list(self.sender_manager.sent)
        self.sender_manager.sent.clear()
        await self.recipient_transfer.handle_packet(self.sender_peer, packets[1])
        await self.recipient_db.block_peer(self.sender.peer_id, "Sender")
        await self.recipient_transfer.handle_packet(self.sender_peer, packets[0])
        self.assertIsNone(await self.recipient_db.get_file_transfer(file_id))
        blocked = [p for p in self.recipient_manager.sent if p.type == PacketType.FILE_ACK_V2]
        self.assertEqual(len(blocked), 1)
        self.assertEqual(FileAckV2Payload.decode(blocked[0].payload).status, "blocked")

    async def test_flush_completed_transfer_cleans_queue_without_regression(self):
        source = self.root / "done.txt"
        source.write_bytes(b"done-data")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        await self._pump(self.sender_manager, self.recipient_transfer, self.sender_peer)
        await self._pump(self.recipient_manager, self.sender_transfer, self.recipient_peer)
        self.assertEqual((await self.sender_db.get_file_transfer(file_id))["status"], "completed")
        await self.sender_db.add_to_outqueue(
            self.recipient.peer_id, PacketType.FILE_CHUNK_V2.value, b"stale", file_id
        )
        flushed = await self.sender_transfer.flush_for_peer(self.recipient.peer_id)
        self.assertEqual(flushed, 0)
        self.assertEqual((await self.sender_db.get_file_transfer(file_id))["status"], "completed")
        self.assertEqual(await self.sender_db.get_pending_outgoing(self.recipient.peer_id), [])

    async def test_flush_purges_file_after_unfriend(self):
        source = self.root / "unfriended.txt"
        source.write_bytes(b"private")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        await self.sender_db.add_to_outqueue(
            self.recipient.peer_id, PacketType.FILE_CHUNK_V2.value, b"stale", file_id
        )
        await self.sender_db.remove_friend(self.recipient.peer_id)
        self.sender_manager.sent.clear()
        self.assertEqual(await self.sender_transfer.flush_for_peer(self.recipient.peer_id), 0)
        self.assertEqual(await self.sender_db.get_pending_outgoing(self.recipient.peer_id), [])
        self.assertEqual((await self.sender_db.get_file_transfer(file_id))["status"], "unavailable")
        self.assertEqual(self.sender_manager.sent, [])

    async def test_group_retry_requires_active_local_membership(self):
        group_id = self.sender_settings.create_room("Left group").id
        await self.sender_db.upsert_group_member(group_id, self.sender.peer_id, "Sender")
        await self.sender_db.upsert_group_member(group_id, self.recipient.peer_id, "Recipient")
        source = self.root / "left.txt"
        source.write_bytes(b"left")
        file_id = await self.sender_transfer.send_group_file(group_id, str(source))
        await self.sender_db.set_file_delivery(file_id, self.recipient.peer_id, "failed")
        await self.sender_db.upsert_group_member(group_id, self.sender.peer_id, "Sender", active=False)
        self.sender_manager.sent.clear()
        with self.assertRaisesRegex(ValueError, "Not an active member"):
            await self.sender_transfer.retry_file(file_id)
        self.assertEqual(self.sender_manager.sent, [])

    async def test_flush_purges_legacy_file_queue(self):
        await self.sender_db.save_file_transfer({
            "file_id": "legacy-file", "filename": "legacy.bin", "file_size": 1,
            "chunk_size": 1, "total_chunks": 1, "sender_id": self.sender.peer_id,
            "recipient_id": self.recipient.peer_id, "group_id": None,
            "direction": "outbound", "status": "queued", "file_path": None,
            "created_at": 1.0,
        })
        await self.sender_db.add_to_outqueue(
            self.recipient.peer_id, PacketType.FILE_CHUNK.value, b"legacy", "legacy-file"
        )
        self.assertEqual(await self.sender_transfer.flush_for_peer(self.recipient.peer_id), 0)
        self.assertEqual(await self.sender_db.get_pending_outgoing(self.recipient.peer_id), [])
        self.assertEqual((await self.sender_db.get_file_transfer("legacy-file"))["status"], "failed")

    async def test_deliver_rechecks_dm_authorization(self):
        source = self.root / "authorization.txt"
        source.write_bytes(b"private")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        transfer = await self.sender_db.get_file_transfer(file_id)
        await self.sender_db.remove_friend(self.recipient.peer_id)
        self.sender_manager.sent.clear()
        await self.sender_transfer._deliver_v2(transfer, self.recipient.peer_id)
        self.assertEqual(self.sender_manager.sent, [])
        self.assertEqual((await self.sender_db.get_file_transfer(file_id))["status"], "unavailable")

    async def test_flush_lock_remains_cached(self):
        lock = self.sender_transfer._flush_lock("file", self.recipient.peer_id)
        self.sender_transfer._release_flush_lock("file", self.recipient.peer_id, lock)
        self.assertIs(self.sender_transfer._flush_lock("file", self.recipient.peer_id), lock)

    async def test_send_rejects_without_v2_before_snapshot(self):
        self.sender_manager.peer = FakePeer(self.recipient, (CAP_FILE_TRANSFER, CAP_BLOCK_REPORTS))
        source = self.root / "nov2.txt"
        source.write_bytes(b"no v2 support")
        with patch.object(self.sender_transfer, "_snapshot_with_hash") as snapshot:
            with self.assertRaisesRegex(ValueError, "does not support file_transfer_v2"):
                await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
            snapshot.assert_not_called()
        self.assertEqual(await self.sender_db.get_file_transfers(self.recipient.peer_id), [])
        self.assertEqual(await self.sender_db.get_pending_outgoing(self.recipient.peer_id), [])
        self.assertEqual(self.sender_manager.sent, [])

    async def test_ipc_unsupported_send_batch_and_retry_report_errors(self):
        # Execute the actual nested IPC handlers without starting network services.
        tree = ast.parse((Path(__file__).parents[1] / "meshtalk" / "__main__.py").read_text())
        handlers = [node for node in ast.walk(tree)
                    if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef))
                    and node.name in ("handle_file_send", "handle_file_retry", "_file_error", "_batch_error")]
        namespace = {"db": self.sender_db, "file_manager": self.sender_transfer}
        exec(compile(ast.Module(body=handlers, type_ignores=[]), "__main__.py", "exec"), namespace)
        source = self.root / "ipc.txt"
        source.write_bytes(b"ipc data")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        await self.sender_db.update_file_transfer(file_id, status="failed")
        self.sender_manager.sent.clear()
        self.recipient_peer.capabilities = (CAP_FILE_TRANSFER,)
        with patch.object(self.sender_transfer, "_snapshot_with_hash") as snapshot:
            for payload in ({"file_path": str(source)}, {"paths": [str(source)]}):
                response = await namespace["handle_file_send"]({"recipient_id": self.recipient.peer_id, **payload})
                self.assertIn("does not support file_transfer_v2", response["error"])
                self.assertNotIn("file_id", response)
            paths = [str(source), str(self.root / "second.txt")]
            response = await namespace["handle_file_send"]({"recipient_id": self.recipient.peer_id, "paths": paths})
            self.assertIn("file_transfer_v2", response["error"])
            self.assertNotIn("file_id", response)
            self.assertNotIn("results", response)
            snapshot.assert_not_called()
        response = await namespace["handle_file_retry"]({"file_id": file_id})
        self.assertIn("does not support file_transfer_v2", response["error"])
        self.assertNotIn("file_id", response)
        self.assertEqual((await self.sender_db.get_file_transfer(file_id))["status"], "unavailable")
        self.assertEqual(len(await self.sender_db.get_file_transfers(self.recipient.peer_id)), 1)
        self.assertEqual(self.sender_manager.sent, [])
        self.assertEqual(await self.sender_db.get_pending_outgoing(self.recipient.peer_id), [])

    async def test_group_send_rejects_all_legacy_group_before_snapshot(self):
        group_id = self.sender_settings.create_room("Legacy only").id
        legacy = Identity.generate("Legacy")
        for identity in (self.sender, legacy):
            await self.sender_db.upsert_group_member(group_id, identity.peer_id, identity.display_name)
        source = self.root / "alllegacy.txt"
        source.write_bytes(b"all legacy")
        with patch.object(self.sender_transfer, "_snapshot_with_hash") as snapshot:
            with self.assertRaisesRegex(ValueError, "file_transfer_v2"):
                await self.sender_transfer.send_group_file(group_id, str(source))
            snapshot.assert_not_called()
        self.assertEqual(await self.sender_db.get_file_transfers(include_group=True), [])
        self.assertEqual(await self.sender_db.get_pending_outgoing(legacy.peer_id), [])

    async def test_group_send_and_retry_preserve_partial_delivery_to_legacy_member(self):
        group_id = self.sender_settings.create_room("Mixed").id
        legacy = Identity.generate("Legacy")
        for identity in (self.sender, self.recipient, legacy):
            await self.sender_db.upsert_group_member(group_id, identity.peer_id, identity.display_name)
        source = self.root / "mixed.txt"
        source.write_bytes(b"mixed group")
        result = await self.sender_transfer.send_batch(group_id, [str(source)], group_id=group_id)
        self.assertEqual(result["errors"], [])
        file_id = result["results"][0]["file_id"]
        self.assertEqual((await self.sender_db.get_file_delivery(file_id, legacy.peer_id))["status"], "unavailable")
        self.assertEqual((await self.sender_db.get_file_delivery(file_id, self.recipient.peer_id))["status"], "sent")
        await self.sender_db.set_file_delivery(file_id, self.recipient.peer_id, "failed")
        self.assertEqual(await self.sender_transfer.retry_file(file_id), file_id)
        self.assertEqual((await self.sender_db.get_file_delivery(file_id, legacy.peer_id))["status"], "unavailable")
        self.assertEqual((await self.sender_db.get_file_delivery(file_id, self.recipient.peer_id))["status"], "sent")

    async def test_flush_purges_undeliverable_acks_without_v2(self):
        await self.sender_db.add_to_outqueue(
            self.recipient.peer_id, PacketType.FILE_ACK_V2.value, b"ack-bytes", "ack-file"
        )
        self.sender_manager.peer = FakePeer(self.recipient, (CAP_FILE_TRANSFER, CAP_BLOCK_REPORTS))
        self.assertEqual(await self.sender_transfer.flush_for_peer(self.recipient.peer_id), 0)
        self.assertEqual(await self.sender_db.get_pending_outgoing(self.recipient.peer_id), [])
        self.assertEqual(self.sender_manager.sent, [])

    async def test_group_retry_explicit_legacy_recipient_raises(self):
        group_id = self.sender_settings.create_room("Mixed retry").id
        legacy = Identity.generate("Legacy")
        for identity in (self.sender, self.recipient, legacy):
            await self.sender_db.upsert_group_member(group_id, identity.peer_id, identity.display_name)
        source = self.root / "mixedretry.txt"
        source.write_bytes(b"mixed retry")
        file_id = await self.sender_transfer.send_group_file(group_id, str(source))
        await self.sender_db.set_file_delivery(file_id, legacy.peer_id, "failed")
        self.sender_manager.sent.clear()
        with self.assertRaisesRegex(ValueError, "file_transfer_v2"):
            await self.sender_transfer.retry_file(file_id, recipient_id=legacy.peer_id)
        self.assertEqual((await self.sender_db.get_file_delivery(file_id, legacy.peer_id))["status"], "unavailable")
        self.assertEqual(self.sender_manager.sent, [])

    async def test_group_retry_blocked_member_reports_blocked(self):
        group_id = self.sender_settings.create_room("Blocked retry").id
        blocked = Identity.generate("Blocked")
        for identity in (self.sender, self.recipient, blocked):
            await self.sender_db.upsert_group_member(group_id, identity.peer_id, identity.display_name)
        source = self.root / "blockedretry.txt"
        source.write_bytes(b"blocked retry")
        file_id = await self.sender_transfer.send_group_file(group_id, str(source))
        await self.sender_db.set_file_delivery(file_id, blocked.peer_id, "failed")
        await self.sender_db.block_peer(blocked.peer_id, "Blocked")
        self.sender_manager.sent.clear()
        with self.assertRaisesRegex(ValueError, "blocked"):
            await self.sender_transfer.retry_file(file_id, recipient_id=blocked.peer_id)
        self.assertEqual((await self.sender_db.get_file_delivery(file_id, blocked.peer_id))["status"], "unavailable")
        self.assertEqual(self.sender_manager.sent, [])

    async def test_flush_sends_no_bytes_without_v2(self):
        source = self.root / "nov2flush.txt"
        source.write_bytes(b"no v2 flush")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        self.sender_manager.sent.clear()
        self.sender_manager.peer = FakePeer(self.recipient, (CAP_FILE_TRANSFER, CAP_BLOCK_REPORTS))
        self.assertEqual(await self.sender_transfer.flush_for_peer(self.recipient.peer_id), 0)
        self.assertEqual(self.sender_manager.sent, [])

    async def test_offline_without_v2_queues_nothing(self):
        offline_manager = FakePeerManager(None)
        offline_transfer = FileTransferManager(
            self.sender, offline_manager, self.sender_db, self.root / "sender-files",
            settings=self.sender_settings,
        )
        await self.sender_db.upsert_peer(
            self.recipient.peer_id, "Recipient", self.recipient.encryption_public_key_bytes(),
            self.recipient.signing_public_key_bytes(), capabilities=[CAP_FILE_TRANSFER],
        )
        source = self.root / "nov2offline.txt"
        source.write_bytes(b"no v2 offline")
        with patch.object(offline_transfer, "_snapshot_with_hash") as snapshot:
            with self.assertRaisesRegex(ValueError, "does not support file_transfer_v2"):
                await offline_transfer.send_file(self.recipient.peer_id, str(source))
            snapshot.assert_not_called()
        self.assertEqual(await self.sender_db.get_file_transfers(self.recipient.peer_id), [])
        self.assertEqual(await self.sender_db.get_pending_outgoing(self.recipient.peer_id), [])

    async def test_inbound_v2_dropped_without_v2(self):
        source = self.root / "nov2inbound.txt"
        source.write_bytes(b"no v2 inbound")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        offer_packet = self.sender_manager.sent[0]
        v1_only_sender = FakePeer(self.sender, (CAP_FILE_TRANSFER, CAP_BLOCK_REPORTS))
        self.assertTrue(await self.recipient_transfer.handle_packet(v1_only_sender, offer_packet))
        self.assertIsNone(await self.recipient_db.get_file_transfer(file_id))

    async def test_runtime_packet_error_is_logged_and_dropped(self):
        with patch.object(self.sender_transfer, "_handle_offer", AsyncMock(side_effect=OSError("disk"))):
            self.assertTrue(await self.sender_transfer.handle_packet(
                self.recipient_peer, Packet(PacketType.FILE_OFFER_V2, b"payload")
            ))

    async def test_conflicting_offer_chunk_size_is_rejected(self):
        source = self.root / "boundaries.txt"
        source.write_bytes(b"twelve-bytes")
        await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        offer_packet = self.sender_manager.sent[0]
        await self.recipient_transfer.handle_packet(self.sender_peer, offer_packet)
        offer = FileOfferV2Payload.decode(offer_packet.payload)
        offer.chunk_size = offer.file_size + 1
        offer.signature = self.sender.signing_private_key.sign(offer.signed_bytes())
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            await self.recipient_transfer._handle_offer(
                self.sender_peer, Packet(PacketType.FILE_OFFER_V2, offer.encode()), True
            )

    async def test_rapid_group_sends_produce_distinct_ids(self):
        group_id = self.sender_settings.create_room("Group").id
        await self.sender_db.upsert_group_member(group_id, self.sender.peer_id, "Sender")
        await self.sender_db.upsert_group_member(group_id, self.recipient.peer_id, "Recipient")
        source = self.root / "group.txt"
        source.write_bytes(b"group-data")
        first = await self.sender_transfer.send_group_file(group_id, str(source))
        second = await self.sender_transfer.send_group_file(group_id, str(source))
        self.assertNotEqual(first, second)

    async def test_invalid_missing_range_does_not_propagate(self):
        source = self.root / "range.txt"
        source.write_bytes(b"range-data")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        row = await self.sender_db.get_file_transfer(file_id)
        ack = FileAckV2Payload(
            file_id, self.recipient.peer_id, "missing", b"s" * 64,
            [(0, row["total_chunks"] + 5)],
        )
        ack.signature = self.recipient.signing_private_key.sign(ack.signed_bytes())
        result = await self.sender_transfer.handle_packet(
            self.recipient_peer, Packet(PacketType.FILE_ACK_V2, ack.encode())
        )
        self.assertTrue(result)
        self.assertEqual(
            (await self.sender_db.get_file_transfer(file_id))["status"], "sent"
        )

    async def test_hash_mismatch_requests_full_missing_once(self):
        source = self.root / "corrupt.txt"
        source.write_bytes(b"A" * (28 * 1024 + 10))
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        packets = list(self.sender_manager.sent)
        self.sender_manager.sent.clear()
        offer = packets[0]
        chunks = packets[1:]
        await self.recipient_transfer.handle_packet(self.sender_peer, offer)
        for packet in chunks[:-1]:
            await self.recipient_transfer.handle_packet(self.sender_peer, packet)
        # Corrupt one already-written chunk before the final chunk completes the file.
        partial = await self.recipient_db.get_file_transfer(file_id)
        with open(partial["file_path"], "r+b") as output:
            output.seek(0)
            output.write(b"X")
        await self.recipient_transfer.handle_packet(self.sender_peer, chunks[-1])
        transfer = await self.recipient_db.get_file_transfer(file_id)
        self.assertEqual(transfer["status"], "transferring")
        missing = [
            p for p in self.recipient_manager.sent if p.type == PacketType.FILE_ACK_V2
        ]
        self.assertEqual(len(missing), 1)
        decoded = FileAckV2Payload.decode(missing[0].payload)
        self.assertEqual(decoded.status, "missing")
        self.assertEqual(decoded.missing_ranges, [(0, transfer["total_chunks"] - 1)])

    async def test_flush_v2_loss_purges_and_marks_unavailable(self):
        source = self.root / "v2loss.txt"
        source.write_bytes(b"v2-loss-data")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        await self.sender_db.add_to_outqueue(
            self.recipient.peer_id, PacketType.FILE_CHUNK_V2.value, b"stale", file_id
        )
        self.sender_manager.sent.clear()
        self.sender_manager.peer = FakePeer(self.recipient, (CAP_FILE_TRANSFER, CAP_BLOCK_REPORTS))
        self.assertEqual(await self.sender_transfer.flush_for_peer(self.recipient.peer_id), 0)
        self.assertEqual(self.sender_manager.sent, [])
        self.assertEqual(await self.sender_db.get_pending_outgoing(self.recipient.peer_id), [])
        self.assertEqual((await self.sender_db.get_file_transfer(file_id))["status"], "unavailable")

    async def test_resume_skips_unauthorized_peer(self):
        source = self.root / "resumeauth.txt"
        source.write_bytes(b"resume-auth-data")
        await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        packets = list(self.sender_manager.sent)
        self.sender_manager.sent.clear()
        await self.recipient_transfer.handle_packet(self.sender_peer, packets[0])
        await self.recipient_db.remove_friend(self.sender.peer_id)
        self.recipient_manager.sent.clear()
        await self.recipient_transfer.resume_for_peer(self.sender.peer_id)
        self.assertEqual(self.recipient_manager.sent, [])

    async def test_batch_all_fail_returns_top_level_error(self):
        tree = ast.parse((Path(__file__).parents[1] / "meshtalk" / "__main__.py").read_text())
        handlers = [node for node in ast.walk(tree)
                    if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef))
                    and node.name in ("handle_file_send", "handle_group_file_send", "_file_error", "_batch_error")]
        namespace = {"db": self.sender_db, "file_manager": self.sender_transfer}
        exec(compile(ast.Module(body=handlers, type_ignores=[]), "__main__.py", "exec"), namespace)
        missing = [str(self.root / "gone-a.txt"), str(self.root / "gone-b.txt")]
        response = await namespace["handle_file_send"]({"recipient_id": self.recipient.peer_id, "paths": missing})
        self.assertIn("error", response)
        self.assertNotIn("file_id", response)
        self.assertNotIn("results", response)

    async def test_unnamed_room_rejects_inbound(self):
        group_id = self.recipient_settings.create_room().id
        await self.recipient_db.upsert_group_member(group_id, self.sender.peer_id, "Sender")
        self.assertFalse(await self.recipient_transfer._authorized_inbound(self.sender_peer, group_id, v2=False))
        self.assertFalse(await self.recipient_transfer._authorized_inbound(self.sender_peer, group_id, v2=True))

    async def test_failed_send_hands_back_file_id(self):
        tree = ast.parse((Path(__file__).parents[1] / "meshtalk" / "__main__.py").read_text())
        handlers = [node for node in ast.walk(tree)
                    if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef))
                    and node.name in ("handle_file_send", "_file_error", "_batch_error")]
        namespace = {"db": self.sender_db, "file_manager": self.sender_transfer}
        exec(compile(ast.Module(body=handlers, type_ignores=[]), "__main__.py", "exec"), namespace)
        offline_manager = FakePeerManager(None)
        offline_transfer = FileTransferManager(
            self.sender, offline_manager, self.sender_db, self.root / "sender-files",
            settings=self.sender_settings,
        )
        await self.sender_db.upsert_peer(
            self.recipient.peer_id, "Recipient", self.recipient.encryption_public_key_bytes(),
            self.recipient.signing_public_key_bytes(),
            capabilities=[CAP_FILE_TRANSFER, CAP_FILE_TRANSFER_V2],
        )
        source = self.root / "handback.txt"
        source.write_bytes(b"handback-data")
        second = self.root / "handback-two.txt"
        second.write_bytes(b"handback-two")
        namespace["file_manager"] = offline_transfer

        async def fail_queue(self, transfer, recipient, key, ranges):
            await offline_transfer._set_delivery(transfer, recipient, "failed")
            return False

        with patch.object(FileTransferManager, "_queue_ranges", fail_queue):
            response = await namespace["handle_file_send"](
                {"recipient_id": self.recipient.peer_id, "file_path": str(source)})
            self.assertIn("error", response)
            self.assertIn("file_id", response)
            row = await self.sender_db.get_file_transfer(response["file_id"])
            self.assertIsNotNone(row)
            self.assertEqual(row["status"], "failed")
            multi = await namespace["handle_file_send"](
                {"recipient_id": self.recipient.peer_id, "paths": [str(source), str(second)]})
            self.assertIn("error", multi)
            self.assertNotIn("results", multi)
            self.assertEqual(len(multi.get("file_ids", [])), 2)
            for failed_id in multi["file_ids"]:
                failed_row = await self.sender_db.get_file_transfer(failed_id)
                self.assertIsNotNone(failed_row)
                self.assertEqual(failed_row["status"], "failed")

    async def test_group_bulk_retry_total_failure_raises(self):
        group_id = self.sender_settings.create_room("Bulk fail").id
        for identity in (self.sender, self.recipient):
            await self.sender_db.upsert_group_member(group_id, identity.peer_id, identity.display_name)
        source = self.root / "bulkfail.txt"
        source.write_bytes(b"bulk-fail-data")
        file_id = await self.sender_transfer.send_group_file(group_id, str(source))
        await self.sender_db.set_file_delivery(file_id, self.recipient.peer_id, "failed")
        manager = self.sender_transfer

        async def fail_stream(_self, peer, transfer, recipient, ranges):
            await manager._set_delivery(transfer, recipient, "failed")
            return False

        with patch.object(FileTransferManager, "_stream_ranges", fail_stream):
            with self.assertRaisesRegex(ValueError, "Failed to deliver"):
                await self.sender_transfer.retry_file(file_id)

    async def test_send_queue_failure_raises_without_silent_success(self):
        offline_manager = FakePeerManager(None)
        offline_transfer = FileTransferManager(
            self.sender, offline_manager, self.sender_db, self.root / "sender-files",
            settings=self.sender_settings,
        )
        await self.sender_db.upsert_peer(
            self.recipient.peer_id, "Recipient", self.recipient.encryption_public_key_bytes(),
            self.recipient.signing_public_key_bytes(),
            capabilities=[CAP_FILE_TRANSFER, CAP_FILE_TRANSFER_V2],
        )
        source = self.root / "queuefail.txt"
        source.write_bytes(b"queue-fail-data")

        async def fail_queue(self, transfer, recipient, key, ranges):
            await offline_transfer._set_delivery(transfer, recipient, "failed")
            return False

        with patch.object(FileTransferManager, "_queue_ranges", fail_queue):
            with self.assertRaisesRegex(ValueError, "Failed to deliver"):
                await offline_transfer.send_file(self.recipient.peer_id, str(source))
        rows = await self.sender_db.get_file_transfers(self.recipient.peer_id)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "failed")

    async def test_retry_stream_failure_raises_without_silent_success(self):
        source = self.root / "retryfail.txt"
        source.write_bytes(b"retry-fail-data")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        await self.sender_db.update_file_transfer(file_id, status="failed")
        self.sender_manager.sent.clear()

        manager = self.sender_transfer

        async def fail_stream(_peer_manager_self, peer, transfer, recipient, ranges):
            await manager._set_delivery(transfer, recipient, "failed")
            return False

        with patch.object(FileTransferManager, "_stream_ranges", fail_stream):
            with self.assertRaisesRegex(ValueError, "Failed to deliver"):
                await self.sender_transfer.retry_file(file_id)
        self.assertEqual((await self.sender_db.get_file_transfer(file_id))["status"], "failed")
        chunks = [p for p in self.sender_manager.sent if p.type == PacketType.FILE_CHUNK_V2]
        self.assertEqual(chunks, [])

    async def test_flush_blocked_peer_purges_file_queue(self):
        source = self.root / "flushblocked.txt"
        source.write_bytes(b"flush-blocked-data")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        await self.sender_db.add_to_outqueue(
            self.recipient.peer_id, PacketType.FILE_CHUNK_V2.value, b"stale", file_id
        )
        await self.sender_db.add_to_outqueue(
            self.recipient.peer_id, PacketType.FILE_ACK_V2.value, b"ack", file_id
        )
        await self.sender_db.block_peer(self.recipient.peer_id, "Recipient")
        self.assertEqual(await self.sender_transfer.flush_for_peer(self.recipient.peer_id), 0)
        self.assertEqual(await self.sender_db.get_pending_outgoing(self.recipient.peer_id), [])

    async def test_retry_blocked_peer_purges_file_queue(self):
        source = self.root / "retryblocked.txt"
        source.write_bytes(b"retry-blocked-data")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        await self.sender_db.update_file_transfer(file_id, status="failed")
        await self.sender_db.add_to_outqueue(
            self.recipient.peer_id, PacketType.FILE_CHUNK_V2.value, b"stale", file_id
        )
        await self.sender_db.block_peer(self.recipient.peer_id, "Recipient")
        with self.assertRaisesRegex(ValueError, "blocked"):
            await self.sender_transfer.retry_file(file_id)
        self.assertEqual(await self.sender_db.get_pending_outgoing(self.recipient.peer_id), [])

    async def test_second_integrity_failure_emits_file_failed(self):
        source = self.root / "integrity.txt"
        source.write_bytes(b"integrity-data")
        file_id = await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
        packets = list(self.sender_manager.sent)
        self.sender_manager.sent.clear()
        events = []

        async def capture(event):
            events.append(event)

        self.recipient_transfer.on_event = capture
        for packet in packets:
            await self.recipient_transfer.handle_packet(self.sender_peer, packet)
        await asyncio.sleep(0)
        self.assertEqual((await self.recipient_db.get_file_transfer(file_id))["status"], "completed")
        # Simulate a second corruption after the one-shot retry was consumed.
        self.recipient_transfer._integrity_retries.add(file_id)
        transfer = await self.recipient_db.get_file_transfer(file_id)
        with open(transfer["file_path"], "r+b") as output:
            output.seek(0)
            output.write(b"X")
        await self.recipient_transfer._complete_inbound_transfer(self.sender_peer, transfer, v2=True)
        await asyncio.sleep(0)
        self.assertEqual((await self.recipient_db.get_file_transfer(file_id))["status"], "failed")
        self.assertTrue(any(event.get("event") == "file_failed" for event in events))

    async def test_send_to_non_friend_reports_not_a_friend(self):
        await self.sender_db.remove_friend(self.recipient.peer_id)
        source = self.root / "nonfriend.txt"
        source.write_bytes(b"non-friend-data")
        with self.assertRaisesRegex(ValueError, "not a friend"):
            await self.sender_transfer.send_file(self.recipient.peer_id, str(source))
