# File Transfer — Full Design Doc (v2 Rewrite)

This is the single authoritative spec for reimplementing MeshTalk file transfers.
An agent with only the current repo + this file must be able to rebuild the
whole stack: wire protocol, storage, backend, IPC, TUI, CLI, and tests.
The agent is expected to edit all other docs itself as needed. No other doc
changes are part of this task.

Limits (frozen): 50 MiB max file, 28 KiB plaintext per chunk, 255-char
sanitized filename, 64 KiB max packet. Transports unchanged: LAN TCP records
and reliable fragmented UDP datagrams, same framing as text chat.

## 1. Background: how v1 works today

- `backend/meshtalk/file_transfer.py::FileTransferManager` owns everything.
  Wired in `backend/meshtalk/__main__.py::_combined_packet_handler` (files
  first, then typing, then `MessageRouter`) and `flush_outgoing`.
- DM send: `send_file(recipient_id, path, group_id=None)` snapshots the source
  to `files/sent/<file_id>/<name>`, mints `file_id = uuid4`, `created_at =
  time.time()`, writes one `file_transfers` row (`direction=outbound`), then
  sends one signed `FILE_OFFER` + N per-chunk E2EE `FILE_CHUNK` packets.
  Each chunk is encrypted with the recipient's X25519 key (fresh ephemeral
  per chunk, AES-256-GCM, AAD = routing metadata) and signed with the
  sender's Ed25519 key. Offline recipients fall back to `outqueue` rows.
- Receive: `_handle_offer` verifies signature/routing/friendship-or-membership,
  dedupes via `seen_messages`, preallocates the destination
  (`files/<group|sender>/<name>_<timestamp>`), writes a `file_transfers` row
  (`direction=inbound, status=transferring`). `_handle_chunk` verifies,
  decrypts, seeks to `chunk_index * chunk_size`, records receipt in
  `file_received_chunks`, emits coalesced `file_progress`. At
  `received == total_chunks` it stats the size, marks `completed`, sends
  `FILE_ACK(completed)`, emits `file_completed`.
- ACKs: `completed` → sender marks transfer `completed` + `file_delivered`;
  `blocked` → marks `blocked`, drops queued rows, emits `file_blocked`;
  `missing` + ranges → `_resend_missing_chunks`. `resume_for_peer` re-ACKs
  completed inbound files and requests missing ranges for partials.
- Statuses used on rows: `pending/transferring/sent/queued/completed/
  failed/blocked/unavailable` (inbound also `receiving` in TUI mapping).
- Group send today (`handle_group_file_send` in `__main__.py`) loops members
  and calls `send_file()` once per member. Every call mints its own `file_id`.
  There is no `file_deliveries` table (unlike `group_deliveries` for text).
  The TUI masks this with a `filename|sender|group|round(created_at)`
  grouping heuristic (`tui/src/ChatApp.tsx`), which splits across second
  boundaries and merges unrelated same-second sends.

## 2. Problems to fix (binding)

1. One user action must equal one logical send. Group fan-out under N
   `file_id`s is the root duplicate-bubble bug: N rows, N snapshots, N
   `created_at`s, divergent `delivered/queued` labels, per-row retry/delete.
2. `flush_for_peer` re-streams chunks `0..N-1` and unconditionally deletes
   chunk outqueue rows even after partial failure re-queues the remainder;
   concurrent flushes double-send. Must become missing-only + locked.
3. `_resend_missing_chunks` catches only `(OSError, ConnectionError)`, so
   other `send_packet` errors crash the ACK handler. Must not propagate.
4. `FILE_ACK` is fire-and-forget; generic flush explicitly skips file types.
   Only completion is re-sent on resume. Missing-request ACKs stall.
5. Early-chunk replay after `completed` raises instead of ignoring.
6. `_complete_inbound_transfer` calls `stat()` unguarded → `FileNotFoundError`
   instead of `failed`.
7. Local delete clears transfer + chunks + outqueue but not `seen_messages`,
   so a retransmitted offer is silently dropped forever.
8. Sender marks `sent` on stream finish pre-ACK, yet `sent` is retryable →
   duplicate resend on in-flight ACK.
