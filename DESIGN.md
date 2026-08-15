# LanChat — Design Document

## 1. Overview

LanChat is a peer-to-peer messaging application that operates entirely on a local network.

There is no central server, cloud service, account system, or internet requirement. Every instance is both a **client and server**, and any peer can relay messages for other peers.

The application has two interfaces:

* **OpenTUI** — interactive terminal chat interface
* **CLI** — also used for chat, but just cli

The networking backend will initially be written in **Python**, using `asyncio`.

---

## 2. Architecture

```text
┌──────────────────────────────────────┐
│             User Interfaces          │
│                                      │
│   OpenTUI              CLI           │
└──────────────┬───────────────────────┘
               │ IPC
               ▼
┌──────────────────────────────────────┐
│          Python Backend              │
│                                      │
│  Peer Manager     Message Manager    │
│  Routing          Encryption         │
│  Storage          Protocol           │
└──────────────┬───────────────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
   UDP Discovery     TCP Peers
```

The backend owns all networking, encryption, routing, and persistent state. The TUI and CLI communicate with it locally rather than implementing their own networking.

---

## 3. Peer Discovery

Every instance broadcasts its presence over **UDP port 24890 every 3 seconds**.

A discovery packet contains only the information needed to establish a connection:

```json
{
  "protocol": 1,
  "peer_id": "...",
  "tcp_port": 24891
}
```

When another instance is discovered, the peer:

1. Validates the discovery packet.
2. Checks whether it is already connected.
3. Determines which peer should initiate the connection.
4. Establishes a TCP connection.
5. Performs the protocol and cryptographic handshake.

UDP is used only for discovery. Messages are never sent over UDP.

---

## 4. TCP Connections

Peers communicate directly using persistent TCP connections.

```text
Peer A ═════════ TCP ═════════ Peer B
```

To prevent both peers from opening connections simultaneously, connection initiation is deterministic:

```text
if local_peer_id < remote_peer_id:
    initiate
else:
    wait
```

TCP messages use application-level framing:

```text
[length][type][payload]
```

Possible packet types include:

```text
HANDSHAKE
HANDSHAKE_ACK
MESSAGE
MESSAGE_ACK
PING
PONG
GOODBYE
```

---

## 5. Identity

Each installation generates a persistent cryptographic identity.

```text
Peer
├── peer_id
├── public_key
└── private_key
```

The peer ID is derived from the public key:

```text
peer_id = SHA-256(public_key)
```

The private key never leaves the device.

A display name is separate from the cryptographic identity and can be changed without changing the peer's identity.

---

## 6. Encryption

Messages use **end-to-end encryption**.

If Alice sends a message to Charlie through Bob:

```text
Alice ── encrypted ──> Bob ── encrypted ──> Charlie
```

Bob can forward the message but cannot decrypt it.

Transport/session encryption may additionally protect each TCP connection:

```text
Alice ═════ encrypted TCP ═════ Bob
```

This provides two separate security layers:

* **Transport encryption:** protects individual peer connections.
* **E2EE:** protects the message from the sender to the final recipient.

Established cryptographic libraries and protocols must be used rather than implementing cryptography from scratch. The design should provide authenticated encryption, key exchange, forward secrecy, and replay protection.

---

## 7. Messaging

A message contains routing metadata and an encrypted payload:

```text
Message
├── message_id
├── sender_id
├── recipient_id
├── created_at
├── expires_at
├── hop_count
├── max_hops
└── encrypted_payload
```

Each peer maintains a cache of recently seen message IDs.

```text
if message_id already seen:
    discard
```

This prevents duplicate delivery when a message reaches a peer through multiple routes.

---

## 8. Multi-Hop Routing

Peers can relay messages for devices they cannot directly reach.

```text
Alice ── Bob ── Charlie
```

Alice encrypts the message for Charlie. Bob simply forwards the encrypted packet.

Messages have a maximum hop count:

```text
max_hops = 10
```

and an expiration time, such as 24 hours.

The initial routing algorithm can use controlled forwarding:

1. Deliver directly if the recipient is connected.
2. Otherwise forward to eligible peers.
3. Do not forward to the peer the message came from.
4. Do not forward messages already seen.
5. Stop when the hop limit or expiration is reached.

---

## 9. Store-and-Forward

Peers may temporarily store encrypted messages for offline devices.

```text
Alice ──> Bob

Charlie offline
```

Bob stores the encrypted message.

When Charlie returns:

```text
Alice ──> Bob ──> Charlie
```

Bob forwards it without ever decrypting it.

Storage is limited to prevent abuse, for example:

```text
Maximum message size:       64 KB
Maximum stored messages:    500
Maximum message age:        24 hours
Maximum hops:               10
```

---

## 10. Persistence

The backend uses a local database such as SQLite.

It stores:

```text
identity
peers
conversations
messages
outgoing queue
seen message IDs
encryption sessions
```

Messages and peer identities persist across application restarts.

Private keys should use the operating system's secure storage facilities where available.

---

## 11. Peer States

Peers can transition through:

```text
UNKNOWN
   ↓
DISCOVERED
   ↓
CONNECTING
   ↓
CONNECTED
   ↓
DISCONNECTED
```

The application periodically broadcasts discovery packets and automatically reconnects to previously known peers.

TCP connections use `PING`/`PONG` keepalives to detect dead connections.

---

## 12. Security Model

Every peer should be treated as potentially malicious.

A relay may:

* Observe that communication is occurring
* Forward messages
* Drop messages
* Delay messages
* Observe some routing metadata

A relay should not be able to:

* Read E2EE message contents
* Modify messages without detection
* Forge authenticated messages

All network input must be treated as untrusted and validated before processing.

The application should enforce connection, packet, message, storage, and forwarding rate limits.

---

## 13. Local Network Scope

UDP broadcast provides automatic discovery within the same local broadcast domain.

```text
┌────────────── Local Network ──────────────┐
│                                           │
│  Alice ── Bob ── Charlie ── Dave          │
│                                           │
└───────────────────────────────────────────┘
```

The system does not require internet connectivity.

Devices separated by routers or VLANs will not automatically discover one another through UDP broadcast. Additional discovery mechanisms can be added later if required.

---

## 14. Technology

### Backend

**Python**

* `asyncio` for networking and concurrency
* SQLite for persistence
* Established cryptographic libraries for E2EE
* Designed as a long-running local daemon/core

### Interactive UI

**TypeScript + OpenTUI**

Used for the main terminal chat experience.

### CLI

**TypeScript**

Used for scripting, automation, diagnostics, and headless operation.

### Communication

The UI processes communicate with the backend through a local IPC mechanism such as a Unix domain socket.

---

## 15. License

The project will use the **MIT License**.

This permits:

* Personal use
* Commercial use
* Modification
* Redistribution
* Forks
* Integration into other projects

while keeping the project simple and permissive.

---

## 16. MVP

The first release should implement:

* UDP peer discovery on port 24890
* TCP peer connections
* Peer identity
* Cryptographic handshake
* 1-to-1 E2EE messaging
* SQLite persistence
* OpenTUI chat interface
* CLI
* Message acknowledgements
* Duplicate detection
* Multi-hop forwarding
* Store-and-forward
* Message expiration
* Connection recovery

The system should first be tested with direct peer-to-peer messaging before enabling multi-hop routing.

---

## 17. Core Principle

```text
Every instance is:

    Client
      +
    Server
      +
    Peer
      +
    Optional Relay
```

There is no central infrastructure. The participating devices themselves form the network, while end-to-end encryption ensures that intermediate peers do not need to be trusted with message contents.
