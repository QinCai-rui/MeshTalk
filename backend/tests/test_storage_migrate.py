import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from meshtalk.database import Database
from meshtalk.settings import Settings
from meshtalk.storage import migrate_files_location, switch_storage_location


def _run(coro):
    return asyncio.run(coro)


class StorageMigrationTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tempdir.name) / "data"
        self.data_dir.mkdir()
        self.settings = Settings(self.data_dir / "settings.json")
        self.storage = self.data_dir  # default storage == DATA_DIR
        self.db = Database(self.storage / "meshtalk.db", os.urandom(32))
        _run(self.db.connect())
        (self.storage / "identity.json").write_text('{"peer": "old"}')
        files_base = self.storage / "files"
        (files_base / "peer" / "photo.bin").parent.mkdir(parents=True, exist_ok=True)
        (files_base / "peer" / "photo.bin").write_bytes(b"p" * 64)
        self.file_manager = SimpleNamespace(data_dir=self.storage)
        self.addCleanup(self.tempdir.cleanup)

    def tearDown(self):
        _run(self.db.close())

    async def _seed_message(self):
        await self.db._db.execute(
            "INSERT INTO messages (message_id, sender_id, recipient_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
            ("m1", "a", "b", b"enc", 1.0),
        )
        await self.db._db.commit()

    def test_switch_with_migrate_moves_db_identity_and_files(self):
        _run(self._seed_message())
        target = Path(self.tempdir.name) / "new-storage"
        summary = _run(
            switch_storage_location(
                db=self.db, settings=self.settings, file_manager=self.file_manager,
                target=target, migrate=True,
            )
        )
        self.assertTrue(summary["migrated"])
        self.assertTrue(summary["files_migrated"])
        self.assertIsNone(summary["cleanup_warning"])
        # Live backend now serves the new location.
        self.assertEqual(self.db.db_path, target / "meshtalk.db")
        self.assertEqual(self.file_manager.data_dir, target)
        self.assertEqual(self.settings.storage_dir, target.resolve())
        # Data survived the move.
        peer = _run(self.db.get_peer("nobody"))
        self.assertIsNone(peer)
        async def _count():
            async with self.db._db.execute("SELECT COUNT(*) FROM messages") as cursor:
                return (await cursor.fetchone())[0]
        self.assertEqual(_run(_count()), 1)
        self.assertEqual((target / "files" / "peer" / "photo.bin").read_bytes(), b"p" * 64)
        self.assertTrue((target / "identity.json").exists())
        # Old payload deleted, anchor files kept.
        self.assertFalse((self.storage / "meshtalk.db").exists())
        self.assertFalse((self.storage / "identity.json").exists())
        self.assertFalse(list((self.storage / "files").rglob("*")))
        self.assertTrue((self.storage / "settings.json").exists())

    def test_switch_without_migrate_leaves_old_data_intact(self):
        _run(self._seed_message())
        target = Path(self.tempdir.name) / "fresh-storage"
        summary = _run(
            switch_storage_location(
                db=self.db, settings=self.settings, file_manager=self.file_manager,
                target=target, migrate=False,
            )
        )
        self.assertFalse(summary["migrated"])
        self.assertIn("note", summary)
        self.assertEqual(self.db.db_path, target / "meshtalk.db")
        # New database is empty; old database untouched.
        async def _count():
            async with self.db._db.execute("SELECT COUNT(*) FROM messages") as cursor:
                return (await cursor.fetchone())[0]
        self.assertEqual(_run(_count()), 0)
        self.assertTrue((self.storage / "meshtalk.db").exists())
        self.assertTrue((self.storage / "identity.json").exists())
        # Identity carried over so the peer ID survives a restart.
        self.assertEqual((target / "identity.json").read_text(), '{"peer": "old"}')

    def test_switch_aborts_when_copy_fails(self):
        _run(self._seed_message())
        target = Path(self.tempdir.name) / "new-storage"
        with patch("meshtalk.storage.copy_tree_merge", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(RuntimeError, "Location unchanged"):
                _run(
                    switch_storage_location(
                        db=self.db, settings=self.settings, file_manager=self.file_manager,
                        target=target, migrate=True,
                    )
                )
        # Old location still active with data intact.
        self.assertEqual(self.db.db_path, self.storage / "meshtalk.db")
        self.assertEqual(self.settings.storage_dir, self.storage)
        async def _count():
            async with self.db._db.execute("SELECT COUNT(*) FROM messages") as cursor:
                return (await cursor.fetchone())[0]
        self.assertEqual(_run(_count()), 1)
        self.assertEqual((self.storage / "files" / "peer" / "photo.bin").read_bytes(), b"p" * 64)

    def test_switch_refuses_occupied_target(self):
        target = Path(self.tempdir.name) / "occupied"
        target.mkdir()
        (target / "meshtalk.db").write_bytes(b"someone-else")
        with self.assertRaisesRegex(RuntimeError, "already contains"):
            _run(
                switch_storage_location(
                    db=self.db, settings=self.settings, file_manager=self.file_manager,
                    target=target, migrate=True,
                )
            )
        self.assertEqual(self.db.db_path, self.storage / "meshtalk.db")

    def test_switch_refuses_active_transfers(self):
        async def _seed_active():
            await self.db._db.execute(
                "INSERT INTO file_transfers (file_id, filename, file_size, chunk_size, total_chunks, sender_id, recipient_id, direction, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("f1", "a.bin", 10, 10, 1, "a", "b", "outbound", "transferring", 1.0),
            )
            await self.db._db.commit()
        _run(_seed_active())
        target = Path(self.tempdir.name) / "new-storage"
        with self.assertRaisesRegex(RuntimeError, "in progress"):
            _run(
                switch_storage_location(
                    db=self.db, settings=self.settings, file_manager=self.file_manager,
                    target=target, migrate=True,
                )
            )
        self.assertEqual(self.db.db_path, self.storage / "meshtalk.db")

    def test_switch_to_same_location_is_noop(self):
        summary = _run(
            switch_storage_location(
                db=self.db, settings=self.settings, file_manager=self.file_manager,
                target=self.storage, migrate=True,
            )
        )
        self.assertTrue(summary["noop"])
        self.assertFalse(summary["migrated"])
        self.assertEqual(self.db.db_path, self.storage / "meshtalk.db")

    def test_files_migrate_moves_and_cleans_old(self):
        old_base = self.settings.files_dir
        target = Path(self.tempdir.name) / "new-files"
        result = _run(migrate_files_location(db=self.db, settings=self.settings, target=target))
        self.assertTrue(result["migrated"])
        self.assertIsNone(result["cleanup_warning"])
        self.assertEqual(self.settings.files_dir, target.resolve())
        self.assertEqual((target / "peer" / "photo.bin").read_bytes(), b"p" * 64)
        self.assertFalse(list(old_base.rglob("*")))

    def test_files_migrate_aborts_on_verification_failure(self):
        target = Path(self.tempdir.name) / "new-files"
        real_verify = __import__("meshtalk.storage", fromlist=["verify_tree_copy"]).verify_tree_copy

        def corrupt(_src, _dst, copied):
            # Simulate a truncated copy the verifier must catch.
            (target / copied[0]).write_bytes(b"short")
            return real_verify(_src, _dst, copied)

        with patch("meshtalk.storage.verify_tree_copy", side_effect=corrupt):
            with self.assertRaisesRegex(RuntimeError, "Verification"):
                _run(migrate_files_location(db=self.db, settings=self.settings, target=target))
        self.assertEqual(self.settings.files_dir, self.storage / "files")
        self.assertEqual((self.storage / "files" / "peer" / "photo.bin").read_bytes(), b"p" * 64)

    def test_files_migrate_respects_files_env_override(self):
        target = Path(self.tempdir.name) / "new-files"
        with patch.dict(os.environ, {"MESHTALK_FILES_DIR": str(self.storage / "files")}):
            with self.assertRaisesRegex(RuntimeError, "MESHTALK_FILES_DIR"):
                _run(migrate_files_location(db=self.db, settings=self.settings, target=target))


if __name__ == "__main__":
    unittest.main()
