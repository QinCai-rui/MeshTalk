# MeshTalk Protocol Specification

This document describes how MeshTalk works: its components, identity model,
local-area (LAN) transport, remote NAT-traversed transport, end-to-end
encryption, the opaque control (rendezvous) service, the social layer
(friends/blocking/profiles), and the local IPC API used by the TUI and CLI.

It is written for implementers and security reviewers alike. Where the running
code differs from the design intent, the *implemented* behavior is described
first and the gap is called out. A dedicated "Planned / Not Yet Wired" section
lists features that exist in the design or code scaffold but are not yet active.

NOTE: All key agreement uses X25519 (Curve25519), which is vulnerable to
Shor's algorithm. Captured traffic may be decryptable by a future quantum
computer ("store now, decrypt later"). See Threat Model.

## 1. System Overview

MeshTalk is a peer-to-peer encrypted messenger. Chat never traverses any
central server. There are two independent data paths between two peers:

1. LAN path - offline, zero-infrastructure. UDP broadcast discovers peers; an
   authenticated TCP connection carries traffic.
2. Remote path - when peers are not on the same LAN, an *opaque* control
   service relays only encrypted "endpoint cards" for discovery, and STUN is
   used to learn public NAT mappings. The peers then punch a direct, encrypted
   UDP session. The control service never sees chat, message metadata, or
   endpoint-card contents.

A single Python backend owns identity, networking, encryption, persistence, and
transport selection. The OpenTUI and CLI are thin local clients that talk to
the backend over a local IPC socket. A separate Bun control service provides
only the rendezvous (signaling) function.

```
OpenTUI / CLI
      |
   local IPC  (Unix socket or loopback TCP, token-auth)
      |
Python backend ---- LAN broadcast (UDP 24890) + TCP (24891) ---- LAN peers
      |
      +-- encrypted endpoint cards --> control service (WebSocket)
      |
      +-- STUN + reliable encrypted UDP --> remote peers
```

### 1.1 Components

| Component | Language | Responsibility |
|-----------|----------|----------------|
| backend/ (Python) | Python 3 + asyncio + cryptography | Identity, discovery, LAN TCP, remote UDP transport, E2EE, persistence, IPC server, rendezvous client. |
| control/ (Bun) | TypeScript (Bun) | Opaque WebSocket rendezvous: join/leave rooms, retain & broadcast one encrypted blob per connection per room, rate limits. Does not parse blobs. |
| tui/ (OpenTUI) | TypeScript (React) | Interactive terminal UI. Talks only to the backend over IPC. |
| cli/ | TypeScript (Bun) | Scriptable commands (send, peers, status, room, ...). Talks only to the backend over IPC. |
| common/ipc-client.ts | TypeScript | Shared IPC client (connect, authenticate, request/response, events). Used by TUI and CLI. |

## 2. Identity and Keys

Each installation has two long-lived keypairs (backend/meshtalk/identity.py):

| Key | Algorithm | Purpose |
|-----|-----------|---------|
| Signing identity | Ed25519 | Authenticates the peer in every handshake, endpoint card, message, and social packet. Never used to encrypt. |
| Message-encryption key | X25519 | End-to-end encryption of message content (one-time ephemeral ECDH). |

- Peer ID = SHA-256(Ed25519 public key) encoded as a 64-character hex string.
  It is the canonical, stable identifier for a peer and is derivable from the
  public signing key by anyone (it is not secret).
- Display name is a UTF-8 string, 1-48 characters, no control characters
  (C0/C1 and DEL rejected). Defaults to "Anonymous".
- Private material is stored in ~/.meshtalk/identity.json, version: 2, file
  mode 0600. Loading an older (X25519-only, unauthenticated) identity format
  returns None, forcing regeneration, because it cannot prove identity.

```python
# identity.generate()
signing_private_key = Ed25519PrivateKey.generate()
peer_id = sha256(signing_public_key_raw).hexdigest()   # 64 hex chars
encryption_private_key = X25519PrivateKey.generate()
```

A local storage key is derived (never the raw key) for at-rest DB encryption
material:

```
storage_key = HKDF-SHA256(
    ikm  = X25519 encryption private key (raw),
    salt = peer_id,
    info = b"meshtalk-local-storage-v1",
    len  = 32,
)
```

## 3. Local State & Persistence

Fresh state lives in ~/.meshtalk:

| File | Mode | Contents |
|------|------|----------|
| identity.json | 0600 | Signing + encryption private keys, peer ID, display name. |
| settings.json | 0600 | Control URL, STUN server, room secrets and group names, muted peers. |
| meshtalk.db | - | SQLite: peers, direct/group messages, cached group rosters and deliveries, outgoing queue, seen IDs, friend relationships, config. |
| meshtalk.sock | 0600 | Owner-only Unix-domain IPC socket while the backend runs (TCP fallback on Windows). |
| meshtalk.port | 0600 | Loopback TCP port when the Unix socket is unavailable. |
| meshtalk.token | 0600 | Random per-backend IPC auth token. |

## 4. LAN Path (Offline, Zero Infrastructure)

### 4.1 Discovery (backend/meshtalk/discovery.py)

- A DiscoveryService opens a UDP socket on port 24890 with SO_BROADCAST enabled.
- Every 3 seconds it broadcasts a JSON discovery packet to 255.255.255.255:24890:

  ```json
  { "protocol": 1, "discovery_id": "<32 hex chars>", "tcp_port": 24891 }
  ```

- discovery_id is secrets.token_hex(16) generated per backend run. It is
  intentionally NOT derived from the signing key, so LAN broadcasts cannot be
  used to track a peer across restarts.
