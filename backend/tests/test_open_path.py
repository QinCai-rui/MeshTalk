import tempfile
import unittest
from pathlib import Path

from meshtalk.__main__ import _is_allowed_open_path


class AllowedOpenPathTest(unittest.TestCase):
    def test_allows_root_and_descendants(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertTrue(_is_allowed_open_path(root, (root,)))
            child = root / "files" / "peer"
            child.mkdir(parents=True)
            self.assertTrue(_is_allowed_open_path(child, (root,)))

    def test_allows_nonexistent_descendant(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertTrue(_is_allowed_open_path(root / "nested" / "missing", (root,)))

    def test_rejects_outside_paths_and_prefix_siblings(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            allowed = base / "data"
            sibling = base / "data-evil"
            outside = base / "elsewhere"
            for directory in (allowed, sibling, outside):
                directory.mkdir()
            self.assertFalse(_is_allowed_open_path(outside, (allowed,)))
            # A shared prefix is not containment.
            self.assertFalse(_is_allowed_open_path(sibling, (allowed,)))


if __name__ == "__main__":
    unittest.main()
