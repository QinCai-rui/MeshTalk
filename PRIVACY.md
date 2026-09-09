# MeshTalk telemetry privacy policy

Optional aggregate release telemetry. Privacy-minimised, off by default. This is not anonymous: version/platform/architecture plus timing and, with few users, `count=1` buckets can single out an install.

Off is the default. Basic telemetry sends only the version ping (once per app version). Extended telemetry (Tier 1, optional) adds room/group/transport-path counters and sanitized stability counters — no message or file activity, no chat content, filenames, identities, or stored IPs. Telemetry can be turned off entirely and changed anytime in Settings » Diagnostics or via `MESHTALK_TELEMETRY=off`.

IPs are not stored — the server keeps only 90-day daily aggregates — but they are visible transiently to the Cloudflare proxy and the ingest origin for delivery and rate-limiting. The proxy forwards only content-type plus the client-IP headers and drops fingerprinting headers. See [Telemetry](docs/TELEMETRY.md) for exact payloads, controls and precedence, retention, hosts, and how to verify with `tcpdump`.
