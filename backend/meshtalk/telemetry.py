"""Opt-in, aggregate-only release telemetry.  No identifiers or local queue."""
from __future__ import annotations

import asyncio
import collections
import json
import os
import platform
import re
import urllib.request
from pathlib import Path

TELEMETRY_URL = "https://meshtalk-telemetry.raymont.workers.dev/v1/telemetry"
TIMEOUT_SECONDS = 3
ALLOWED_EVENTS = {
    "msg.sent", "msg.received", "file.sent", "file.completed", "room.created", "room.joined",
    "group.created", "transport.lan_ok", "transport.udp_ok", "transport.relay_fallback", "transport.stun_fail",
}
_OS = {"Darwin": "darwin", "Linux": "linux", "Windows": "win32"}
_ARCH = {"x86_64": "x64", "AMD64": "x64", "aarch64": "arm64", "arm64": "arm64"}

def sanitize_error(exc: BaseException) -> str:
    """Return only a bounded exception-class event name; never an exception message."""
    name = re.sub(r"[^A-Za-z0-9_]", "", type(exc).__name__)[:64] or "Error"
    return f"error.{name}"

def is_enabled(settings_path: Path | None = None) -> bool:
    if os.environ.get("MESHTALK_RELEASE") not in {"1", "true", "True"}: return False
    if os.environ.get("MESHTALK_NO_TELEMETRY") == "1" or os.environ.get("DO_NOT_TRACK") == "1": return False
    if os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"): return False
    if os.environ.get("MESHTALK_TELEMETRY") == "1": return True
    path = settings_path or Path(os.environ.get("MESHTALK_DATA_DIR", Path.home() / ".meshtalk")) / "settings.json"
    try: return json.loads(path.read_text()).get("telemetry_consent") == "accepted"
    except Exception: return False

class Telemetry:
    def __init__(self, settings_path: Path, app_version: str | None = None) -> None:
        self.settings_path, self.app_version = settings_path, app_version or os.environ.get("MESHTALK_APP_VERSION", "unknown")
        self.counter: collections.Counter[str] = collections.Counter()

    def enabled(self) -> bool: return is_enabled(self.settings_path)
    def incr(self, name: str) -> None:
        if self.enabled() and (name in ALLOWED_EVENTS or name.startswith("error.")): self.counter[name] += 1
    async def flush(self) -> bool:
        if not self.enabled() or not self.counter: return False
        events = [{"name": name, "count": count} for name, count in self.counter.items() if (name in ALLOWED_EVENTS or name.startswith("error.")) and isinstance(count, int) and count > 0][:50]
        if not events: return False
        payload = {"tier": 1, "app_version": self.app_version, "os": _OS.get(platform.system()), "arch": _ARCH.get(platform.machine()), "release": True, "events": events}
        if payload["os"] is None or payload["arch"] is None: return False
        def send() -> bool:
            request = urllib.request.Request(TELEMETRY_URL, data=json.dumps(payload, separators=(",", ":")).encode(), headers={"Content-Type": "application/json"}, method="POST")
            try:
                with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response: return 200 <= response.status < 300
            except Exception: return False
        if await asyncio.to_thread(send): self.counter.clear(); return True
        return False
