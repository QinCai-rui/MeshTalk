# MeshTalk Design

## Goals

MeshTalk provides direct encrypted messaging in two environments:

1. LAN peers work without internet access or central infrastructure.
2. Remote peers use an opaque control service and prefer direct STUN-assisted UDP,
   with an embedded DERP fallback for restrictive networks.

The OpenTUI and CLI are local clients of one Python backend. The backend owns
identity, networking, encryption, persistence, and transport selection.

## Connectivity

### LAN path

Every backend broadcasts its peer ID and TCP listener port on UDP port 24890.
The lower peer ID deterministically opens an authenticated TCP connection to
port 24891. This path remains available when the control service or internet is
unavailable.

### Remote path

The backend opens one UDP socket and sends an RFC 5389 binding request to the
configured public STUN server. Using the same socket for STUN, punching, and
peer traffic ensures that the advertised mapping belongs to the actual peer
transport.

Peers remain connected to the control service while they participate in rooms.
They periodically publish encrypted endpoint cards. A changed card causes both
peers to send signed UDP handshakes to the new endpoint, opening compatible NAT
mappings in both directions.

The control service never carries chat messages. It stores one opaque encrypted
card per WebSocket connection and room so a newly joined member can discover
members already online.

### Path selection

LAN TCP has highest priority. For Internet peers, direct UDP has higher priority
than DERP. Direct setup and keepalive health determine whether the relay route is
selected. A confirmed relay remains active for the session; replacing it with a
direct route requires an atomic handoff and is not attempted yet. The backend
reports all known endpoints and marks the active endpoint through IPC.

### Embedded DERP relay

Control embeds a WebSocket relay for already encrypted MeshTalk datagrams. A
client authenticates with its Ed25519 identity and proves room-invite possession
by sending both the room_id and a derived room_auth (HMAC-SHA256 of the room
secret) to control, while the underlying room secret remains client-side. Control
accepts only peer-ID addressed frames between currently authorized members of a
shared room, so it cannot relay arbitrary network traffic. Endpoint cards remain
encrypted and opaque to control and contain direct plus DERP candidates.
Per-device bandwidth and active-peer limits bound relay cost and abuse.

### Capability differences

Peers exchange authenticated capability lists. Each optional packet family is
enabled only when both peers advertise its capability. A missing or unknown
capability disables only that feature; every shared capability continues to
work. Both peers retain the directional difference and show a flashing limited-
capabilities warning without changing connectivity or presence state.

## Private Rooms And Named Groups

An unnamed legacy room invite is:

```text
meshtalk:<128-bit opaque room ID>.<256-bit room secret>
```

A named group uses a distinct, versioned prefix while retaining the room ID and
secret fields:

```text
meshtalk-group:<room ID>.<room secret>.<encrypted group metadata>
```

The third segment is `nonce || AES-256-GCM ciphertext`, encoded as base64url.
Its key is derived from the room secret with HKDF-SHA256 using the room ID as
salt and `meshtalk-group-invite-v1` as info; the room ID is AAD. The encrypted
JSON contains metadata version 1 and the group name. The distinct prefix prevents
stripping the metadata from silently downgrading a group into an unnamed room.
Parsers continue to accept two-segment `meshtalk:` invites as unnamed rooms.

Only the room ID is sent to the control service. The room secret derives an
AES-256-GCM key with HKDF-SHA256. Endpoint cards contain:

```text
peer ID
Ed25519 public key
direct and optional relay UDP candidates
creation time
random replay nonce
Ed25519 signature
```

The complete signed card is encrypted locally before transmission. Recipients
decrypt it, bind the peer ID to the signing public key, verify the signature,
enforce a short age limit, reject replayed nonces, and only then begin punching.

The control service knows opaque room membership and connection metadata, but
not room secrets, peer identities, endpoint-card contents, or messages.

### Group membership and delivery

For a named room, the room ID is also the group ID. Decrypted room cards
from room signals and `get_peers` responses populate a persistent local roster;
the control service does not provide an authoritative identity roster. A card
can add or refresh a member, while a verified `GROUP_LEAVE` marks that member
inactive. Consequently, roster views are cached and may lag room membership.

