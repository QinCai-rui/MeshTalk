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

Install [bun](https://bun.sh) and [uv](https://docs.astral.sh/uv/), then:

```bash
git clone <repo-url> && cd meshtalk
npm install
npm link
meshtalk          # launches backend + TUI
```

Or without installing globally:

```bash
bun install
bun run meshtalk              # launches backend + TUI
bun run meshtalk -- status    # CLI commands
```

CLI commands:

```bash
meshtalk status
meshtalk peers
meshtalk identity "Alice"
meshtalk messages <peer-id>
meshtalk send <peer-id> "hello"
meshtalk watch
```

MeshTalk creates fresh state in `~/.meshtalk`. It does not read or modify old
`~/.lanchat` state.

For safe key-exchange diagnostics, run `meshtalk -- --debug`. It logs
connection direction, endpoints, and public-key fingerprints, but never private
keys, room secrets, or message content.

## Remote Rooms

Run the control service locally for development:

```bash
bun run dev:control
```

Configure a running backend and create a room:

```bash
meshtalk control set-url ws://127.0.0.1:8787/v1/rendezvous
meshtalk room create
```

Share the printed `meshtalk:` invite through a trusted channel. On another
MeshTalk installation:

```bash
meshtalk control set-url wss://control.example/v1/rendezvous
meshtalk room join 'meshtalk:...'
```

Other room commands:

```bash
meshtalk rooms
meshtalk room leave <room-id>
meshtalk control
```

Production control services must be exposed through TLS as `wss://`. Plain
`ws://` configuration is accepted only for localhost. Set `PORT` for the
control process if port 8787 is unavailable.

The backend uses `stun.l.google.com:19302` by default. Override it without
changing persisted settings:

```bash
MESHTALK_STUN_SERVER=stun.example.com:3478 meshtalk
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