- On receipt, a peer ignores its own discovery_id, ignores mismatched protocol
  versions, and records (source_ip, tcp_port). It then triggers a connection
  attempt.
- Hardening: bounded known-address table (MAX_KNOWN_ADDRESSES = 512), bounded
  pending queue (128), and DISCOVERY_WORKERS = 4 worker tasks parse packets off
  the I/O path.

### 4.2 LAN TCP Transport (backend/meshtalk/peer_manager.py)

- Each backend listens for TCP on port 24891 (0.0.0.0).
- Deterministic initiation: the peer with the lexicographically smaller peer ID
  opens the connection (_should_initiate => self.peer_id < remote_peer_id).
  Because discovery IDs are anonymous, both sides may dial; once authenticated,
  only the lower-ID direction is retained to deduplicate.
- Framing (shared with the UDP-carried application protocol):

  ```
  [ 4-byte big-endian length ][ 1-byte type ][ payload ]
  HEADER = "!IB"   # length: uint32 BE, type: uint8
  MAX_PACKET_SIZE = 64 KiB
  ```

### 4.3 LAN TCP Handshake

Authenticates identity with signed HandshakePayloads (no transport encryption
on the link - see caveat below).

```
Outbound (initiator)                        Inbound (responder)
--------------------------------           --------------------------------
HANDSHAKE      (nonce=rand32, challenge="") --> 
                              <-- HANDSHAKE_ACK (nonce=rand32, challenge=initiator.nonce)
HANDSHAKE_CONFIRM (challenge=ack.nonce)    --> 
```

- Each HandshakePayload carries: peer_id, signing_public_key (32 B),
  encryption_public_key (32 B), display_name, nonce (32 B), challenge,
  protocol_version, min_protocol_version, capabilities (string list), and an
  Ed25519 signature over the canonical (sorted, compact) JSON of the
  non-signature fields. For protocol version 1 the signature canonical covers
  only the six base fields (peer_id, signing_public_key, encryption_public_key,
  display_name, nonce, challenge) so that v1 stays byte-compatible with prior
  releases; `protocol_version`, `min_protocol_version` and `capabilities` are
  only folded into the signed canonical once a connection negotiates a version
  above 1.
- _apply_handshake verifies:
  1. peer_id == SHA-256(signing_public_key) (binds ID to key),
  2. challenge matches the expected value from the prior step (prevents a
     reflected/relay handshake from confirming a session),
  3. protocol versions are mutually compatible via range negotiation (see §4.3.1),
  4. the Ed25519 signature is valid.
- Timeouts: HANDSHAKE_TIMEOUT = 10 s, MAX_PENDING_HANDSHAKES = 64,
  MAX_CONNECTED_PEERS = 256.

#### 4.3.1 Version & Capability Negotiation (LAN TCP)

The same algorithm used in the UDP transport (§6.2) applies here. Each
HandshakePayload includes a `protocol_version` and `min_protocol_version`.

```
agreed_version = min(local.protocol_version, remote.protocol_version)
min_required   = max(local.min_protocol_version, remote.min_protocol_version)
if agreed_version < min_required → reject with IncompatibleProtocolError
                                   + broadcast peer_version_mismatch IPC event
```

**Legacy (v0) compatibility.** A peer that omits `protocol_version` from its
handshake is treated as version 0 with `min_protocol_version` 0. This is
detected by `HandshakePayload.decode()` checking for the presence of the
`protocol_version` key in the raw JSON. The minimum supported protocol version
is now `2` (`MIN_SUPPORTED_PROTOCOL_VERSION`), so a peer advertising a version
below `2` (including legacy peers that omit the field, treated as v0) is
incompatible. Rather than dropping the connection, the handshake is allowed to
complete and a `peer_version_mismatch` IPC event is broadcast; the connection is
kept but feature behaviour may be degraded. The mismatch is recomputed from each
handshake, so the warning naturally reappears after a restart once the peer
reconnects.

`capabilities` is a list of feature strings (`text_chat`, `profile_sync`,
`friend_requests`, `delivery_receipts`, `block_reports`, `group_chat`). The
agreed capability set is the **intersection** of both peers' advertised sets
(unknown capabilities are ignored), and higher-level code gates behaviour on
it: `delivery_receipts`
enables `MESSAGE_ACK`, `block_reports` enables `MESSAGE_BLOCKED`, `profile_sync`
enables presence/display-name updates, `friend_requests` enables the
friend-request packet family, and `group_chat` enables the group packet family.
A peer that does not advertise a capability will not be sent the corresponding
packets. Handshakes that omit capabilities receive the legacy set, which excludes
`group_chat`, preventing new group packets from being sent to older clients.

TRANSPORT-SECURITY CAVEAT (important). On the LAN TCP path, the link itself is
NOT encrypted by a separate transport layer. The handshake and every
application packet are authenticated (signed by Ed25519), and message content
is end-to-end encrypted (section 7). However, routing metadata (peer IDs,
packet types) on the LAN TCP link is visible in cleartext to an on-link
observer. Per TODO.md, "Transport/session encryption for every TCP connection"
is NOT yet implemented; the remote UDP path DOES add a full
authenticated-encryption transport (section 6). Treat the LAN path as
authenticated-but-not-link-encrypted until that work lands.

## 5. Remote Path - Control, STUN, and Encrypted UDP

### 5.1 Private Rooms and Invites (backend/meshtalk/settings.py)

A private unnamed room is created locally:

```
room_id = 16 random bytes     # 128-bit opaque routing ID
secret  = 32 random bytes     # 256-bit room secret
invite  = "meshtalk:" + base64url(room_id) + "." + base64url(secret)
```