The `group_chat` capability gates group-message sending and receipt. Sending
fans one signed `GROUP_MESSAGE` envelope out to every active cached member
except the sender.
Each copy is encrypted independently to that member's X25519 key, so there is no
shared group message key. A `GROUP_MESSAGE_ACK` updates that recipient's status
from `sent` (or previously `queued`) to `delivered`; missing keys or capability
produce `unavailable`. Offline members with cached keys receive durable
sender-side queue entries which become `sent` on reconnect.
Cards without a public candidate still populate the roster, allowing LAN group
membership to work when STUN fails. They simply do not initiate UDP punching.

Group authorization is the only exception to friend-only inbound chat. The
receiver requires negotiated `group_chat`, an exact authenticated sender and
recipient match, a locally joined named room, and an active local roster entry.
Traffic that does not pass those checks is rejected; the exception does not
make ordinary non-friend direct messages acceptable.
Locally blocked members are excluded from outgoing fanout and their incoming
group messages are suppressed while their roster entries remain visible.

Group history is local only. Joining does not request or replay prior messages,
and online members do not backfill history to newcomers. Join/leave system rows
reflect local observations. A leave event is signed, replay-checked, persisted
as a local system event by recipients, and queued by the leaver for known
offline group-capable members before local room state is removed.

## Remote UDP Session

An endpoint card authorizes an expected peer ID and network endpoint. UDP
handshakes from any other identity or endpoint are discarded.

Each peer creates an ephemeral X25519 key and random nonce. Its Ed25519 identity
signs the handshake, which includes the ephemeral key and persistent message
encryption key. Both sides derive independent transport encryption and
authentication keys using HKDF-SHA256.

Transmit and receive keys are direction-specific, and a session is not exposed
to the application until each side proves key possession with an authenticated
confirmation. This prevents reflected handshake traffic from confirming a peer.

Application packets are split into datagrams small enough to avoid IP
fragmentation. Every fragment is encrypted with AES-256-GCM and authenticates
its session ID, packet ID, fragment index, and fragment count. Complete packets
receive authenticated acknowledgements. Missing acknowledgements trigger
bounded retransmission; duplicate packet IDs are acknowledged but not delivered
again. Authenticated keepalives preserve mappings and expire dead sessions.

The existing packet protocol and end-to-end message envelope run above both TCP
and reliable UDP transports.

## Identity And Messages

Each installation has a persistent Ed25519 signing identity and a separate
X25519 message-encryption key. The peer ID is SHA-256 of the Ed25519 public key.

Messages use a one-time ephemeral X25519 key and AES-256-GCM. Immutable routing
metadata is authenticated by both the encrypted envelope and the sender's
Ed25519 signature. The direct transport supplies an additional independent
authenticated encryption layer.

## Control Service

The Bun control service supports only these operations:

- Join an opaque room ID.
- Leave an opaque room ID.
- Broadcast and retain an opaque encrypted blob for that connection and room.

It validates sizes, limits room membership, limits rooms per connection, and
rate-limits messages. It does not parse encrypted payloads. Production
deployments use `wss://`; localhost development may use `ws://`.

A malicious control service can observe source IPs, correlate timing and room
membership, omit cards, replay encrypted cards, or deny service. Age checks,
nonce replay checks, signatures, and endpoint-bound UDP handshakes prevent it
from decrypting cards or impersonating peers.

## Social Graph

MeshTalk is friend-oriented: the backend accepts incoming direct messages only
from peers on the local friend list. A message from a non-friend is rejected and
answered with a short blocked notice, so an unknown peer can neither deliver a
message nor probe content. The only inbound channel from an unknown peer is a
friend request, except for strictly authorized group packets described above.

### Friend requests

A friend request is a signed, transport-delivered packet (not a chat message).
The lifecycle is:

- `friend_send` issues an outgoing request to a `peer_id`, optionally with a note.
  It is rejected if the peer is already a friend, is blocked, or already has a
  pending request.
- The recipient receives a desktop notification and an IPC event. `friend_requests`
  lists pending requests; `friend_respond` accepts or declines by `request_id`.
  Accepting adds both peers to each other's friend list.
- `friend_cancel` revokes an outgoing pending request before it is answered.
- `unfriend` removes a peer from the friend list; it does not block them.

Friend state lives in the local database and is never shared with the control
service.

### Blocking