9. Wire accepts `status="ack"` but the handler drops it silently.
10. TUI: filename/time grouping merges distinct sends; `best()` hides
    per-member failure and Retry; outbound progress lacks `received`;
    confirm dialog double-submits and follows live selection; staged drops
    with the same basename collide; no Retry on `queued/sent`; directory
    masks as present file.

## 3. Goals (full rewrite, breaking allowed)

- One shared `file_id` per logical send (DM and group). Group fan-out keeps
  per-recipient state in a new `file_deliveries` table, mirroring
  `group_messages`/`group_deliveries`.
- New capability `file_transfer_v2` (`CAP_FILE_TRANSFER_V2`). New packet
  type names with `_v2` suffix. Old `0x11–0x13` receive path stays read-only
  for legacy/in-flight rows; all new sends are v2.
- Additions in v1 of the rewrite: whole-file SHA-256 integrity, multi-file
  batch sends, and a text caption attachable to any file/image (like major
  chat platforms: caption renders with the attachment, stored signed).
- Non-goals: pause/cancel, larger files, adaptive chunks, relay tuning.
  Keep sequential per-recipient streaming + missing-range resume.

## 4. Wire v2

Capability string: `file_transfer_v2`. Both peers must advertise it or the
sender marks the delivery `unavailable` (same policy as the current
`file_transfer` gate). Never send v2 bytes to a peer lacking it.

Packet types (same TCP-record / reliable-UDP-data framing as today):

| Type | Value | Name | Purpose |
|---|---|---|---|
| FILE_OFFER_V2 | 0x15 | File Offer v2 | Signed metadata + hash + caption + batch refs |
| FILE_CHUNK_V2 | 0x16 | File Chunk v2 | Per-chunk E2EE + signature, shared `file_id` |
| FILE_ACK_V2 | 0x17 | File Ack v2 | `completed`/`missing`/`blocked` + ranges |

Encoding: JSON objects, same conventions as v1 (`signature` as hex,
canonical `signed_bytes` via `json.dumps(separators=(",",":"),
sort_keys=True)`).

- `FileOfferV2 { file_id: uuid4-hex, batch_id?: uuid4-hex,
  batch_index?: int, batch_count?: int, filename: sanitized ≤255,
  file_size: 1..50MiB, chunk_size: 1..28KiB, total_chunks:
  ceil(file_size/chunk_size) ≤ 10000 with size/chunks consistency,
  file_sha256: [a-f0-9]{64} of plaintext, caption: UTF-8 0..1024 bytes
  (optional, default ""), sender_id, recipient_id, group_id? (32-hex or
  absent), created_at: number, signature: 64B Ed25519 }`.
  `signed_bytes` covers every field except `signature`. Batch refs are
  all-or-none with `0 <= batch_index < batch_count <= 32`. Any violation →
  `ValueError("Invalid file offer v2 payload")`, drop + log, no row.
- `FileChunkV2 { file_id, chunk_index, total_chunks, sender_id,
  recipient_id, group_id?, encrypted_content: bytes, signature }`.
  Construction, AAD (`file_id/chunk_index/sender/recipient[/group_id]`),
  per-chunk ephemeral X25519/AES-GCM, and Ed25519 `sha256(aad+ciphertext)`
  signing are identical to v1 — forward secrecy per chunk preserved.
  Bounds-check `chunk_index < total_chunks`.
- `FileAckV2 { file_id, recipient_id, status: completed|missing|blocked,
  missing_ranges?: [[start,end]...] (required iff missing, each
  `0 <= start <= end < total_chunks`), signature }`. No `ack` status.

Behavior:

- DM: `recipient_id` = one peer. Require friendship and v2 capability,
  else `blocked`/`unavailable` exactly like v1 parity (`MESSAGE_BLOCKED`
  style, `block_reports` gate for the notice).
- Group: the sender emits one `FILE_OFFER_V2` + one chunk stream **per
  recipient**, each encrypted for that recipient, all under the **same
  `file_id`** with `group_id` set. Require active membership, unblocked,
  v2-capable; otherwise per-recipient `unavailable` (never send bytes).
