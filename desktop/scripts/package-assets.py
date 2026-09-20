"""Collect native installers with stable, unambiguous product/platform names."""
import shutil
import sys
from pathlib import Path

platform, arch = sys.argv[1:3]
bundle = Path("desktop/src-tauri/target/release/bundle")
extension = {"linux": "AppImage", "macos": "dmg", "windows": "exe"}[platform]
matches = list(bundle.rglob(f"*.{extension}"))
if len(matches) != 1:
    raise RuntimeError(f"Expected one {platform} installer; found {len(matches)}")
destination = Path("dist") / f"meshtalk-desktop-{platform}-{arch}.{extension}"
destination.parent.mkdir(exist_ok=True)
shutil.copy2(matches[0], destination)
