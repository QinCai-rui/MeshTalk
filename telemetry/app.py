"""Small privacy-preserving telemetry ingest. Raw requests and IPs are never stored."""
import json, os, re, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from store import Store

EVENTS = {"msg.sent", "msg.received", "file.sent", "file.completed", "room.created", "room.joined", "group.created", "transport.lan_ok", "transport.udp_ok", "transport.relay_fallback", "transport.stun_fail"}
FORBIDDEN = {"peer_id", "room_id", "install_id", "id", "ip", "path", "filename", "username", "secret", "invite", "content"}
OS, ARCH = {"darwin", "linux", "win32"}, {"arm64", "x64"}
# Per-IP state is deliberately process-memory only.  A bucket holds at most a
# 20-request burst and refills at 10 requests per hour; IPs are never persisted.
BUCKETS: dict[str, tuple[float, float]] = {}
STORE = Store(os.environ.get("TELEMETRY_DB", "/data/telemetry.sqlite"))

def validate(value: object) -> dict | None:
    if not isinstance(value, dict) or any(key in value for key in FORBIDDEN): return None
    if set(value) - {"tier", "app_version", "os", "arch", "release", "events"}: return None
    if value.get("tier") not in {0, 1} or value.get("release") is not True: return None
    if not isinstance(value.get("app_version"), str) or not re.fullmatch(r"v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", value["app_version"]): return None
    if value.get("os") not in OS or value.get("arch") not in ARCH: return None
    if value["tier"] == 0: return value if set(value) == {"tier", "app_version", "os", "arch", "release"} else None
    events = value.get("events")
    if not isinstance(events, list) or not events or len(events) > 50 or set(value) != {"tier", "app_version", "os", "arch", "release", "events"}: return None
    for event in events:
        if not isinstance(event, dict) or set(event) != {"name", "count"} or not isinstance(event["name"], str) or not isinstance(event["count"], int) or not 0 < event["count"] <= 1_000_000 or (event["name"] not in EVENTS and not re.fullmatch(r"error\.[A-Za-z0-9_]{1,64}", event["name"])): return None
    return value

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def _reply(self, code: int, body: bytes = b""):
        self.send_response(code); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self): self._reply(200, b"ok") if self.path == "/health" else self._reply(404)
    def do_POST(self):
        if self.path != "/v1/telemetry": return self._reply(404)
        now = time.monotonic(); ip = self.client_address[0]
        tokens, previous = BUCKETS.get(ip, (20.0, now))
        tokens = min(20.0, tokens + (now - previous) * (10.0 / 3600.0))
        if tokens < 1: return self._reply(429)
        BUCKETS[ip] = (tokens - 1, now)
        try: payload = validate(json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", "0")), 65536))))
        except Exception: payload = None
        if payload is None: return self._reply(400)
        STORE.record(payload); self._reply(204)

if __name__ == "__main__": ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
