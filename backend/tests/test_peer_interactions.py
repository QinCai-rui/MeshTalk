import tempfile
import unittest
from pathlib import Path

from meshtalk.database import Database


class PeerInteractionTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.tempdir.name) / "interactions.db")
        await self.db.connect()

    async def asyncTearDown(self):
        await self.db.close()
        self.tempdir.cleanup()

    async def test_peer_interactions_use_direct_messages_and_completed_files(self):
        local = "local"
        await self.db.save_message({
            "message_id": "outbound", "sender_id": local, "recipient_id": "message-peer",
            "content": "sent", "encrypted_content": b"", "created_at": 10.0,
            "hop_count": 0, "max_hops": 0,
        })
        await self.db.save_message({
            "message_id": "inbound", "sender_id": "message-peer", "recipient_id": local,
            "content": "received", "encrypted_content": b"", "created_at": 1.0,
            "received_at": 20.0, "hop_count": 0, "max_hops": 0,
        })
        await self.db.save_file_transfer({
            "file_id": "completed-file", "filename": "complete.txt", "file_size": 1,
            "chunk_size": 1, "total_chunks": 1, "sender_id": "file-peer", "recipient_id": local,
            "direction": "inbound", "status": "completed", "created_at": 2.0, "completed_at": 30.0,
        })
        await self.db.save_file_transfer({
            "file_id": "pending-file", "filename": "pending.txt", "file_size": 1,
            "chunk_size": 1, "total_chunks": 1, "sender_id": "pending-peer", "recipient_id": local,
            "direction": "inbound", "status": "pending", "created_at": 40.0,
        })
        await self.db.save_file_transfer({
            "file_id": "group-file", "filename": "group.txt", "file_size": 1,
            "chunk_size": 1, "total_chunks": 1, "sender_id": "group-peer", "recipient_id": local,
            "group_id": "group", "direction": "inbound", "status": "completed", "created_at": 50.0,
        })

        self.assertEqual(await self.db.get_peer_interaction_times(local), {
            "message-peer": 20.0,
            "file-peer": 30.0,
        })
