"""One backend process per data directory, including concurrent GUI/CLI starts."""
from __future__ import annotations

import os
from pathlib import Path


class InstanceLock:
    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True)
        self.file = open(directory / "backend.lock", "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                if self.file.seek(0, 2) == 0:
                    self.file.write(b"0")
                    self.file.flush()
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            raise RuntimeError("A MeshTalk backend already owns this data directory") from None

    def close(self):
        if not self.file.closed:
            if os.name == "nt":
                import msvcrt
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            self.file.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
