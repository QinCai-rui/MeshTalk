import tempfile
import unittest
from pathlib import Path

from meshtalk.database import Database


class DesktopQueryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temporary.name) / "history.db")
        await self.db.connect()

    async def asyncTearDown(self):
        await self.db.close()
        self.temporary.cleanup()

    async def test_search_decrypts_in_memory_without_plaintext_index(self):
        await self.db.save_message({
            "message_id": "one", "sender_id": "me", "recipient_id": "alice",
            "content": "A private needle", "encrypted_content": b"", "created_at": 1,
            "hop_count": 0, "max_hops": 10,
        })
        result = await self.db.search_local_messages("me", "NEEDLE", peer_id="alice")
        self.assertEqual([row["message_id"] for row in result["results"]], ["one"])
        async with self.db._db.execute("SELECT content FROM messages WHERE message_id = 'one'") as cursor:
            encrypted = (await cursor.fetchone())[0]
        self.assertIsInstance(encrypted, bytes)
        self.assertNotIn(b"needle", encrypted.lower())

    async def test_drafts_are_encrypted_and_round_trip(self):
        await self.db.set_desktop_drafts({"peer:alice": "unsent private draft"})
        self.assertEqual(await self.db.get_desktop_drafts(), {"peer:alice": "unsent private draft"})
        async with self.db._db.execute("SELECT value FROM config WHERE key = 'desktop_drafts'") as cursor:
            stored = (await cursor.fetchone())[0]
        self.assertNotIn(b"private draft", stored)

    async def test_history_page_is_chronological_and_does_not_mark_read(self):
        for index in range(3):
            await self.db.save_message({
                "message_id": f"message-{index}", "sender_id": "alice", "recipient_id": "me",
                "content": f"Message {index}", "encrypted_content": b"", "created_at": index,
                "hop_count": 0, "max_hops": 10,
            })
        result = await self.db.desktop_history("me", "alice", None)
        self.assertEqual([row["message_id"] for row in result["messages"]], ["message-0", "message-1", "message-2"])
        async with self.db._db.execute("SELECT read_at FROM messages") as cursor:
            self.assertTrue(all(row[0] is None for row in await cursor.fetchall()))
