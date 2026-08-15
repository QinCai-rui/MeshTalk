# MeshTalk

Peer-to-peer encrypted messaging over a LAN or direct NAT-traversed UDP links.

MeshTalk keeps the original offline LAN path: UDP broadcast discovers peers and
TCP carries authenticated messages. Private rooms add remote discovery through
an opaque control service and public STUN. The control service exchanges only
encrypted endpoint cards; chat traffic always goes directly between peers.

## Architecture

```text
OpenTUI / CLI
      |
  local IPC
      |
Python backend ---- LAN broadcast + TCP ---- LAN peers
      |
      +---- encrypted endpoint cards ---- control service
      |
      +---- STUN + reliable encrypted UDP ---- remote peers
```

## Quick Start

### Backend

```bash
cd backend
uv sync
uv run meshtalk
```

MeshTalk creates fresh state in `~/.meshtalk`. It does not read or modify old
`~/.lanchat` state.

For safe key-exchange diagnostics, run `uv run meshtalk --debug`. It logs
connection direction, endpoints, and public-key fingerprints, but never private
keys, room secrets, or message content.

### TUI

```bash
cd tui
bun install
bun run dev
```

The peer menu shows each active transport and endpoint as `LAN TCP` or
`Remote UDP`. Use `Ctrl+Up` and `Ctrl+Down` to select a peer, `Page Up` and
`Page Down` to scroll, and `Ctrl+N` to change your display name.

### CLI

```bash
cd cli
bun install
bun run dev -- status
```

Useful commands:

```bash
bun run dev -- peers
bun run dev -- identity "Alice"
bun run dev -- messages <peer-id>
bun run dev -- send <peer-id> "hello"
bun run dev -- watch
```

## Remote Rooms

Run the control service locally for development:

```bash
bun run dev:control
```

Configure a running backend and create a room:

```bash
bun run dev:cli -- control set-url ws://127.0.0.1:8787/v1/rendezvous
bun run dev:cli -- room create
```

Share the printed `meshtalk:` invite through a trusted channel. On another
MeshTalk installation:

```bash
bun run dev:cli -- control set-url wss://control.example/v1/rendezvous
bun run dev:cli -- room join 'meshtalk:...'
```

Other room commands:

```bash
bun run dev:cli -- rooms
bun run dev:cli -- room leave <room-id>
bun run dev:cli -- control
```

Production control services must be exposed through TLS as `wss://`. Plain
`ws://` configuration is accepted only for localhost. Set `PORT` for the
control process if port 8787 is unavailable.

The backend uses `stun.l.google.com:19302` by default. Override it without
changing persisted settings:

```bash
MESHTALK_STUN_SERVER=stun.example.com:3478 uv run meshtalk
```

The control URL can similarly be supplied as `MESHTALK_CONTROL_URL`.

## Security

- Room invites contain a random 128-bit routing ID and independent 256-bit
  room secret. Treat the complete invite as a password.
- Endpoint cards are signed with Ed25519 and encrypted with AES-256-GCM using a
  key derived from the room secret. The secret never reaches the control server.
- Remote UDP links use signed ephemeral X25519 key exchange. Transport fragments,
  acknowledgements, and keepalives are authenticated; transport data is encrypted.
- Message content has a separate end-to-end encrypted envelope and is never sent
  through the control service.
- The control service can observe connection IPs, timing, opaque room IDs, and
  room sizes. It can block or delay signaling, but cannot decrypt endpoint cards
  or forge signed peer identities.
- A room member can read that room's endpoint cards. Anyone with the invite can
  join, so send invites only through a trusted channel and create a new room if
  an invite leaks.
- STUN providers learn the source address of STUN requests. Direct peers
  necessarily learn each other's public IP and UDP port.

UDP hole punching does not work through every symmetric NAT, firewall, carrier
network, or UDP-blocking policy. MeshTalk does not include a TURN relay, so it
fails closed instead of routing chat content through the control service.

## Features

- Offline LAN discovery and authenticated TCP peer connections
- Encrypted multi-peer room rendezvous through a configurable control service
- Public endpoint discovery through configurable STUN
- Reliable, encrypted, authenticated UDP peer transport with NAT hole punching
- End-to-end message encryption using X25519 and AES-GCM
- SQLite persistence, conversation history, and unread counts
- Endpoint and active-transport visibility in the CLI and TUI

## License

GPLv3
