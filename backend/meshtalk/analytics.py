"""Optional aggregate release analytics. Privacy-minimised, off by default, no identifiers."""

# Notes on accuracy (kept here so code/docs cannot drift):
# - Release gate is best-effort runtime env MESHTALK_RELEASE (set by the launcher
#   from its build flag). It is not compile-time stripping: running a source
#   checkout with MESHTALK_RELEASE=1 can still send if analytics is enabled.
# - MESHTALK_ANALYTICS=extended|basic|off overrides the stored level, even an
#   explicit declined/never_ask_again choice. MESHTALK_NO_ANALYTICS=1,
#   DO_NOT_TRACK=1, CI/GITHUB_ACTIONS always disable.
# - No message or file-activity counters are collected (no msg.*, no file.*).
from __future__ import annotations

import asyncio
import collections
import json
import os
import platform
import re
import time
import urllib.request
from pathlib import Path

ANALYTICS_URL = "https://meshtalk-analytics.raymont.workers.dev/v1/analytics"
TIMEOUT_SECONDS = 3
DEFAULT_LEVEL = "off"
# Deliberately excludes msg.sent/msg.received/file.sent/file.completed and
# transport.stun_fail (never emitted). Room/group + transport-path counters only.
ALLOWED_EVENTS = {
    "room.created", "room.joined",
    "group.created", "transport.lan_ok", "transport.udp_ok", "transport.relay_fallback",
}
MAX_EVENT_COUNT = 10_000  # saturate per-event counters to bound privacy leak + server 400s
MAX_EVENTS_PER_FLUSH = 20
APP_VERSION_RE = re.compile(r"v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?")
_OS = {"Darwin": "darwin", "Linux": "linux", "Windows": "win32"}
_ARCH = {"x86_64": "x64", "AMD64": "x64", "aarch64": "arm64", "arm64": "arm64"}

def sanitize_error(exc: BaseException) -> str:
    """Return only a bounded exception-class event name; never an exception message."""
    name = re.sub(r"[^A-Za-z0-9_]", "", type(exc).__name__)[:64] or "Error"
    return f"error.{name}"

def _env_disabled() -> bool:
    return os.environ.get("MESHTALK_NO_ANALYTICS") == "1" or os.environ.get("DO_NOT_TRACK") == "1" or bool(os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"))

def _env_level() -> str | None:
    raw = (os.environ.get("MESHTALK_ANALYTICS") or "").strip().lower()
    if raw in {"off", "0", "disabled"}: return "off"
    if raw in {"basic", "tier0", "minimal"}: return "basic"
    if raw in {"1", "true", "extended", "tier1"}: return "extended"
    return None

def read_level(settings_path: Path | None = None) -> str:
    """Return the effective Tier-1 level: extended, basic, or off (default)."""
    override = _env_level()
    if override: return override
    path = settings_path or Path(os.environ.get("MESHTALK_DATA_DIR", Path.home() / ".meshtalk")) / "settings.json"
    try:
        data = json.loads(path.read_text())
        if data.get("analytics_level") in {"extended", "basic", "off"}: return data["analytics_level"]
        # Migrate legacy consent; missing consent remains disabled until the prompt.
        if data.get("analytics_consent") == "accepted": return "extended"
        if data.get("analytics_consent") in {"declined", "never_ask_again"}: return "off"
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
    """Tier-1 ("extended") gate. Basic sends Tier 0 only; missing consent is off."""
    return is_tier1_allowed(settings_path)

class Analytics:
    def __init__(self, settings_path: Path, app_version: str | None = None) -> None:
        self.settings_path, self.app_version = settings_path, app_version or os.environ.get("MESHTALK_APP_VERSION", "unknown")
        self.counter: collections.Counter[str] = collections.Counter()
        self._level_cache: str | None = None
        self._level_mtime: float = 0.0
        self._level_checked_at: float = 0.0

    def _cached_level(self) -> str:
        """Cache the stored level; re-read only if mtime changed or 30s elapsed."""
        try:
            mtime = self.settings_path.stat().st_mtime
        except OSError:
            mtime = 0.0
        now = time.monotonic()
        if self._level_cache is not None and mtime == self._level_mtime and (now - self._level_checked_at) < 30:
            return self._level_cache
        level = read_level(self.settings_path)
        self._level_cache, self._level_mtime, self._level_checked_at = level, mtime, now
        return level

    def enabled(self) -> bool:
        if not _release_build() or _env_disabled():
            return False
        override = _env_level()
        level = override if override else self._cached_level()
        return level == "extended"

    def incr(self, name: str) -> None:
        if name not in ALLOWED_EVENTS:
            return
        if self.enabled():
            self.counter[name] = min(self.counter.get(name, 0) + 1, MAX_EVENT_COUNT)

    def incr_error(self, exc: BaseException) -> None:
        """Record a sanitized stability counter (class name only, never message)."""
        if self.enabled():
            name = sanitize_error(exc)
            self.counter[name] = min(self.counter.get(name, 0) + 1, MAX_EVENT_COUNT)

    async def flush(self) -> bool:
        if not self.enabled() or not self.counter:
            return False
        # Saturate + bound cardinality: at most MAX_EVENTS_PER_FLUSH names,
        # at most 10 distinct error.* names per flush.
        items = [(n, c) for n, c in self.counter.items()
                 if (n in ALLOWED_EVENTS or n.startswith("error.")) and isinstance(c, int) and c > 0]
        errors = [n for n, _ in items if n.startswith("error.")]
        if len(errors) > 10:
            keep = set([n for n, _ in items if n in ALLOWED_EVENTS] + errors[:10])
            items = [(n, c) for n, c in items if n in keep]
        events = [{"name": n, "count": min(c, MAX_EVENT_COUNT)} for n, c in items[:MAX_EVENTS_PER_FLUSH]]
        # Always clear after building the payload: never accumulate unbounded
        # long-uptime volume across failures, and never retry a rejected
        # payload (unknown os/arch, dev version) forever.
        self.counter.clear()
        self._level_cache = None
        if not events:
            return False
        if not APP_VERSION_RE.fullmatch(self.app_version):
            return False
        payload = {"tier": 1, "app_version": self.app_version, "os": _OS.get(platform.system()), "arch": _ARCH.get(platform.machine()), "release": True, "events": events}
        if payload["os"] is None or payload["arch"] is None:
            return False
        def send() -> bool:
            # Cloudflare edge may return 403 for Python-urllib's default User-Agent
            # identify as meshtalk (version is already in the
            # payload, and the Worker strips UA before the origin anyway).
            request = urllib.request.Request(ANALYTICS_URL, data=json.dumps(payload, separators=(",", ":")).encode(), headers={"Content-Type": "application/json", "User-Agent": f"meshtalk/{self.app_version}"}, method="POST")
            try:
                with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response: return 200 <= response.status < 300
            except Exception: return False
        return await asyncio.to_thread(send)
