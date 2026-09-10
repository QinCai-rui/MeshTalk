# MeshTalk Analytics (Telemetry) Privacy Policy

_Last updated: 2026-09-09._

MeshTalk is built to minimize data collection: chats are end-to-end encrypted, work over LAN with no internet at all, and the control service never sees message contents. This policy covers the one exception — the **optional, off-by-default aggregate analytics** (also called telemetry) in release builds — and nothing else, because there is nothing else to cover: we operate no accounts, no tracking, no advertising, and no other data collection.

## 1. Scope

This policy applies only to the analytics described here. It does not apply to:

- your messages, files, friends, rooms, or identities, which never leave your devices except as end-to-end encrypted traffic to peers you chose;
- the control/relay service and STUN, which necessarily observe network endpoints to connect peers (see the design docs);
- third-party services you interact with directly (e.g. update checks via your platform's channels, Cloudflare edge logs described below).

## 2. What we collect — and only with your consent

Analytics is **off until you explicitly opt in** (first-launch dialog, Off preselected; no pre-ticked boxes). Two levels:

- **Basic:** a Tier-0 version ping, at most once per app version: app version, operating system, CPU architecture, e.g. `{"tier":0,"app_version":"0.24.12","os":"darwin","arch":"arm64","release":true}`.
- **Extended (Tier 1, optional):** the above plus aggregate counters for room/group lifecycle and transport paths (`room.created, room.joined, group.created, transport.lan_ok, transport.udp_ok, transport.relay_fallback`) and sanitized stability counters (`error.<ClassName>` — exception class names only, never messages or tracebacks). Sent at most hourly and on clean shutdown (shutdown flush is best-effort, 1.5s timeout, never delays exit). Per-event counts saturate at 10,000 and clear after each attempt.

## 3. What we never collect

No persistent or installation IDs, peer IDs, public keys, room IDs or secrets, invites, message or file contents, filenames, paths, usernames, or message/file activity counters. There is deliberately no way to join analytics records back to a person or device on our side.

## 4. How we use it

Solely to understand release adoption and connection health across platforms (e.g. which versions are in use, whether relay fallback is spiking) so development effort goes where it matters. We do not use it for advertising, profiling, pricing, or any automated decision-making, and we do not sell or share aggregates with third parties.

## 5. Sharing and third parties

- The analytics proxy runs on Cloudflare Workers (`meshtalk-analytics.raymont.workers.dev`) and forwards to our ingest (`meshtalk-analytics.qincai.xyz`). Neither sells or shares this data.
- IP addresses are **not stored** — the server keeps only daily aggregate counters — but they are unavoidably visible in transit: HTTP(S) exposes source IP to the Cloudflare edge and to the origin for delivery and per-IP rate-limiting (120-request burst, 600/hour per public IP). The proxy forwards only `content-type` plus the client-IP headers and drops fingerprinting headers (`User-Agent`, `Accept-Language`, …). Cloudflare may retain its own edge logs under its policies, which we do not control.
- Counts are approximate; the endpoint is open and unauthenticated by design, so counts are poisonable and must not be treated as exact.

## 6. Retention

90-day rolling daily aggregates (`daily_pings`, `daily_events`, UTC days), then deleted. No raw requests, payloads, or IPs are logged or retained by us.

## 7. Your choices and rights

- **Change or withdraw consent anytime:** Settings » Diagnostics, or `MESHTALK_ANALYTICS=extended|basic|off`. `MESHTALK_NO_ANALYTICS=1` and `DO_NOT_TRACK=1` (plus `CI`/`GITHUB_ACTIONS`) always disable it. Switching off stops all future sending but does not delete already-aggregated counts, which contain no identifiers.
- **Verify yourself:** with analytics off, `tcpdump`/proxy logs should show no egress to the hosts above outside update checks. Exact payloads are published in [Analytics](docs/ANALYTICS.md).
- Because we hold no identifiers, we cannot look up, export, or delete "your" records specifically — there is nothing keyed to you. If you believe aggregate data identifies you (possible while the user base is small: a `count=1` bucket can single out an install), contact us and we can suppress publication of small buckets.

## 8. Children

MeshTalk has no age-gated accounts and analytics contains no personal data, but analytics should not be enabled for children under 13 (or your local age of digital consent) — leave it off.

## 9. Changes to this policy

Material changes will be noted here with a new date and, where feasible, announced with the release. Continued opt-in after a change takes effect constitutes acceptance; you can always switch analytics off.

## 10. Contact

Questions or requests: open an issue at [`QinCai-rui/MeshTalk`
](https://github.com/QinCai-rui/MeshTalk/issues/new)