Example: meshtalk:AbCd...xQ.EF12...9w

- Only room_id is ever sent to the control service. The secret never leaves the
  client and is required to derive the card-encryption key.
- Anyone holding the full invite can decrypt that room's endpoint cards and
  attempt connection. Invite distribution/rotation is the user's
  responsibility.

A named group is a room whose invite uses a distinct prefix and encrypted third
segment:

```
invite = "meshtalk-group:" + base64url(room_id) + "." + base64url(secret)
       + "." + base64url(nonce12 || encrypted_metadata)

metadata_key = HKDF-SHA256(secret, salt=room_id,
                           info=b"meshtalk-group-invite-v1", len=32)
encrypted_metadata = AESGCM(metadata_key).encrypt(
    nonce12, {"version":1,"group_name":"..."}, aad=room_id)
```

The group ID equals the room ID. Group names are 1-64 characters after trimming
and reject ASCII controls.
Two-segment `meshtalk:` invites remain valid and produce unnamed rooms without
group-chat state. The distinct prefix prevents metadata stripping from silently
downgrading an existing group. The complete three-segment invite remains secret;
the control service sees neither the name nor the metadata key.

### 5.2 Room Key and Endpoint Cards (backend/meshtalk/rendezvous.py)

The room secret derives an AES-256-GCM key via HKDF:

```
room_key = HKDF-SHA256(
    ikm  = secret (32 B),
    salt = room_id,                 # the 16-byte room id
    info = b"meshtalk-control-room-v1",
    len  = 32,
)
```

An endpoint card advertises room membership and, when available, a public UDP
address. It is built, signed,
then encrypted locally before being sent to the control service:

```json
{
  "version": 2,
  "kind": "endpoint",
  "peer_id": "<64 hex>",
  "signing_public_key": "<64 hex>",
  "candidate": { "host": "<ipv4>", "port": 12345 } | null,
  "created_at": 1700000000,
  "nonce": "<32 hex>",
  "signature": "<128 hex>"
}
```

- Encryption: nonce12 = os.urandom(12); ct = AESGCM(room_key).encrypt(nonce12,
  json_bytes, aad=room_id); the wire blob is base64url(nonce12 || ct).
- Decryption & validation (decrypt_endpoint_card):
  1. AES-GCM decrypt with aad = room_id;
  2. version == 1 and kind == "endpoint";
  3. peer_id == SHA-256(signing_public_key);
  4. card age |now - created_at| <= CARD_MAX_AGE (180 s);
  5. when a candidate is present, its host is a global,
     non-multicast/unspecified/reserved/link-local IPv4 (loopback only allowed
     with allow_loopback);
  6. Ed25519 signature over the card body is valid.
- Replay protection: (room_id, peer_id, nonce) is remembered for CARD_MAX_AGE;
  duplicates are dropped.
- Endpoint binding: when a HELLO arrives later, its source IP must match the
  introduced candidate address (section 6.2), preventing a control service from
  redirecting a peer to an attacker endpoint.

A changed candidate causes both peers to send signed UDP handshakes to the new
endpoint, opening compatible NAT mappings in both directions.

### 5.3 Control Service Protocol (control/src/index.ts)

WebSocket endpoint /v1/rendezvous. Production must use wss:// (the backend
rejects ws:// for any non-localhost host). The control service:

- Stores one opaque blob per (WebSocket connection, room_id).
- Broadcasts a signal to other room members on receipt.
- On join, immediately sends each existing member's retained signal to the
  joiner (so late joiners discover already-online members).
- Replies get_peers with every retained blob in the room.
- Never parses the blob contents.

Client to server messages:

| type | Fields | Notes |
|------|--------|-------|
| join | room_id (32 hex) | Join a room; triggers roster sync. |
| leave | room_id | Drop the retained blob for that room. |
| signal | room_id, payload (base64 card, <= 8 KiB) | Publish/replace this connection's card. |
| get_peers | room_id | Fetch all retained cards. |

Server to client messages:

| type | Fields |
|------|--------|
| joined | room_id, member_count |
| refresh | room_id, member_count |
| signal | room_id, payload |
| peers | room_id, payloads: string[] |
| error | error (then socket closed, code 1008) |

Limits & abuse controls:

- ROOM_ID = /^[a-f0-9]{32}$/; MAX_ROOM_MEMBERS = 64; MAX_ROOMS_PER_CLIENT = 32;
  MAX_ROOMS = 10_000.
- MAX_CONNECTIONS = 10_000; MAX_CONNECTIONS_PER_IP = 32.
- MAX_RETAINED_BYTES = 64 MiB total; MAX_SIGNAL_LENGTH = 8 KiB.
- Rate limits (per connection AND per source IP, rolling 60 s windows): 96
  control messages, 64 signals, 30 peer fetches.
- GET /health returns { status, rooms, connections }.
- The control client sends WebSocket pings every CONTROL_PING_INTERVAL = 5 s
  with CONTROL_PING_TIMEOUT = 5 s; reconnect uses exponential backoff capped at
  CONTROL_RECONNECT_MAX_DELAY = 30 s.

### 5.4 STUN (backend/meshtalk/udp_transport.py)

- The backend opens one UDP socket and uses it for STUN, hole punching, and
  peer traffic (so the advertised mapping belongs to the real transport).
- It sends an RFC 5389 Binding Request (0x0001, magic cookie 0x2112A442,
  12-byte transaction ID) to the configured server (default
  stun.l.google.com:19302, override via MESHTALK_STUN_SERVER=host:port or
  settings).
