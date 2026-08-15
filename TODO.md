# MeshTalk Implementation Checklist

Status reflects verified implementation, not planned code.

## Project Foundation

- [x] GPLv3 license selected and present
- [x] Monorepo structure for Python backend, TypeScript TUI, TypeScript CLI, and common code
- [x] Python package metadata
- [x] TypeScript package metadata
- [x] Project README with startup instructions
- [ ] Reproducible dependency lockfiles
- [ ] CI for linting, type checking, and tests
- [ ] Release/build packaging for all executables

## Backend Core

- [x] Async Python backend entry point
- [x] Long-running daemon lifecycle
- [x] Local data directory creation
- [x] Unix-domain IPC server scaffold
- [ ] Graceful cleanup and cancellation of all background tasks
- [ ] Configurable data directory, display name, TCP port, and log level
- [ ] Structured operational logging

## Identity And Trust

- [x] Persistent X25519 private key generation
- [x] Public key derivation
- [x] Peer ID derived from SHA-256 public-key hash
- [x] Persistent display name field
- [ ] OS secure-storage integration for private keys
- [x] Private-key file permissions and integrity validation
- [ ] Public-key/peer-ID validation on load and handshake
- [ ] Peer trust, verification, and key-change handling

## Discovery

- [x] UDP listener on port 24890
- [x] UDP broadcast every 3 seconds
- [x] Discovery packet encoding and decoding
- [x] Ignore local discovery packets
- [ ] Strict discovery schema validation and bounds checking
- [ ] Per-source discovery rate limiting
- [ ] Configurable network interface and broadcast address support
- [ ] Discovery tests across multiple local instances

## Remote Connectivity

- [x] Configurable opaque WebSocket control service
- [x] Private multi-peer room invites with 256-bit secrets
- [x] End-to-end encrypted and signed endpoint cards
- [x] Public endpoint discovery through configurable STUN
- [x] Signed ephemeral X25519 UDP session handshake
- [x] Reliable encrypted UDP fragmentation and acknowledgement
- [x] UDP duplicate suppression, retransmission, and keepalives
- [x] NAT endpoint refresh while connected to the control service
- [x] LAN-first transport selection with remote UDP fallback
- [x] CLI room and control-service commands
- [x] LAN and remote endpoint visibility in CLI and OpenTUI
- [ ] TURN fallback for symmetric NATs (intentionally not routed through control)
- [ ] Large-scale room churn and hostile-control integration tests

## Peer Connections

- [x] TCP listener on port 24891
- [x] Application framing: length, type, payload
- [x] Maximum packet-size check on encoding
- [x] Deterministic connection initiation rule
- [x] Basic peer states
- [x] PING/PONG packet types and periodic ping transmission
- [x] Packet length validation on reception
- [ ] Complete connection state transitions
- [ ] Simultaneous-connection deduplication
- [ ] PONG deadlines and dead-connection detection
- [ ] Exponential reconnect backoff for known peers
- [ ] Connection and packet rate limits
- [ ] Configurable TCP port propagation through discovery

## Cryptography And E2EE

- [x] X25519 shared-secret derivation
- [x] HKDF key derivation
- [x] AES-256-GCM encryption primitives
- [x] Per-message ephemeral X25519 E2EE envelope scaffold
- [x] Authenticated cryptographic handshake
- [x] Peer identity binding in handshake
- [ ] Noise Protocol handshake implementation using an established library/protocol
- [ ] Transport/session encryption for every TCP connection
- [ ] Forward secrecy for transport sessions
- [ ] Replay protection and nonce/session management
- [x] Authenticated message metadata and tamper detection
- [x] Key confirmation and handshake failure handling
- [ ] Cryptographic test vectors and negative tests

## Direct Messaging

