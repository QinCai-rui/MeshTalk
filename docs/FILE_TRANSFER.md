# File Transfer Protocol

MeshTalk file transfer is **V2-only**. The legacy V1 file capability and packet
family have been removed; current clients never send, accept, queue, resume, or
acknowledge V1 file packets.

## Deprecated / removed

V1 file transfer support was dropped in **v0.32.0**, commit `8677c2d`
(`feat: make file transfer v2-only`). The removed `file_transfer` capability
used `FILE_OFFER` (`0x11`), `FILE_CHUNK` (`0x12`), and `FILE_ACK` (`0x13`).
They are retained here only as historical reference; current clients use the
V2 capability and packet family exclusively.

Persisted pre-V2 inbound rows without `file_sha256` are also historical. Resume
skips them without sending legacy ACKs or chunks; their existing terminal or
partial history is left unchanged.

## Capability and compatibility

`file_transfer_v2` is required for every file-transfer packet:

| Packet | Type | Purpose |
|---|---:|---|
| `FILE_OFFER_V2` | `0x15` | Signed file metadata, SHA-256, caption, batch metadata |
| `FILE_CHUNK_V2` | `0x16` | Per-recipient encrypted file chunk |
| `FILE_ACK_V2` | `0x17` | Signed `completed`, `missing`, or `blocked` acknowledgement |

A new direct send or explicitly targeted retry to a peer that does not
negotiate `file_transfer_v2` fails before a snapshot, database row, or queue
entry is created. IPC returns an upgrade error; TUI and CLI display it rather
than reporting a transfer as started.

For a group, an unsupported member receives an `unavailable` delivery row while
capable members proceed. A group with no capable recipients fails before a
snapshot is created.

## Sending

1. Validate the source: regular file, non-empty, at most 50 MiB.
2. Verify V2 eligibility before copying data.
3. Snapshot the source to `files/sent/<file_id>/<sanitized-name>` and calculate
   SHA-256 in one pass. Snapshots use mode `0600`.
4. Persist one outbound `file_transfers` row. A group has one shared `file_id`
   and one `file_deliveries` row per recipient.
5. Send a signed offer and sequential encrypted chunks to each eligible peer;
   if offline, queue V2 packets encrypted for that recipient.
6. A completed stream is `sent` while awaiting an ACK. Retry is allowed after
   its ACK timeout, or immediately for failed, blocked, queued, and unavailable
   deliveries.

## Receiving and integrity

Offers and chunks require the negotiated V2 capability, valid signatures,
routing, friendship or active group membership, and bounded protocol fields.
Chunks are independently encrypted and authenticated. The receiver records
chunk receipt and, once complete, verifies both file size and SHA-256.

On a first integrity failure the receiver recreates the file, clears recorded
chunks, and sends one full `missing` request. A second failure remains failed.
Successful completion persists the status and sends `FILE_ACK_V2(completed)`.

## Groups, batches, and captions

A group file uses one shared `file_id`, but data is pairwise encrypted and
acknowledged per recipient. Aggregate sender status is derived from delivery
rows: active transfer first, then completed, failed/blocked, queued, and
unavailable. `completed` is set only by completion ACKs.

A batch has one `batch_id`, at most 32 files, and per-file results/errors. The
caption belongs to the first attachment post and is rendered once above the
attachment block.

## Security requirements

- Never send V2 bytes to a peer lacking `file_transfer_v2`.
- Never silently downgrade a new send to an obsolete file protocol.
- Never log plaintext file content, filenames, paths, captions, or endpoint
  card payloads.
- Sanitize filenames and contain local deletes/downloads within the configured
  files directory.
- Download writes use `O_NOFOLLOW` and mode `0600`.