- Caption is signed offer metadata, rendered with the attachment. It is
  never a separate `MESSAGE`. Empty = attachment-only.
- Batch: `batch_id = uuid4` minted once per user action. Each file gets its
  own `file_id` but shares `batch_id/batch_count`; `batch_index` orders
  rendering. Lifecycles (ACK/flush/retry) stay per `file_id` so partial
  failure is per-file; TUI renders the batch as one block.
- Integrity: receiver checks per-chunk AEAD on arrival (unchanged) and,
  before emitting `file_completed`, checks
  `sha256(reassembled plaintext) == file_sha256`. Mismatch → mark `failed`,
  delete the partial, send one `missing` (all ranges); if still mismatched,
  stay `failed`.
- Interop: v2↔v2 full; v2→v1-only peer = `unavailable`, no downgrade;
  v1→v2 peer accepted on the legacy read path.

## 5. Storage / DB (`database.py`)

- `file_transfers`: exactly one sender row per `file_id`. Group sender rows
  store `recipient_id = ""` (`GROUP_FILE_SENDER_ROW_RECIPIENT`); per-member
  state lives in `file_deliveries (file_id, recipient_id, status,
  updated_at)` with `PRIMARY KEY (file_id, recipient_id)`.
- New `file_transfers` columns: `file_sha256 TEXT NOT NULL DEFAULT ""`,
  `caption TEXT NOT NULL DEFAULT ""`, `batch_id TEXT NULL`,
  `batch_index INTEGER NULL`, `batch_count INTEGER NULL`.
- Migration: create `file_deliveries` if absent; `ADD COLUMN` anything
  missing (older DBs). Legacy rows keep `file_sha256=""` = hash-unverified
  but receivable; legacy per-member v1 rows keep per-row behavior.
- Snapshots: one immutable copy `files/sent/<file_id>/<sanitized>` shared
  across the whole group fan-out (hash computed in the same single pass).
  Each batch file owns its snapshot. Local delete removes the sender row +
  its `file_deliveries` + `file_received_chunks` + matching outqueue rows +
  the matching `seen_messages` row (fixes un-re-receivable files), then
  unlinks the snapshot only when `count_file_path_references(path) == 0`
  (also removing the now-empty parent dir).
- Outqueue rows for files carry `message_id = file_id` (+ `group_id` when
  grouped). The generic `flush_outgoing` keeps skipping file packet types;
  the file manager owns all file flushing (avoids double-send).

## 6. Backend (`file_transfer.py`, `__main__.py`)

- `send_file(recipient_id, path, caption="") -> file_id`: DM path. Validate
  (exists, file, 1..50MiB), sanitize name, snapshot + SHA-256 in one pass,
  insert sender row + offer, stream chunks sequentially. Online → offer then
  chunks; send failure → queue remainder + `queued`. Stream finish sets an
  internal `awaiting-ack` state surfaced as `sent` but **not retryable**
  until ACK/timeout (fixes duplicate resend).
- `send_group_file(group_id, file_path, caption="") -> file_id`: one
  `file_id`, one snapshot/hash, one sender row, one `file_deliveries` row
  per eligible member (`pending`), then per-recipient encrypt+offer+stream.
  Aggregate row status recomputed from deliveries: any `transferring/sent`
  → `transferring`; all `completed` (via ACKs only) → `completed`; else
  `queued`/`failed`/`unavailable` by worst-live. Never mark aggregate
  `completed` on stream finish.
- `send_batch(peer|group, [(path, caption)...]) -> batch_id`: shared
  `batch_id`, per-file `file_id`, max 32 entries. Partial per-file errors
  collected, not fatal to the batch.
- Inbound: offer verifies capability/signature/routing/membership/friendship,
  strict v2 decode, `seen_messages` dedupe, preallocate
  `files/<group|sender>/<name>_<created_at>[.<fileid16>]`, insert inbound
  row. Chunks verify → decrypt → size-check → seek-write → record receipt
  (skip already-received) → coalesced progress → completion path with
  whole-file hash check → `FILE_ACK_V2(completed|missing|blocked)`.
  Early chunks (≤8/file, 30 s TTL, ≤64 total) replayed with per-chunk
  try/except; `completed` replays ignored, never raise.
