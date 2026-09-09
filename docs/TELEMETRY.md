# Telemetry

Telemetry is compiled into release builds only. Source builds never collect or send telemetry.

Telemetry is disabled until you explicitly choose extended or basic telemetry in the first-launch dialog. Extended sends Tier 0 version pings plus aggregate usage and stability counters; basic sends only version pings. You can change this in Settings » Diagnostics, or with `MESHTALK_TELEMETRY=extended|basic|off`; `MESHTALK_NO_TELEMETRY=1` and `DO_NOT_TRACK=1` always disable it.

Tier 0 is sent at most once per app version: `{"tier":0,"app_version":"0.24.12","os":"darwin","arch":"arm64","release":true}`. Tier 1 is sent no more than hourly and on clean shutdown: `{"tier":1,"app_version":"0.24.12","os":"darwin","arch":"arm64","release":true,"events":[{"name":"msg.sent","count":3}]}`.

We never send a persistent ID, peer ID, public key, room ID or secret, invite, message or file content, filename, path, username, or IP address. The server uses source IP only transiently to rate-limit requests; it stores only 90-day daily aggregates. Counts are approximate and are not unique-install measurements.

Switching telemetry off keeps it off but asks again after an upgrade (to re-confirm the choice). The hosts are `meshtalk-telemetry.raymont.workers.dev` (proxy) and `meshtalk-telemetry.qincai.xyz` (ingest).
