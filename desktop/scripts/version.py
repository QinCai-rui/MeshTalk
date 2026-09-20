"""Stamp the desktop package, Cargo crate, lock, and Tauri config together."""
import json
import re
import sys
from pathlib import Path


def stamp(root: Path, version: str):
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
        raise ValueError("Expected a semantic version")
    for relative in ("package.json", "src-tauri/tauri.conf.json"):
        path = root / relative
        value = json.loads(path.read_text())
        value["version"] = version
        path.write_text(json.dumps(value, indent=2) + "\n")
    cargo = root / "src-tauri/Cargo.toml"
    cargo.write_text(re.sub(r'^version = "[^"]+"', f'version = "{version}"', cargo.read_text(), count=1, flags=re.M))
    lock = root / "src-tauri/Cargo.lock"
    if lock.exists():
        lock.write_text(re.sub(r'(name = "meshtalk-desktop"\nversion = ")[^"]+', lambda m: m[1] + version, lock.read_text()))


if __name__ == "__main__":
    stamp(Path(__file__).resolve().parents[1], sys.argv[1])
