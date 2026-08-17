# MeshTalk Design

## Goals

MeshTalk provides direct encrypted messaging in two environments:

1. LAN peers work without internet access or central infrastructure.
2. Remote peers use an opaque control service and STUN only to establish direct
   UDP connectivity.

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

When both paths are authenticated, LAN TCP is active and remote UDP remains a
fallback. The backend reports all known endpoints and marks the active endpoint
through IPC.

## Private Rooms

An invite is:

```text
meshtalk:<128-bit opaque room ID>.<256-bit room secret>
```

Only the room ID is sent to the control service. The room secret derives an
AES-256-GCM key with HKDF-SHA256. Endpoint cards contain:

```text
protocol version
peer ID
Ed25519 public key
public UDP address and port
creation time
random replay nonce
Ed25519 signature
```

The complete signed card is encrypted locally before transmission. Recipients
decrypt it, bind the peer ID to the signing public key, verify the signature,
enforce a short age limit, reject replayed nonces, and only then begin punching.

The control service knows opaque room membership and connection metadata, but
not room secrets, peer identities, endpoint-card contents, or messages.

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
friend request.

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

The screen is a single row: a sidebar (your identity, peer list with presence and
unread indicators) and a conversation pane with a message log and a composer.
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
  room lifecycle and invite generation.
- `debug_re_stun` / `debug_info` — connectivity diagnostics.
- `shutdown` — stop the backend daemon.

## Limitations

- Direct connections may fail with symmetric NAT, blocked UDP, or restrictive
  firewalls.
- There is intentionally no TURN relay, because routing through one would expose
  additional traffic metadata and make remote delivery infrastructure-dependent.
- Anyone holding a room invite can decrypt that room's endpoint cards and attempt
  to connect. Invite distribution and rotation are user responsibilities.
- Direct peers and STUN providers necessarily observe public network endpoints.
- Messages are accepted only from friends; non-friends must first exchange a
  friend request. This prevents unsolicited messaging but also means two peers
  cannot chat until one sends and the other accepts a request.

## Persistence

Fresh MeshTalk state is stored in `~/.meshtalk`:

- `identity.json`: private identity and message-encryption keys, mode 0600
- `settings.json`: control URL and room secrets, mode 0600
- `meshtalk.db`: peer and conversation state
- `meshtalk.sock`: owner-only local IPC socket while the backend runs

Old `~/.lanchat` state is left untouched and is not migrated automatically.
