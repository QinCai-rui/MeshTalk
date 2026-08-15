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

## Limitations

- Direct connections may fail with symmetric NAT, blocked UDP, or restrictive
  firewalls.
- There is intentionally no TURN relay, because routing through one would expose
  additional traffic metadata and make remote delivery infrastructure-dependent.
- Anyone holding a room invite can decrypt that room's endpoint cards and attempt
  to connect. Invite distribution and rotation are user responsibilities.
- Direct peers and STUN providers necessarily observe public network endpoints.

## Persistence

Fresh MeshTalk state is stored in `~/.meshtalk`:

- `identity.json`: private identity and message-encryption keys, mode 0600
- `settings.json`: control URL and room secrets, mode 0600
- `meshtalk.db`: peer and conversation state
- `meshtalk.sock`: owner-only local IPC socket while the backend runs

Old `~/.lanchat` state is left untouched and is not migrated automatically.
