# Telemetry

Telemetry is compiled into release builds only. Source builds never collect or send telemetry.

Tier 1 ("extended telemetry") is the default: Tier 0 version pings plus aggregate usage and stability counters. Switch to Tier 0 only ("basic telemetry") or turn it off in Settings » Diagnostics, or with `MESHTALK_TELEMETRY=basic|off`; `MESHTALK_NO_TELEMETRY=1` and `DO_NOT_TRACK=1` always disable it. `MESHTALK_TELEMETRY=extended` (or `1`) forces extended on.

Tier 0 is sent at most once per app version: `{"tier":0,"app_version":"0.24.12","os":"darwin","arch":"arm64","release":true}`. Tier 1 is sent no more than hourly and on clean shutdown: `{"tier":1,"app_version":"0.24.12","os":"darwin","arch":"arm64","release":true,"events":[{"name":"msg.sent","count":3}]}`.

We never send a persistent ID, peer ID, public key, room ID or secret, invite, message or file content, filename, path, username, or IP address. The server uses source IP only transiently to rate-limit requests; it stores only 90-day daily aggregates. Counts are approximate and are not unique-install measurements.

Switching telemetry off keeps it off but asks again after an upgrade (to re-confirm the choice). The hosts are `meshtalk-telemetry.raymont.workers.dev` (proxy) and `meshtalk-telemetry.qincai.xyz` (ingest).
