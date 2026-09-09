"""Aggregate-only release telemetry (Tier 1 "extended" is the default).  No identifiers or local queue."""
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
DEFAULT_LEVEL = "extended"
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

def _env_disabled() -> bool:
    return os.environ.get("MESHTALK_NO_TELEMETRY") == "1" or os.environ.get("DO_NOT_TRACK") == "1" or bool(os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"))

def _env_level() -> str | None:
    raw = (os.environ.get("MESHTALK_TELEMETRY") or "").strip().lower()
    if raw in {"off", "0", "disabled"}: return "off"
    if raw in {"basic", "tier0", "minimal"}: return "basic"
    if raw in {"1", "true", "extended", "tier1"}: return "extended"
    return None

def read_level(settings_path: Path | None = None) -> str:
    """Return the effective Tier-1 level: extended (default), basic, or off."""
    override = _env_level()
    if override: return override
    path = settings_path or Path(os.environ.get("MESHTALK_DATA_DIR", Path.home() / ".meshtalk")) / "settings.json"
    try:
        data = json.loads(path.read_text())
        if data.get("telemetry_level") in {"extended", "basic", "off"}: return data["telemetry_level"]
        # Migrate legacy consent; missing consent defaults to extended.
        if data.get("telemetry_consent") == "accepted": return "extended"
        if data.get("telemetry_consent") in {"declined", "never_ask_again"}: return "off"
    except Exception: pass
    return DEFAULT_LEVEL

def _release_build() -> bool:
    return os.environ.get("MESHTALK_RELEASE") in {"1", "true", "True"}

def is_tier0_allowed(settings_path: Path | None = None) -> bool:
    if not _release_build() or _env_disabled(): return False
    return read_level(settings_path) in {"extended", "basic"}

def is_tier1_allowed(settings_path: Path | None = None) -> bool:
    if not _release_build() or _env_disabled(): return False
    return read_level(settings_path) == "extended"

def is_enabled(settings_path: Path | None = None) -> bool:
    """Tier-1 ("extended") gate.  Extended is the default; Basic sends Tier 0 only."""
    return is_tier1_allowed(settings_path)

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