- parse_stun_response validates the response (0x0101), matches the transaction
  ID, and extracts XOR-MAPPED-ADDRESS (0x0020) or MAPPED-ADDRESS (0x0001),
  supporting IPv4 (and IPv6) and XOR decoding.
- The resulting (ip, port) is the peer's public endpoint, re-announced to
  rooms whenever it changes (REFRESH_INTERVAL = 30 s STUN loop;
  PEER_FETCH_INTERVAL = 120 s roster refresh).

### 5.5 NAT Hole Punching

- Each peer publishes its public endpoint card to the room. On receiving a
  peer's card, the backend calls udp.expect_peer(peer_id, endpoint), starting a
  punch loop that sends signed HELLO datagrams to the endpoint every 0.4 s (up
  to 20 attempts), and simultaneously sends authenticated READY frames once a
  session exists.
- Because both peers punch to each other's real public address, and the same
  socket is used for STUN and traffic, compatible NATs open mappings in both
  directions.

## 6. Remote UDP Transport (backend/meshtalk/udp_transport.py)

This is the only path that adds a full authenticated-encryption transport on
top of the application protocol. It is reliable (fragmentation + ACK +
retransmission + keepalives) and confidential/authenticated per-direction.

### 6.1 Constants

| Name | Value | Meaning |
|------|-------|---------|
| MAGIC | b"MTU1" | Datagram prefix. |
| STUN_COOKIE | 0x2112A442 | RFC 5389 magic; also used to spot STUN datagrams. |
| FRAGMENT_SIZE | 950 | Max plaintext per fragment. |
| MAX_DATAGRAM_SIZE | 1200 | Max inbound datagram accepted. |
| RETRY_INTERVAL | 0.45 s | Between retransmission rounds. |
| MAX_RETRIES | 10 | Give up after this many rounds. |
| SESSION_TIMEOUT | 12 s | No traffic => drop session. |
| EXPECTED_PEER_TIMEOUT | 600 s | Keep an introduced endpoint without a live session. |
| MAX_SESSIONS | 256 | Concurrent confirmed/unconfirmed sessions. |
| MAX_ATTEMPTS | 128 | Concurrent punch attempts. |
| MAX_EXPECTED_PEERS | 512 | Introduced endpoints tracked. |

### 6.2 Handshake - HELLO (type 1)

```
MAGIC || 0x01 || <json hello>
```

JSON hello (canonical, then Ed25519-signed):

```json
{
  "version": 1,
  "min_version": 1,
  "capabilities": ["text_chat", "profile_sync", "friend_requests", "delivery_receipts", "block_reports", "group_chat"],
  "peer_id": "<64 hex>",
  "display_name": "...",
  "signing_public_key": "<64 hex>",
  "encryption_public_key": "<64 hex>",
  "session_public_key": "<64 hex>",
  "nonce": "<64 hex>",
  "signature": "<128 hex>"
}
```

_handle_hello verifies: peer_id == SHA-256(signing key); mutually compatible protocol version (negotiated version = min(local.version, remote.version) >= max(local.min_version, remote.min_version)); all keys + nonce are 32 B and signature is 64 B; the source IP matches the expected/introduced endpoint (or is a fresh, un-introduced attempt that is later accepted); and the Ed25519 signature is valid. Incompatible protocol versions trigger a `peer_version_mismatch` IPC notification.

#### Protocol Version & Capability Negotiation
During the handshake, peers exchange their maximum protocol `version`, their `min_version`, and a list of supported `capabilities`. 

- **Version Resolution**: The connection operates at the highest mutually supported version: `agreed_version = min(local.version, remote.version)`. If `agreed_version` is less than `max(local.min_version, remote.min_version)`, the authenticated transport remains connected in quarantined mode for keepalives and diagnostics, while application packets are disabled.
- **Supported Capabilities**:
  - `text_chat`: Exchange text messaging packets.
  - `profile_sync`: Exchange display name and active status updates.
  - `friend_requests`: Send, accept, or cancel friend requests.
  - `delivery_receipts`: Acknowledge message delivery (`MESSAGE_ACK`).
  - `block_reports`: Report message blocking status (`MESSAGE_BLOCKED`).
  - `group_chat`: Exchange `GROUP_MESSAGE`, `GROUP_MESSAGE_ACK`, and
    `GROUP_LEAVE` packets for mutually joined named rooms.

### 6.3 Session Key Derivation

```
shared  = X25519(local_ephemeral_private, remote_session_public)
local_first = (self.peer_id < remote_peer_id)
salt    = local_nonce || remote_nonce   if local_first else remote_nonce || local_nonce
material = HKDF-SHA256(ikm=shared, salt=salt, info=b"meshtalk-udp-session-v1", len=128)
session_id = SHA-256(material || b"session-id")[0:8]

first_to_second = (material[0:32],  material[32:64])   # (enc, auth)
second_to_first = (material[64:96], material[96:128])
if local_first:
    transmit = first_to_second ; receive = second_to_first
else:
    transmit = second_to_first ; receive = first_to_second
```

Each direction gets an encryption key (AES-256-GCM) and a separate
authentication key (HMAC-SHA256, truncated to 16 B) for control frames. Keys are
direction-specific, providing independent confidentiality and integrity each
way.

### 6.4 Key Confirmation (READY, type 6)

A session is NOT exposed to the application until both sides prove key
possession. When a session object is created, the receiver immediately sends an
authenticated READY. The peer sets confirmed = True only upon receiving a valid
READY (HMAC-authenticated with the receive auth key). This prevents a reflected
handshake from confirming a peer. Once confirmed, on_connected fires and the
session becomes the active transport.

