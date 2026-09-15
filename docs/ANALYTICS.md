# Analytics

Optional aggregate analytics. Privacy-minimised, **off by default** — never "privacy-preserving" or "anonymous".

Release-gate is best-effort runtime config: the launcher sets `MESHTALK_RELEASE=1` for release builds and the backend checks it. It is not compile-time stripping, so a source checkout run with `MESHTALK_RELEASE=1` can still send if analytics is enabled.

Analytics stays off until you explicitly choose extended or basic in the first-launch dialog (Off is preselected). Extended sends Tier 0 version pings plus room/group/transport-path counters; basic sends only version pings. No message or file-activity counters are collected (no `msg.*`, no `file.*`).

You can change this in Settings » Diagnostics, or with `MESHTALK_ANALYTICS=extended|basic|off` (env overrides the stored choice, even an explicit declined/never-ask choice). `MESHTALK_NO_ANALYTICS=1` and `DO_NOT_TRACK=1` (and `CI`/`GITHUB_ACTIONS`) always disable it. CLI-only installs: use the env var, then the choice persists; switching off keeps it off but asks again after an upgrade.

Tier 0 is sent at most once per app version (best-effort dedup; two concurrent launchers can double-ping): `{"tier":0,"app_version":"0.24.12","os":"darwin","arch":"arm64","release":true}`. Tier 1 is sent no more than hourly and on clean shutdown (shutdown flush is best-effort with a 1.5s timeout and never delays exit): `{"tier":1,"app_version":"0.24.12","os":"darwin","arch":"arm64","release":true,"events":[{"name":"room.created","count":1}]}`. Allowed Tier-1 names: `room.created, room.joined, group.created, transport.lan_ok, transport.udp_ok, transport.relay_fallback` plus sanitized `error.<ClassName>` (class name only, max 10 distinct per flush). Per-event counts saturate at 10,000; counters clear after each flush attempt so failures never accumulate unbounded history.

We never send persistent IDs, peer IDs, public keys, room IDs or secrets, invites, message or file content, filenames, paths, or usernames. We do not store IP addresses: the server keeps only 90-day daily aggregates (`daily_pings`, `daily_events`, UTC day). But IPs are necessarily visible transiently: HTTP(S) exposes source IP to the Cloudflare Worker edge and to the origin for TCP delivery and per-IP rate-limiting (120-request burst, 600/hour refill per public IP — generous enough for many devices behind one NAT/CGNAT; tune via `ANALYTICS_RATELIMIT_BURST`/`ANALYTICS_RATELIMIT_PER_HOUR`). The Worker forwards only `content-type` plus `CF-Connecting-IP`/`X-Forwarded-For` and drops all other client headers (`User-Agent`, `Accept-Language`, …). Cloudflare may retain edge logs per its own policy; we do not control that.

Counts are approximate. With a small user base, a `daily_pings(version,os,arch,day)=1` bucket can single out an install — treat low-traffic buckets as identifying. The ingest endpoint is open and unauthenticated by design (anonymous analytics), so counts are also poisonable; deploy behind `127.0.0.1:${ANALYTICS_PORT:-8089}:8089` + firewall, and do not treat them as exact.

The hosts are `meshtalk-analytics.raymont.workers.dev` (proxy) and `meshtalk-analytics.qincai.xyz` (ingest). Verify with `tcpdump`/proxy logs: with analytics off, no egress to those hosts should occur outside update checks.
