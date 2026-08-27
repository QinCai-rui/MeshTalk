import asyncio
import tempfile
import unittest
from pathlib import Path

from meshtalk.database import Database
from meshtalk.encryption import encrypt_for_recipient
from meshtalk.file_transfer import FileTransferManager
from meshtalk.identity import Identity
from meshtalk.protocol import (
    CAP_FILE_TRANSFER,
    FileAckPayload,
    FileChunkPayload,
    FileOfferPayload,
    Packet,
    PacketType,
)
from meshtalk.settings import Settings


class FakePeer:
    def __init__(self, identity: Identity):
        self.peer_id = identity.peer_id
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
        self.assertEqual(Path(transfer["file_path"]).read_bytes(), self.content)
        await self.receiver.handle_packet(self.sender_peer, self._chunk(1))
        self.assertEqual((await self.db.get_file_transfer(self.file_id))["status"], "completed")

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