- [x] Outgoing message model
- [x] Local message ID generation
- [x] Message expiry metadata
- [x] Encrypted outgoing-message persistence scaffold
- [x] Basic direct-peer routing attempt
- [x] Complete direct connection handshake for outbound peers
- [x] E2EE message send between two peers
- [x] E2EE message decrypt at recipient
- [x] Persist decrypted incoming messages
- [x] Persist sent-message state
- [x] Message acknowledgement send and handling
- [ ] Delivery state transitions: queued, sent, delivered, failed, expired
- [x] Backend IPC event emission for incoming messages
- [x] Direct peer-to-peer integration test

## Routing And Relaying

- [x] Hop-count message fields
- [x] Maximum-hop field
- [x] Seen-message persistence scaffold
- [x] Initial controlled-forwarding scaffold
- [ ] Validate expiration before delivery and forwarding
- [ ] Forward only eligible messages/peers
- [ ] Exclude immediate source peer when forwarding
- [ ] Preserve and authenticate immutable envelope metadata
- [ ] Relay acknowledgement behavior
- [ ] Routing-loop and duplicate-resistance integration tests
- [ ] Relay privacy review: relay cannot decrypt or undetectably modify content

## Store And Forward

- [x] Outgoing queue table scaffold
- [x] Message expiration cleanup scaffold
- [ ] Store encrypted relay envelopes for offline recipients
- [ ] Enforce 500 stored-message limit
- [x] Enforce transport-safe 30 KiB plaintext message limit
- [ ] Enforce 24-hour maximum stored-message age
- [ ] Deliver stored messages when recipient reconnects
- [ ] Retry accounting, backoff, and durable queue states
- [ ] Storage-limit and expiry tests

## Persistence

- [x] SQLite schema for peers, messages, outgoing queue, seen IDs, and config
- [x] Peer persistence
- [x] Seen-message persistence
- [x] Conversations persistence model
- [x] Incoming and outgoing message query APIs
- [ ] Durable encryption-session persistence, if required by chosen protocol
- [ ] Database migrations and corruption handling
- [ ] Database transaction boundaries for delivery/acknowledgement state

## IPC API

- [x] Unix-domain socket location
- [x] Socket permissions restricted to owner
- [x] JSON line protocol scaffold
- [x] Identity, status, peers, and send command handlers
- [x] Request/response IDs and correct concurrent response correlation
- [ ] IPC protocol schema validation
- [x] IPC event subscription model
- [ ] Peer-state and delivery-status events
- [x] Incoming-message events
- [x] Conversation/history IPC endpoints
- [ ] IPC client tests

## CLI

- [x] CLI scaffolding
- [x] Status command
- [x] Peer-list command
- [x] Identity command
- [x] Send command scaffold
- [x] Compiled executable build target
- [x] Show conversations and message history
- [x] Stream incoming messages/events
- [ ] Stable machine-readable output mode
- [ ] CLI tests

## OpenTUI

- [x] OpenTUI React project scaffold
- [x] Backend connection state display
- [x] Peer list display scaffold
- [x] Compose/send interaction scaffold
- [x] Verified OpenTUI build and type-check compatibility
- [x] Peer selection and focus management
- [x] Incoming-message display
- [x] Selected conversation and persisted history
- [ ] Delivery status display
- [ ] Peer online/offline updates
- [ ] Keyboard help, error states, and responsive layout
- [ ] TUI tests

## Security And Reliability

- [ ] Validate every untrusted network and IPC input
- [ ] Connection, packet, message, storage, and forwarding rate limits
- [ ] Malformed-packet resilience tests
- [ ] Resource-exhaustion limits and timeouts
- [ ] Security review of protocol choices and threat model
- [ ] Document metadata exposure and relay limitations
- [ ] No plaintext messages written to relay storage

## Verification

- [ ] Unit tests for framing, identity, discovery validation, crypto, persistence, routing, and IPC
- [ ] Two-peer encrypted direct-message test
- [ ] Three-peer encrypted relay test
- [ ] Offline recipient store-and-forward test
- [ ] Restart/recovery test
- [ ] Manual LAN test on separate devices