`block_peer` records a one-directional block for a `peer_id`. Blocked peers
cannot send friend requests or messages (their traffic is dropped with a blocked
notice), and they are hidden from the active conversation surface. `blocked_peers`
lists the current blocks and `unblock_peer` removes one. Blocking is independent
of the friend list: a former friend can be blocked, and a block can be lifted
without re-friending.

## File Transfer

File transfer sends binary files (up to 50 MiB) directly between peers using
the same E2EE envelope as messages. Files are chunked into encrypted pieces
(MAX_FILE_CHUNK_SIZE = 28 KiB plaintext), sent as `FILE_CHUNK` packets, and
reassembled by the receiver. The `file_transfer` capability is required on both
peers.

The flow is:

1. Sender reads the local file, computes chunk parameters, and sends a signed
   `FILE_OFFER` containing file metadata (filename, size, chunk count).
2. Receiver auto-accepts and emits a `file_offer` IPC event for TUI display.
   Incoming files are stored in `~/.meshtalk/files/<file_id>/`.
3. Sender sends `FILE_CHUNK` packets in order, each individually E2EE with a
   fresh ephemeral X25519 key (forward secrecy per chunk).
4. Receiver decrypts, reassembles by `(file_id, chunk_index)`, and writes to
   disk. Completion emits `file_completed` with the local path.
5. Receiver sends a signed `FILE_ACK` (status `completed` or `partial` with
   `missing_ranges`). Sender marks `delivered` on receipt.

Offline transfers are queued in the outgoing queue (identical to message
queueing) and flushed on reconnect via `flush_for_peer`. Partial transfers
support resume: `resume_for_peer` detects incomplete transfers and sends
`FILE_ACK` with `missing_ranges` so the sender retransmits only missing chunks.

Group file transfers use the same protocol with `group_id` set. The offer is
fanned out to every active cached group member. Each recipient independently
decrypts and stores the file. Offline group members with cached encryption keys
receive durable queue entries.

Security properties:

- Each chunk is individually E2EE with a fresh ephemeral key (forward secrecy).
- Filenames are sanitized on both sender and receiver (path traversal prevention).
- File storage is scoped to `~/.meshtalk/files/<file_id>/`.
- Early-chunk buffer has a TTL (30 s) and per-file cap (8 chunks) to bound
  memory from out-of-order arrivals.
- Incoming file offers from non-friends (direct) or non-members (group) are
  rejected.
- Packet locks are cleaned up after unlock to prevent resource leaks.

## Presence And Notifications

Each connected TUI client reports its focus through `tui_presence` (`active`
true/false, scoped to a `client_id`). The backend aggregates all TUI clients:

- `active` — at least one TUI client is focused and connected.
- `away` — the peer is connected but no TUI client is active.
- `offline` — no connection at all.

Presence is reported per peer in `peers` and is used to decide whether a desktop
notification should be raised for an incoming event.

Mute is a per-peer preference stored in settings (`muted_peers`): a muted peer's
desktop notifications are suppressed while delivery and history are unaffected.
`mute` / `unmute` toggle it and `muted_peers` returns the current set.

## Display Name

Each installation has a persistent, user-chosen display name (maximum 48
characters, no control characters). It is advertised in LAN discovery beacons and
peer protocol handshakes so other peers can label the identity without a trusted
directory. `set_display_name` updates it at runtime; the change propagates to
peers on the next discovery/endpoint refresh.

## Diagnostics

The Debug surface exposes live connectivity state without leaving the TUI.

- `debug_re_stun` re-issues the STUN binding request and republishes endpoint
  cards, forcing NAT remapping refresh and re-handshaking with known peers.
- `debug_info` returns `public_endpoint`, the `stun_server`, the local TCP port,
  room status, and a per-peer breakdown (`display_name`, `is_online`, and the
  network info: discovered endpoints and their transport).
- The Endpoints view groups peers by transport: `lan_tcp` (local) and
  `remote_udp` (remote), making path selection visible.

## OpenTUI Client

The TUI is a local React (React 19 over `@opentui/react`) client of the Python
backend. It talks to the backend exclusively over the owner-only Unix-domain IPC
socket (`meshtalk.sock`) using a request/response protocol with event streaming.

