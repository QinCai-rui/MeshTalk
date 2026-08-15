# MeshTalk

> **WARNING: MeshTalk does not use post-quantum key exchange.**
> All key agreement uses X25519 (Curve25519), which is vulnerable to quantum
> attacks via Shor's algorithm. Captured traffic may be decryptable by a
> sufficiently large quantum computer ("store now, decrypt later").
> Do not use MeshTalk for messages that must remain confidential against
> nation-state adversaries with long-term storage capabilities.

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

Download the `.tar.gz` archive for your platform from the [latest release](../../releases/latest),
extract it, and run the launcher. The archive contains the backend, CLI, TUI, and
their runtimes, so it does not require Python, uv, Bun, or another package manager.

Release binaries are provided for macOS (Intel and Apple Silicon), Linux (x64
and ARM64), and Windows (x64).

```bash
./meshtalk         # macOS or Linux: launches backend + TUI
```

On Windows, run `meshtalk.exe` from the extracted archive. Keep these files
together in the extracted directory: `meshtalk`, `meshtalk-backend`,
`meshtalk-cli`, and `meshtalk-tui` (all end in `.exe` on Windows). Only the
`meshtalk` launcher is invoked directly.

The first launch offers guided remote-discovery setup. Press `Ctrl+P` at any
time to open commands for control-server status and setup, private-room
management, and changing your display name. Room invites can be pasted when
joining and are copied to the clipboard when creating a room.

## Build From Source

Source development requires [Bun](https://bun.sh) and
[uv](https://docs.astral.sh/uv/):

```bash
git clone <repo-url> && cd meshtalk
bun install
bun run meshtalk              # launches backend + TUI
bun run meshtalk -- status    # CLI commands
```

The CLI is optional. Equivalent commands are available for scripting:

```bash
meshtalk status
meshtalk peers
meshtalk identity "Alice"
meshtalk messages <peer-id>
meshtalk send <peer-id> "hello"
meshtalk watch
meshtalk backend status
meshtalk backend stop
```

The launcher starts the backend as a detached daemon and writes its output to
`~/.meshtalk/backend.log`. Later TUI and CLI invocations reuse that daemon.

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

In the TUI, press `Ctrl+P`, select **Control server**, and choose the public
server or enter a custom URL. Then select **Private rooms** to create a room or
paste an invite. Created invites are copied to the clipboard automatically.

For local control-service development, select **Use a custom server** and enter
`ws://127.0.0.1:8787/v1/rendezvous`.

The equivalent CLI flow is:

```bash
meshtalk control set-url ws://127.0.0.1:8787/v1/rendezvous
meshtalk room create
```

Share the `meshtalk:` invite through a trusted channel. On another MeshTalk
installation, paste it through **Ctrl+P > Private rooms > Join with an invite**,
or use the CLI:

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

**Post-quantum limitation:** MeshTalk uses X25519 for all key exchange (E2EE
envelopes, UDP transport sessions). X25519 is not resistant to quantum
computers. An adversary who records encrypted traffic today and later obtains a
private key — or builds a fault-tolerant quantum computer — can decrypt past
sessions. This is a "store now, decrypt later" risk. MeshTalk does not currently
support hybrid or post-quantum key encapsulation (e.g., ML-KEM / Kyber).

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