- ACK handling keyed by `(file_id, recipient_id)`: `completed`/`blocked`
  update that delivery + recompute aggregate + emit
  `file_delivered`/`file_blocked`; `missing` validates ranges then resends
  only those chunks to that recipient. Resend catches broad `Exception` →
  mark that delivery `queued` + queue the chunks, never propagate.
- `flush_for_peer(peer_id)`: per-file lock (new; inbound `_packet_locks`
  are not enough — `handle_peer_changed` can overlap flushes). Re-send
  offer if unacked, then **missing ranges only**. Do not delete outqueue
  chunk rows on partial failure. Returns flushed count.
- `retry_file(file_id, recipient_id=None)`: allowed from
  `failed/blocked/queued/unavailable` and `sent`-awaiting-ack only after
  timeout; defaults to failed deliveries; clears stale outqueue rows for
  the retried scope first (existing behavior, keep).
- `resume_for_peer(peer_id)`: completed inbound → re-send completion ACK;
  partial → `missing` request (v2). All v2 sends gated on
  `peer.supports(CAP_FILE_TRANSFER_V2)`.
- `__main__.py` IPC: `file_send {recipient_id, file_path|paths[],
  caption?}`, `group_file_send {group_id, file_path|paths[], caption?}`
  → `{batch_id?, file_id?, results:[{recipient_id, file_id}],
  errors[]}` (legacy single-path shape keeps working);
  `file_retry {file_id, recipient_id?}`; `files {peer_id?, group_id?}`
  includes `deliveries` for group rows; `file_progress` always carries
  `{file_id, received, total_chunks, direction}` in both directions.

## 7. TUI / CLI

- Render key is `file_id`; batch blocks keyed by `batch_id`. Remove the
  `filename|sender|round(created_at)` grouping except as a legacy-v1
  fallback. Receipt label (`delivered x/y · queued z`) comes from backend
  `deliveries`, never synthesized client-side.
- Caption renders as message text attached to the attachment (above the
  filename); batch renders as one block with per-file rows + aggregate
  label; per-recipient detail dialog drives Retry per failed delivery.
- Confirm dialog: snapshot target `{kind, id}` at open, busy guard so
  Send cannot double-submit, no live-selection redirect. Staged drop paths
  uniquified (no basename collisions). Retry visible for
  `failed/blocked/unavailable/queued` (+ timed-out `sent`).
  `isLocalFileMissing` uses `isFile()`, not `existsSync`.
- CLI: `send-file <peer> <paths...> [--caption TEXT]`,
  `group send-file <group> <paths...> [--caption TEXT]`; `files`,
  `download`, and `retry [--recipient]` surface batch/caption/deliveries.

## 8. Security properties (unchanged, must hold)

Ephemeral X25519/AES-GCM per chunk with routing AAD; Ed25519 signatures on
offer/chunk/ack; sanitized names; `files/<id>/` scoping; friend/member +
block parity with `MESSAGE_BLOCKED`; no `file_transfer_v2` → no v2 bytes;
early-chunk TTL/caps; per-peer locks cleaned after unlock; snapshots
`0o600`; no telemetry of filenames/contents.

## 9. Tests (binding acceptance)

- Unit: v2 offer/chunk/ack encode/decode + strict validation (hash, caption
  bytes, batch all-or-none/bounds, `total_chunks ≤ 10000`, no `ack`
  status); capability gate; hash-mismatch → `failed` + one full `missing`
  then `failed`; per-recipient missing resend; batch aggregate transitions.
- Integration: DM send → complete + hash verified + progress events both
  directions; group one-send → one `file_id` + N `file_deliveries`, one
  snapshot, one TUI block; offline queue → reconnect flushes missing-only
  with concurrent-flush safety (no duplicate chunks); legacy v1 rows still
  list/receive; caption round-trips signed; batch partial failure isolates;
  delete clears seen + unlinks snapshot by refcount; `stat`-missing partial
  marks `failed`, never raises.