### 6.5 Data, Fragmentation, and ACK

Application packets (the same Packet framing as section 4.2) are fragmented to
stay under MTU and avoid IP fragmentation:

```
DATA header = "!4sB8sQHH12s"
              MAGIC, type=DATA(2), session_id(8B), message_id(8B),
              fragment_index(uint16), fragment_count(uint16), nonce(12B)
ciphertext = AESGCM(transmit_encryption_key).encrypt(nonce, fragment, aad=DATA_header)
```

- fragment = frame[offset : offset+950]; message_id = random 64-bit.
- On receipt, the fragment is AES-GCM decrypted (AAD = header), reassembled by
  (session_id, message_id), and once complete the reassembled Packet is
  dispatched. fragment_count must be 1..MAX_FRAGMENTS.
- Acknowledgement: ACK (type 3) = AUTH_HEADER("!4sB8sQ") ||
  HMAC-SHA256(transmit_auth_key, header)[:16]. The sender keeps an acknowledged
  event per (session_id, message_id) and retransmits the whole datagram set up
  to MAX_RETRIES times at RETRY_INTERVAL.
- Duplicate suppression: received message_ids are recorded in session.seen;
  duplicates are ACKed but not re-delivered. Seen / reassembly state is
  garbage-collected in the maintenance loop.
- Keepalives: PING/PONG (types 4/5) and READY/GOODBYE (6/7) use the
  authenticated header. The maintenance loop (every 5 s) sends PING and drops
  sessions idle longer than SESSION_TIMEOUT.

### 6.6 Path Selection

When a peer is reachable on both LAN TCP and remote UDP, the LAN TCP connection
is the active transport and remote UDP is a fallback
(peer_manager._on_udp_connected only promotes a UDP session to active if no LAN
session is connected). The backend reports all known endpoints and marks the
active one via IPC (get_network_info).

## 7. End-to-End Message Envelope (backend/meshtalk/encryption.py, protocol.py)

Message content is encrypted independently of the transport, so it is
confidential even on the (currently un-link-encrypted) LAN TCP path.

### 7.1 Encryption (encrypt_for_recipient)

```
ephemeral_private = X25519PrivateKey.generate()
shared = HKDF-SHA256(ikm = ephemeral_private.exchange(recipient_X25519_public),
                     salt = None, info = b"meshtalk-e2ee-v1", len = 32)
nonce = os.urandom(12)
ct = AESGCM(shared).encrypt(nonce, plaintext, associated_data)
wire = ephemeral_public(32) || nonce(12) || ct
```

Decryption recovers the ephemeral key from the first 32 bytes and derives the
same shared secret. Forward secrecy: each message uses a fresh ephemeral key.

### 7.2 Routing Metadata & Authentication (MessagePayload)

```json
{
  "message_id":   "<uuid>",
  "sender_id":    "<64 hex>",
  "recipient_id": "<64 hex>",
  "created_at":   <unix float>,
  "expires_at":   <unix float>,
  "hop_count":    0,
  "max_hops":     0,
  "encrypted_content": "<hex>",
  "signature":    "<128 hex>"
}
```

- Associated data (AAD) = canonical JSON of the immutable routing fields
  (message_id, sender_id, recipient_id, created_at, expires_at). This binds the
  ciphertext to its routing metadata.
- Signature = Ed25519 over SHA-256(associated_data || encrypted_content). The
  sender's signature authenticates both the metadata and the ciphertext and is
  verified against the authenticated peer's signing key on receipt.
- Limits: MAX_MESSAGE_CONTENT_SIZE = 30 KiB; MESSAGE_EXPIRY = 86400 s.
- Direct delivery: hop_count == max_hops == 0. (Multi-hop relay exists in the
  design/scaffold but is NOT wired - see section 12.)

### 7.3 Delivery and ACK

On receipt, message_router._handle_message enforces: sender_id ==
authenticated peer_id; recipient is a friend (else a signed MESSAGE_BLOCKED is
returned and the message dropped); not expired; hop_count == max_hops == 0; not
already seen; valid Ed25519 signature; successful decryption. The receiver then
persists the message, sends a MESSAGE_ACK carrying the message_id, and emits an
IPC "message" event. The sender marks delivery on the ACK.

### 7.4 Store-and-Forward (Offline Queueing)

MeshTalk is fully peer-to-peer (no relay or server stores messages), so a
message can only be delivered while the recipient's device is connected. To
avoid silently dropping messages sent to an offline peer, the sender performs
**sender-side store-and-forward**: it encrypts the payload locally and holds it
in an `outgoing_queue` until the peer reconnects, then replays it.

- **Trigger.** `MessageRouter.send_message` checks for a live connection via
  `peer_manager.get_connected_peer`. If the peer is online, the message is sent
  immediately. If it is offline but the sender has a **cached encryption public
  key** for that peer (persisted in the `peers` table on every handshake), the
  message is encrypted with that key and enqueued instead of raising. If no key
  has ever been seen, `send_message` raises
  `No known public key for recipient; connect once before sending offline`.
- **Friend-request actions are queued too.** `FriendManager` queues
  FRIEND_REQUEST, FRIEND_REQUEST_RESPONSE and FRIEND_REQUEST_CANCELLED packets
  when the target peer is offline, into the same `outgoing_queue`. These packets
  are signed (not encrypted), so no cached key is required to build them.
- **Group packets are queued per recipient.** `GROUP_MESSAGE` is independently
  encrypted for each offline active roster member with a cached key and stored
  with its `group_id`; its delivery state is `queued` until reconnect flushes it
  to `sent`, and `GROUP_MESSAGE_ACK` changes it to `delivered`. Signed
  `GROUP_LEAVE` events are also queued for known offline members previously
  observed to support `group_chat`.
