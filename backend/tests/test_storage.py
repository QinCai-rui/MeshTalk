import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from meshtalk import storage
from meshtalk.settings import Settings


def _make_tree(base: Path) -> None:
    (base / "files" / "peer" / "a.bin").parent.mkdir(parents=True, exist_ok=True)
    (base / "files" / "peer" / "a.bin").write_bytes(b"a" * 100)
    (base / "files" / "sent" / "x" / "b.bin").parent.mkdir(parents=True, exist_ok=True)
    (base / "files" / "sent" / "x" / "b.bin").write_bytes(b"b" * 50)
    (base / "meshtalk.db").write_bytes(b"db-bytes")
    (base / "identity.json").write_text('{"v": 1}')


def _make_sqlite(path: Path) -> None:
    connection = sqlite3.connect(str(path))
    try:
        connection.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        connection.execute("INSERT INTO t (v) VALUES ('hello')")
        connection.commit()
    finally:
        connection.close()


class ValidateTargetDirTest(unittest.TestCase):
    def test_rejects_empty(self):
        with self.assertRaisesRegex(ValueError, "non-empty"):
            storage.validate_target_dir("   ")

    def test_creates_and_proves_writable(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "new" / "nested"
            result = storage.validate_target_dir(str(target))
            self.assertTrue(result.is_dir())
            self.assertTrue(result.is_absolute())

    def test_resolves_relative_against_base(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            result = storage.validate_target_dir("rel", base=base)
            self.assertEqual(result, (base / "rel").resolve())


class CopyVerifyDeleteTest(unittest.TestCase):
    def test_copy_verify_delete_roundtrip(self):
        with tempfile.TemporaryDirectory() as temporary:
            src = Path(temporary) / "src"
            dst = Path(temporary) / "dst"
            _make_tree(src)
            copied = storage.copy_tree_merge(src / "files", dst / "files")
            self.assertTrue(copied)
            self.assertEqual(storage.verify_tree_copy(src / "files", dst / "files", copied), [])
            self.assertEqual(storage.delete_tree_contents(src / "files"), [])
            self.assertFalse(list((src / "files").rglob("*")))
            # Destination keeps the verified copies.
            self.assertEqual((dst / "files" / "peer" / "a.bin").read_bytes(), b"a" * 100)

    def test_verify_detects_size_mismatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            src = Path(temporary) / "src"
            dst = Path(temporary) / "dst"
            _make_tree(src)
            copied = storage.copy_tree_merge(src / "files", dst / "files")
            (dst / "files" / "peer" / "a.bin").write_bytes(b"truncated")
            problems = storage.verify_tree_copy(src / "files", dst / "files", copied)
            self.assertTrue(any("mismatch" in problem for problem in problems))

    def test_copy_failure_cleans_partial_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            src = Path(temporary) / "src"
            dst = Path(temporary) / "dst"
            _make_tree(src)
            real_copy2 = storage.shutil.copy2

            def fail_once(source, dest, *args, **kwargs):
                if Path(source).name == "b.bin":
                    raise OSError("disk full")
                return real_copy2(source, dest, *args, **kwargs)

            with patch.object(storage.shutil, "copy2", side_effect=fail_once):
                with self.assertRaises(OSError):
                    storage.copy_tree_merge(src / "files", dst / "files")
            remaining = [path for path in (dst / "files").rglob("*") if path.is_file()] if (dst / "files").exists() else []
            self.assertEqual(remaining, [])

    def test_missing_source_copies_nothing(self):
        with tempfile.TemporaryDirectory() as temporary:
            dst = Path(temporary) / "dst"
            self.assertEqual(storage.copy_tree_merge(Path(temporary) / "nope", dst), [])

    def test_runtime_files_are_ignored(self):
        with tempfile.TemporaryDirectory() as temporary:
            src = Path(temporary) / "src"
            dst = Path(temporary) / "dst"
            src.mkdir()
            (src / "meshtalk.sock").write_text("socket")
            (src / "keep.bin").write_bytes(b"k")
            copied = storage.copy_tree_merge(src, dst)
            self.assertEqual(copied, ["keep.bin"])
            self.assertFalse((dst / "meshtalk.sock").exists())
            self.assertEqual(storage.delete_tree_contents(src), [])
            self.assertTrue((src / "meshtalk.sock").exists())
            self.assertFalse((src / "keep.bin").exists())

    def test_dir_has_content_ignores_runtime_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary) / "base"
            base.mkdir()
            self.assertFalse(storage.dir_has_content(base))
            (base / "backend.log").write_text("log")
            self.assertFalse(storage.dir_has_content(base))
            (base / "meshtalk.db").write_bytes(b"x")
            self.assertTrue(storage.dir_has_content(base))

    def test_same_location(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            self.assertTrue(storage.same_location(base, base))
            self.assertFalse(storage.same_location(base, base / "other"))


class SqliteIntegrityTest(unittest.TestCase):
    def test_ok_for_valid_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            src = Path(temporary) / "a.db"
            dst = Path(temporary) / "b.db"
            _make_sqlite(src)
            storage.copy_file(src, dst)
            self.assertIsNone(storage.sqlite_integrity_ok(dst))

    def test_reports_corrupt_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            dst = Path(temporary) / "b.db"
            dst.write_bytes(b"not a database at all")
            self.assertIsNotNone(storage.sqlite_integrity_ok(dst))

    def test_reports_missing_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.assertIsNotNone(storage.sqlite_integrity_ok(Path(temporary) / "missing.db"))


class SettingsStorageDirTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.path = Path(self.tempdir.name) / "settings.json"

    def tearDown(self):
        self.tempdir.cleanup()

    def test_defaults_to_settings_parent(self):
        settings = Settings(self.path)
        self.assertEqual(settings.storage_dir, self.path.parent)
        # And the default files dir follows storage.
        self.assertEqual(settings.files_dir, self.path.parent / "files")

    def test_storage_dir_persists(self):
        settings = Settings(self.path)
        with tempfile.TemporaryDirectory() as other:
            settings.set_storage_dir(other)
            loaded = Settings(self.path)
            self.assertEqual(loaded.storage_dir, Path(other).resolve())
            self.assertEqual(loaded.files_dir, Path(other).resolve() / "files")
            self.assertEqual(loaded._storage_dir, str(Path(other).resolve()))

    def test_storage_dir_rejects_bad_path(self):
        settings = Settings(self.path)
        with self.assertRaisesRegex(ValueError, "non-empty"):
            settings.set_storage_dir("   ")

    def test_env_overrides_persisted_storage(self):
        settings = Settings(self.path)
        with tempfile.TemporaryDirectory() as other:
            settings.set_storage_dir(other)
            with patch.dict(os.environ, {"MESHTALK_STORAGE_DIR": self.tempdir.name}):
                self.assertEqual(settings.storage_dir, Path(self.tempdir.name))
            self.assertEqual(Settings(self.path).storage_dir, Path(other).resolve())

    def test_custom_files_dir_survives_storage_change(self):
        settings = Settings(self.path)
        with tempfile.TemporaryDirectory() as custom:
            settings.set_files_dir(custom)
            with tempfile.TemporaryDirectory() as other:
                settings.set_storage_dir(other)
                self.assertEqual(Settings(self.path).files_dir, Path(custom).resolve())


if __name__ == "__main__":
    unittest.main()
