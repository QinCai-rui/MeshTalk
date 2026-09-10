"""Optional aggregate analytics ingest. IPs used transiently for rate-limit, never stored."""
import json, os, re, threading, time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from store import Store

# No msg.*/file.* counters. Room/group + transport-path only.
EVENTS = {"room.created", "room.joined", "group.created", "transport.lan_ok", "transport.udp_ok", "transport.relay_fallback"}
FORBIDDEN = {"peer_id", "room_id", "install_id", "id", "ip", "path", "filename", "username", "secret", "invite", "content"}
OS, ARCH = {"darwin", "linux", "win32"}, {"arm64", "x64"}
# Per-IP state is deliberately process-memory only; IPs are never persisted.
# Limits are generous on purpose: many legitimate devices routinely share one
# public IP (home/office/school NAT, mobile CGNAT). A healthy device sends
# ~1 Tier-1 flush/hour plus rare Tier-0 pings/shutdown flushes, so the budget
# must cover N devices x ~2 req/hour per public IP. Burst absorbs fleet
# restart storms (e.g. an office upgrading at once). Abuse impact stays bounded
# because payloads are validated (<=20 events, count<=10k) and aggregated.
# Tune via env without code changes.
BURST = int(os.environ.get("ANALYTICS_RATELIMIT_BURST", "120"))
PER_HOUR = float(os.environ.get("ANALYTICS_RATELIMIT_PER_HOUR", "600"))
BUCKETS: dict[str, tuple[float, float]] = {}
BUCKETS_LOCK = threading.Lock()
MAX_BUCKETS = 10_000
STORE = Store(os.environ.get("ANALYTICS_DB", "/data/analytics.sqlite"))
_RECORDS = 0
_RECORDS_LOCK = threading.Lock()

def _utc_today_iso() -> str:
    return datetime.now(timezone.utc).date().isoformat()

def client_ip(handler: BaseHTTPRequestHandler) -> str:
    """Prefer the Worker-forwarded client IP; fall back to the TCP peer."""
    for header in ("CF-Connecting-IP", "X-Forwarded-For"):
        value = handler.headers.get(header)
        if value:
            # X-Forwarded-For may be a chain; first entry is the original client.
            return value.split(",")[0].strip()
    return handler.client_address[0]

def check_rate_limit(ip: str, now: float) -> bool:
    with BUCKETS_LOCK:
        tokens, previous = BUCKETS.get(ip, (float(BURST), now))
        tokens = min(float(BURST), tokens + (now - previous) * (PER_HOUR / 3600.0))
        if tokens < 1:
            BUCKETS[ip] = (tokens, previous)
            return False
        BUCKETS[ip] = (tokens - 1, now)
        # Evict to bound memory: drop stale buckets when the table grows.
        if len(BUCKETS) > MAX_BUCKETS:
            stale = [k for k, (_, ts) in BUCKETS.items() if now - ts > 3600]
            for k in stale[: len(BUCKETS) - MAX_BUCKETS + 1000]:
                BUCKETS.pop(k, None)
            # Fallback: drop oldest timestamps if still over budget.
            if len(BUCKETS) > MAX_BUCKETS:
                for k in sorted(BUCKETS, key=lambda k: BUCKETS[k][1])[: len(BUCKETS) - MAX_BUCKETS]:
                    BUCKETS.pop(k, None)
        return True

def validate(value: object) -> dict | None:
    if not isinstance(value, dict) or any(key in value for key in FORBIDDEN): return None
    if set(value) - {"tier", "app_version", "os", "arch", "release", "events"}: return None
    if value.get("tier") not in {0, 1} or value.get("release") is not True: return None
    if not isinstance(value.get("app_version"), str) or not re.fullmatch(r"v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", value["app_version"]): return None
    if value.get("os") not in OS or value.get("arch") not in ARCH: return None
    if value["tier"] == 0: return value if set(value) == {"tier", "app_version", "os", "arch", "release"} else None
    events = value.get("events")
    if not isinstance(events, list) or not events or len(events) > 20 or set(value) != {"tier", "app_version", "os", "arch", "release", "events"}: return None
    error_names = 0
    for event in events:
        if not isinstance(event, dict) or set(event) != {"name", "count"} or not isinstance(event["name"], str) or not isinstance(event["count"], int) or not 0 < event["count"] <= 10_000 or (event["name"] not in EVENTS and not re.fullmatch(r"error\.[A-Za-z0-9_]{1,64}", event["name"])): return None
        if event["name"].startswith("error."):
            error_names += 1
            if error_names > 10:
                return None
    return value

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def _reply(self, code: int, body: bytes = b""):
        self.send_response(code); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self): self._reply(200, b"ok") if self.path == "/health" else self._reply(404)
    def do_POST(self):
        if self.path != "/v1/analytics": return self._reply(404)
        now = time.monotonic()
        if not check_rate_limit(client_ip(self), now):
            return self._reply(429)
        try: payload = validate(json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", "0")), 65536))))
        except Exception: payload = None
        if payload is None: return self._reply(400)
        STORE.record(payload)
        global _RECORDS
        with _RECORDS_LOCK:
            _RECORDS += 1
            should_prune = _RECORDS % 500 == 0
        if should_prune:
            try: STORE.prune()
            except Exception: pass
        self._reply(204)

if __name__ == "__main__": ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