- **Storage.** The `outgoing_queue` table holds
  `id, message_id (nullable), recipient_id, packet_type, encrypted_payload,
  created_at, attempts, last_attempt`. The `messages` row for a queued message
  carries `queued = 1` so the sender's UI can show the pending state. The
  queued bytes are the exact MESSAGE / FRIEND_REQUEST / … packet payload that
  would have been sent live, so replay is identical to a live send.
- **Flush on reconnect.** When a peer transitions to `CONNECTED`,
  `handle_peer_changed` invokes `flush_outgoing`, which drains
  `outgoing_queue` for that `recipient_id`, re-transmits each packet over the
  live connection, marks the local message `queued = 0`, and removes the queue
  row. A successful delivery later produces the normal MESSAGE_ACK, which marks
  the message `delivered`.
- **Bounds.** Packets with `attempts >= 5` are no longer selected for retry
  (`get_pending_outgoing` filters `attempts < 5`), but their rows are not
  currently deleted or transitioned to an explicit failed state. Messages no
  longer carry an expiry (`expires_at` was removed), so a queued message is held
  until it is successfully flushed or hits the retry bound; the recipient accepts
  it regardless of age when eventually flushed.
- **TUI.** Queued outgoing messages render with a `stored and queued` status
  until flushed (`sent`) and finally `delivered` on ACK. When the time a message
  was actually received/delivered differs from its send time, the UI appends a
  `(sent at <date/time>)` note so delayed/offline messages stay unambiguous.

### 7.5 Room-Backed Group Messages

A named room's decrypted room cards populate a persistent, device-local
`group_members` cache. Seeing a card activates or refreshes that peer and records
whether its current connection negotiated `group_chat`. This cache is the
fan-out roster; control-service member counts are not an authenticated identity
list. The local peer is inserted when named rooms are synchronized from
settings.
The candidate field may be null. Such a card still authenticates room membership
and populates the roster, but does not trigger UDP punching; this supports LAN
groups and control connectivity when STUN discovery fails.

`GROUP_MESSAGE` contains:

```json
{
  "message_id": "<uuid>",
  "group_id": "<32 lowercase hex>",
  "sender_id": "<64 hex>",
  "recipient_id": "<64 hex>",
  "created_at": 1700000000.0,
  "encrypted_content": "<hex>",
  "signature": "<128 hex>"
}
```

The AAD is canonical JSON of `message_id`, `group_id`, `sender_id`,
`recipient_id`, and `created_at`. Content uses the same one-time ephemeral
X25519/AES-GCM construction as direct messages, independently for each
recipient. The signature is Ed25519 over
`SHA-256(AAD || encrypted_content)`. Content is limited to 30 KiB before
encryption.

Receipt requires negotiated `group_chat`; authenticated peer ID equal to
`sender_id`; the local ID equal to `recipient_id`; a locally joined named room;
an active cached member row for the sender; and a valid signature and decrypt.
These checks authorize group traffic without consulting the friend list. Other
traffic still follows the normal friend policy. Duplicate message IDs do not
create another history row, but are ACKed again.
If the sender is locally blocked, the packet is suppressed without an ACK.
Blocked members are also excluded from local outgoing fanout.

`GROUP_MESSAGE_ACK` signs canonical JSON containing `message_id`, `group_id`,
and the acknowledging `recipient_id`. The sender accepts it only from that
authenticated recipient and only for a known delivery row in the same group,
then records `delivered` and emits `group_delivered`.

`GROUP_LEAVE` contains a UUID `event_id`, `group_id`, leaving `peer_id`,
`created_at`, and an Ed25519 signature over those canonical fields. A receiver
accepts it only from that authenticated active member, rejects duplicate IDs and
events more than 24 hours from its clock, marks the roster row inactive, stores
a local `leave` system event, and emits `group_member_left`. The leaver sends it
to online capable members and stores it in the durable outgoing queue for
offline members known to be capable before deleting its local group and room.
Previously stored local history and delivery records are retained so they can be
shown after rejoining, while pending group-message queue rows are deleted.

There is no group-history protocol. `group_messages` reads at most the newest
200 locally persisted rows; neither joining nor reconnecting requests old group
messages from peers or the control service.

## 8. Application Packet Types

TCP and UDP carry the same Packet type byte (backend/meshtalk/protocol.py):

| Type | Hex | Name | Purpose |
|------|-----|------|---------|
| HANDSHAKE | 0x01 | Handshake | LAN TCP identity exchange (initiator to responder). |
| HANDSHAKE_ACK | 0x02 | Handshake ACK | Responder acknowledges + returns nonce. |
| MESSAGE | 0x03 | Message | E2EE message envelope. |
| MESSAGE_ACK | 0x04 | Message ACK | Acknowledges a message_id. |
| PING | 0x05 | Ping | Liveness probe. |
| PONG | 0x06 | Pong | Ping reply. |
| GOODBYE | 0x07 | Goodbye | Graceful disconnect. |
| PROFILE | 0x08 | Profile | Signed display-name / TUI-active update. |
| HANDSHAKE_CONFIRM | 0x09 | Handshake Confirm | Initiator proves challenge. |
| FRIEND_REQUEST | 0x0A | Friend Request | Signed request to become friends. |
| FRIEND_REQUEST_RESPONSE | 0x0B | Friend Response | Signed accept/decline. |
| MESSAGE_BLOCKED | 0x0C | Message Blocked | Signed notice that a message was dropped (not a friend). |
| FRIEND_REQUEST_CANCELLED | 0x0D | Friend Cancelled | Signed cancellation of a pending request. |
| GROUP_MESSAGE | 0x0E | Group Message | Signed pairwise-encrypted copy for one group recipient. |
| GROUP_MESSAGE_ACK | 0x0F | Group Message ACK | Signed per-recipient delivery acknowledgement. |
| GROUP_LEAVE | 0x10 | Group Leave | Signed durable member-leave event. |