The screen is a single row: a sidebar (your identity, peer and group lists with
presence/unread indicators) and a conversation pane with a message log and a
composer.
Above this sits a modal dialog layer rendered as an absolutely-positioned,
centered, bordered overlay.

### Dialog model

A single `dialog` state is a discriminated union covering `commands`, `control`,
`rooms`, `friends`, `mute`, `rename`, `debug`, `debug-endpoints`, `debug-peer`,
and confirmation sub-dialogs. Each case renders its own form or `select` list
inside the shared overlay. The root `Commands` palette navigates into the others
and every sub-dialog offers a "Back to commands" path.

### Layout and sizing conventions

The overlay is sized to `dialogHeight = min(20, terminalHeight - 4)` and a
per-kind width. The dialog box is **never** resized to fit its contents; it stays
fixed so the surrounding layout is stable.

Scrollable lists inside a dialog (the `select` component) are sized as
`height = min(visibleRows, max(1, dialogHeight - reserved))`, where `reserved`
accounts for the text lines and gaps above the list. When the terminal is too
short the list scrolls internally rather than clipping. Because each option
renders two rows (name + description) under `showDescription`, a menu that must
show all of its N options at once needs a row budget of `2 * N` (for example, a
four-option menu uses `8` rows, not `4`).

## IPC API

The backend exposes the following IPC commands over the local socket. All take
and return JSON; responses are correlated by request id, and asynchronous events
(incoming messages, peer changes, friend requests) are pushed to subscribers.

- `send` — send an end-to-end encrypted message to a peer.
- `peers` — list known peers with presence, friend, block, and unread state.
- `remove_peer` — forget a peer from local state.
- `messages` — query conversation history with a peer.
- `identity` — return the local peer id, display name, and setup state.
- `status` — connection, STUN, and control-service status.
- `set_display_name` — rename the local identity.
- `friend_send` / `friend_respond` / `friend_cancel` — friend-request lifecycle.
- `friends` / `friend_requests` — list friends and pending requests.
- `unfriend` — remove a friend.
- `block_peer` / `unblock_peer` / `blocked_peers` — one-directional blocks.
- `mute` / `unmute` / `muted_peers` — per-peer notification muting.
- `tui_presence` / `tui_disconnect` — report or clear TUI focus.
- `control` — inspect or configure the control service URL and STUN server.
- `room_create` / `room_join` / `room_leave` / `room_invite` / `rooms` — private
  room lifecycle and invite generation; `room_create` takes a group name.
- `groups` / `group_members` / `group_messages` — list local groups, cached
  active rosters, and local history.
- `group_send` / `group_leave` — send to or leave a named group.
- `file_send` / `group_file_send` — send a file to a direct peer or to all active group members.
- `files` / `file_info` — list all file transfers or query one transfer's metadata.
- `file_download` — save a received file to a user-chosen location.
- `files_dir` / `set_files_dir` — get or set the files storage directory.
- `debug_re_stun` / `debug_info` — connectivity diagnostics.
- `shutdown` — stop the backend daemon.

## Limitations

- Direct connections may fail with symmetric NAT, blocked UDP, or restrictive
  firewalls.
- MeshTalk Relay is optional and introduces relay metadata visibility and
  bandwidth cost. Operators should configure its enable switch, quotas, and
  monitor relay egress usage.
- Anyone holding a room invite can decrypt that room's endpoint cards and attempt
  to connect. Invite distribution and rotation are user responsibilities.
- Direct peers and STUN providers necessarily observe public network endpoints.
- Messages are accepted only from friends for direct chat. Authorized
  room-backed group traffic is the narrow exception.
- There are no group administrators, member revocation, invite rotation,
  history replay, or authoritative synchronized rosters.
- Group encryption is pairwise fan-out. Sender keys, group key agreement,
  forward-secure group epochs, and post-compromise security are not implemented.

## Persistence

Fresh MeshTalk state is stored in `~/.meshtalk`:

- `identity.json`: private identity and message-encryption keys, mode 0600
- `settings.json`: control URL, room secrets, and files directory, mode 0600
- `meshtalk.db`: peer and conversation state, file transfer records
- `meshtalk.sock`: owner-only local IPC socket while the backend runs
- `files/`: received files stored in `<file_id>/` subdirectories
