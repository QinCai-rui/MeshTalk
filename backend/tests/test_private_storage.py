"""Private files are owner-only from creation, under a permissive umask."""

import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from meshtalk import storage
from meshtalk.identity import Identity
from meshtalk.settings import Settings


@unittest.skipIf(os.name == "nt", "POSIX permission bits")
class PrivateStorageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.previous_umask = os.umask(0o022)

    def tearDown(self):
        os.umask(self.previous_umask)
        self.temp.cleanup()

    def mode(self, path):
        return stat.S_IMODE(path.stat().st_mode)

    def test_bytes_are_private_while_being_written(self):
        modes = []
        real_fdopen = os.fdopen

        def watching(descriptor, *args, **kwargs):
            modes.append(stat.S_IMODE(os.fstat(descriptor).st_mode))
            return real_fdopen(descriptor, *args, **kwargs)

        with patch.object(storage.os, "fdopen", watching):
            storage.write_private_text(self.root / "secret.json", "dummy")
        self.assertTrue(modes)
        self.assertTrue(all(mode == 0o600 for mode in modes))
        self.assertEqual(self.mode(self.root / "secret.json"), 0o600)

    def test_identity_and_settings_are_private(self):
        Identity.generate("Dummy").save(self.root)
        self.assertEqual(self.mode(self.root / "identity.json"), 0o600)
        settings = Settings(self.root / "settings.json")
        settings.create_room("Group")
        self.assertEqual(self.mode(self.root / "settings.json"), 0o600)

    def test_migration_copy_is_private_even_from_shared_source(self):
        source = self.root / "shared.bin"
        source.write_bytes(b"dummy")
        source.chmod(0o644)
        storage.copy_file(source, self.root / "dest" / "copy.bin")
        self.assertEqual(self.mode(self.root / "dest" / "copy.bin"), 0o600)
        self.assertEqual((self.root / "dest" / "copy.bin").read_bytes(), b"dummy")

    def test_copy_never_replaces_or_follows_existing_destination(self):
        source = self.root / "source.bin"
        source.write_bytes(b"new")
        target = self.root / "outside.bin"
        target.write_bytes(b"untouched")
        link = self.root / "dest.bin"
        link.symlink_to(target)
        with self.assertRaises(OSError):
            storage.copy_file(source, link)
        self.assertEqual(target.read_bytes(), b"untouched")

    def test_write_refuses_symlinked_destination(self):
        target = self.root / "outside.json"
        target.write_text("untouched")
        (self.root / "settings.json").symlink_to(target)
        with self.assertRaises(OSError):
            storage.write_private_text(self.root / "settings.json", "dummy")
        self.assertEqual(target.read_text(), "untouched")


if __name__ == "__main__":
    unittest.main(verbosity=2)


@unittest.skipIf(os.name == "nt", "POSIX permission bits")
class PrivateDirectoryTest(unittest.TestCase):
    def test_symlinked_ancestor_is_resolved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "real").mkdir()
            (root / "alias").symlink_to(root / "real")
            storage.write_private_text(root / "alias" / "data" / "settings.json", "dummy")
            self.assertEqual((root / "real" / "data" / "settings.json").read_text(), "dummy")

    def test_group_writable_directory_is_allowed_under_umask_002(self):
        previous = os.umask(0o002)
        try:
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary) / "data"
                directory.mkdir(mode=0o775)
                os.chmod(directory, 0o775)
                storage.write_private_text(directory / "identity.json", "dummy")
                self.assertEqual(stat.S_IMODE((directory / "identity.json").stat().st_mode), 0o600)
        finally:
            os.umask(previous)

    def test_world_writable_directory_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "data"
            directory.mkdir()
            os.chmod(directory, 0o777)
            with self.assertRaises(PermissionError):
                storage.write_private_text(directory / "identity.json", "dummy")