UDP transport-level frame types (udp_transport.py): HELLO=1, DATA=2, ACK=3,
PING=4, PONG=5, READY=6, GOODBYE=7 (distinct from the application types above;
the UDP header carries its own 1-byte type after MAGIC).

## 9. Social Layer (Friends, Blocking, Mute, Profiles)

All social packets are signed with Ed25519 and verified against the
authenticated peer's signing key; mismatched sender_id/responder_id is rejected.

- Friend requests (FRIEND_REQUEST): {request_id, sender_id, note (<=1024),
  created_at, signature}. A non-friend who sends a chat message receives a
  signed MESSAGE_BLOCKED and the message is dropped. Messages are accepted only
  from peers on the local friend list.
- Responses (FRIEND_REQUEST_RESPONSE): {request_id, responder_id, accept,
  signature}. Accepting adds both sides as friends and cancels any outbound
  request the acceptor had open.
- Cancellation (FRIEND_REQUEST_CANCELLED): {request_id, sender_id, signature};
  clears a pending request.
- Blocking: a blocked peer cannot send friend requests or messages; existing
  friendship is removed. Receiving a MESSAGE_BLOCKED for a former friend mirrors
  the removal locally so both views converge.
- Mute: mute(peer_id, timeout) silences notifications for timeout seconds (0 =
  permanent). Stored in settings.json.
- Profiles (PROFILE): {peer_id, display_name, tui_active, signature}. Broadcast
  to every active peer on name change (broadcast_profile_update); tui_active
  reflects whether any TUI client is connected (drives "active/away/offline"
  presence in peers).

## 10. Local IPC API (backend/meshtalk/ipc.py, common/ipc-client.ts)

Local clients (TUI/CLI) never open network sockets; they speak to the backend
over IPC.

- Transport: Unix-domain socket ~/.meshtalk/meshtalk.sock on Linux/macOS;
  loopback TCP (127.0.0.1, port in meshtalk.port) on Windows. Both are
  owner-only (0600). A random meshtalk.token (also 0600) is generated per
  backend start.
- Protocol: newline-delimited JSON (JSONL). MAX_IPC_LINE_SIZE = 256 KiB.
- Authentication: the first message from a client must be
  {"action":"authenticate","token":"<token>"}. On success the server replies
  {"authenticated":true}; otherwise it closes the connection.
- Requests/responses: each request is {id, action, ...params}; the matching
  response echoes "id" and may carry "error". The client correlates by id.
- Events: lines with an "event" field are unsolicited broadcasts (no id),
  delivered to all connected clients.

### 10.1 Commands

| Action | Params | Returns |
|--------|--------|---------|
| send | recipient_id, content | message_id |
| peers | - | List of peers with presence, unread counts, friend/blocked flags, network info. |
| remove_peer | peer_id | Removed (only if not connected). |
| friend_send | peer_id, note? | request_id |
| friend_respond | request_id, accept | request_id, accepted |
| friend_cancel | request_id | request_id |
| unfriend | peer_id | peer_id |
| friends | - | Friend list. |
| friend_requests | - | Pending requests. |
| block_peer / unblock_peer | peer_id | peer_id |
| blocked_peers | - | Blocked list. |
| tui_presence | client_id, active | Toggles TUI-active presence. |
| identity | - | peer_id, display_name, setup state. |
| status | - | peer_id, connected peers + network info, control URL/connected, public endpoint, rooms. |
| messages | peer_id | Conversation history (marks read). |
| set_display_name | display_name | New name; broadcasts PROFILE. |
| control | url?, dismiss_setup? | Control/STUN config + connection state. |
| room_create | name | room_id, group_id, name, invite |
| room_join | invite | room_id, group_id and name when the invite names a group |
| room_leave | room_id | room_id |
| room_invite | room_id | Re-export the invite. |
| rooms | - | Room membership counts. |
| groups | - | Named groups with cached active-member and unread counts. |
| group_members | group_id | Cached active roster with online state. |
| group_messages | group_id | Last 200 local messages/system events and per-recipient deliveries; marks read. |
| group_send | group_id, content | message_id and per-recipient `sent`, `delivered`, `queued`, or `unavailable` status. |
| group_leave | group_id | Sends/queues signed leave events, removes local room/group state, returns group_id. |
| mute / unmute | peer_id, timeout? | Mute state. |
| muted_peers | - | Current mutes. |
| debug_re_stun | - | Re-run STUN + re-announce. |
| debug_info | - | Full peer/endpoint/room diagnostic dump. |
| shutdown | - | Stops the backend. |

### 10.2 Events (server to clients)

`peer_update`, `message`, `delivered`, `friend_request`, `friend_response`,
`friend_cancelled`, `message_blocked`, `group_message`, `group_member_joined`,
`group_member_left`, `group_sent`, and `group_delivered`. Group events identify
the group and affected message/member; `group_sent` reports an offline queued
copy being flushed, and `group_delivered` reports its recipient ACK.

The CLI exposes `room create <name>`, `room join`, `groups` / `group list`, and
`group members|messages|send|leave`. `watch` prints incoming group messages and
member join/leave events. The TUI lists groups beside peers, provides named
create/join and member/leave dialogs, renders local group history and unread
counts, and summarizes per-member delivery states.

