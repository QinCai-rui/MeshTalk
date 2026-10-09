"""Collect native installers with stable, unambiguous product/platform names."""
import shutil
import sys
from pathlib import Path

platform, arch = sys.argv[1:3]
bundle = Path("desktop/src-tauri/target/release/bundle")
extension = {"linux": "AppImage", "macos": "dmg", "windows": "exe"}[platform]
subdirectory = {"linux": "appimage", "macos": "dmg", "windows": "nsis"}[platform]
matches = list((bundle / subdirectory).glob(f"*.{extension}"))
if len(matches) != 1:
    raise RuntimeError(f"Expected one {platform} installer; found {len(matches)}")
platform_name = "" if platform == "linux" else f"{platform}-"
destination = Path("dist") / f"meshtalk-desktop-{platform_name}{arch}.{extension}"
destination.parent.mkdir(exist_ok=True)
shutil.copy2(matches[0], destination)

if platform == "linux":
    zsync = matches[0].with_suffix(matches[0].suffix + ".zsync")
    if not zsync.is_file():
        raise RuntimeError(f"Expected AppImage update metadata at {zsync}")
    shutil.copy2(zsync, destination.with_suffix(destination.suffix + ".zsync"))
