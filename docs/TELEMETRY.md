# Telemetry

Telemetry is off by default and is compiled into release builds only. Source builds never collect or send telemetry. Opt in from the first-launch prompt or with `MESHTALK_TELEMETRY=1`; `MESHTALK_NO_TELEMETRY=1` and `DO_NOT_TRACK=1` always disable it.

Tier 0 is sent at most once per app version: `{"tier":0,"app_version":"0.24.12","os":"darwin","arch":"arm64","release":true}`. Tier 1 is sent no more than hourly and on clean shutdown: `{"tier":1,"app_version":"0.24.12","os":"darwin","arch":"arm64","release":true,"events":[{"name":"msg.sent","count":3}]}`.

We never send a persistent ID, peer ID, public key, room ID or secret, invite, message or file content, filename, path, username, or IP address. The server uses source IP only transiently to rate-limit requests; it stores only 90-day daily aggregates. Counts are approximate and are not unique-install measurements.

Declining keeps telemetry off and asks again after an upgrade. “Never ask me again” keeps it off permanently. The hosts are `meshtalk-telemetry.raymont.workers.dev` (proxy) and `meshtalk-telemetry.qincai.xyz` (ingest).