## 11. Threat Model & Trust Boundaries

What an adversary on the LAN / network path sees:
- LAN UDP discovery broadcasts (anonymous discovery_id, TCP port).
- LAN TCP bytes in cleartext EXCEPT message content (which is E2EE) and all
  signatures. On-link observers see peer IDs and packet types on the LAN TCP
  link (see section 4.3 caveat).
- Public UDP datagrams: only encrypted fragments + authenticated control frames;
  nothing about message content or routing metadata is recoverable without
  session keys.
- STUN providers learn the source address of STUN requests. Direct peers
  necessarily learn each other's public IP and UDP port.

What the control service can observe:
- Source IPs, connection timing, opaque 32-hex room_ids, room sizes, and signal
  sizes/cadence.
- It CANNOT decrypt endpoint cards (AES-GCM with a key it never receives),
  forge signed peer identities (Ed25519), read message content, or learn
  routing metadata inside cards.

What the control service can do (malicious case):
- Omit, replay, delay, or reorder encrypted cards; correlate timing; deny
  service. It CANNOT decrypt cards or impersonate a peer, because card age
  checks, nonce replay checks, signatures, and endpoint-bound UDP handshakes
  prevent those.

Cryptographic assumptions & limits:
- Ed25519 authenticates; X25519 + AES-256-GCM (HKDF-SHA256-derived keys) provide
  confidentiality and integrity. NOT post-quantum (X25519 is Shor-vulnerable).
  "Store now, decrypt later" risk applies to captured traffic.
- No TURN relay: symmetric NAT / UDP-blocked networks fail closed rather than
  routing content through infrastructure.
- Anyone with a room invite can join that room; invite secrecy is the user's
  responsibility.
- A group roster is a device-local cache derived from decrypted room endpoint
  cards and signed leave events, not an authoritative membership service. The
  friend-only policy is bypassed only for packets that negotiate `group_chat`
  and pass local active-membership and routing checks.
- There are no administrators, server-enforced bans/revocation, invite rotation,
  or history replay. Pairwise fan-out does not provide advanced group properties
  such as sender keys, group epochs, efficient large-group rekeying, or
  post-compromise security.

## 12. Planned / Not Yet Wired (Hybrid Section)

These are described in DESIGN.md / present as scaffolds but are NOT active in
the current code (per TODO.md):

- Multi-hop relay / routing. MessagePayload already carries hop_count and
  max_hops, and a routing scaffold exists, but message_router only performs
  DIRECT delivery (hop_count == max_hops == 0). Relay forwarding, loop
  resistance, and "relay cannot decrypt content" guarantees are not
  implemented.
- Queue limits, expiry, and durable failed/expired states remain incomplete.
  Sender-side direct and group delivery on reconnect is active, but queue rows
  are only retried up to five failed flush attempts and no 500-message or
  24-hour age bound is enforced.
- LAN TCP transport encryption. DESIGN claims "an additional independent
  authenticated encryption layer" from the transport; only the remote UDP
  transport implements this today. LAN TCP links are authenticated (signed) but
  not link-encrypted (see section 4.3).
- Transport forward secrecy persistence, OS secure-storage of private keys, full
  input/peer validation hardening, and Noise-protocol handshake are listed as
  outstanding in TODO.md.
- Post-quantum KEM (e.g., ML-KEM/Kyber hybrid) is not implemented.

## 13. Constants Quick Reference

| Constant | Value | Source |
|----------|-------|--------|
| Discovery UDP port | 24890 | protocol.UDP_PORT |
| LAN TCP port | 24891 | protocol.TCP_PORT |
| Protocol version | 2 | protocol.PROTOCOL_VERSION |
| Min supported protocol version | 2 | protocol.MIN_SUPPORTED_PROTOCOL_VERSION |
| Legacy peer version | 0 | Default for peers omitting `protocol_version` in handshake |
| Default capabilities | text_chat, profile_sync, friend_requests, delivery_receipts, block_reports, group_chat | protocol.DEFAULT_CAPABILITIES |
| Max packet size | 64 KiB | protocol.MAX_PACKET_SIZE |
| Discovery interval | 3 s | discovery.BROADCAST_INTERVAL |
| Handshake timeout | 10 s | peer_manager.HANDSHAKE_TIMEOUT |
| Max connected peers | 256 | peer_manager.MAX_CONNECTED_PEERS |
| STUN default | stun.l.google.com:19302 | settings.DEFAULT_* |
| Card max age | 180 s | rendezvous.CARD_MAX_AGE |
| Card refresh | 30 s | rendezvous.REFRESH_INTERVAL |
| Roster fetch | 120 s | rendezvous.PEER_FETCH_INTERVAL |
| Control ping | 5 s | rendezvous.CONTROL_PING_INTERVAL |
| UDP fragment size | 950 B | udp_transport.FRAGMENT_SIZE |
| UDP max datagram | 1200 B | udp_transport.MAX_DATAGRAM_SIZE |
| UDP retry / max | 0.45 s / 10 | udp_transport.RETRY_INTERVAL/MAX_RETRIES |
| UDP session timeout | 12 s | udp_transport.SESSION_TIMEOUT |
| Message max content | 30 KiB | message_router.MAX_MESSAGE_CONTENT_SIZE |
| Message expiry | 86400 s | message_router.MESSAGE_EXPIRY |
| Display name max | 48 chars | identity.normalize_display_name |
| Control port (default) | 8787 | control/src/index.ts |
| Control max room members | 64 | control/src/index.ts |
| Control retained bytes | 64 MiB | control/src/index.ts |
