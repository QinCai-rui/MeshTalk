# MeshTalk

<div align="center">
  <sub><i>LETSSS GETTT MESHINGGG...</i></sub>
</div>

> [!WARNING]
> MeshTalk does not use post-quantum key exchange. All key agreement uses X25519
> (Curve25519), which is vulnerable to quantum attacks via Shor's algorithm.
> Captured traffic may be decryptable by a sufficiently large quantum computer
> ("store now, decrypt later"). Do not use MeshTalk for messages that must remain
> confidential against nation-state adversaries with long-term storage
> capabilities.

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
time to open commands for control-server status and setup, named group-chat
room management, and changing your display name. Group invites can be pasted
when joining and are copied to the clipboard when creating a group.

MeshTalk also sends a desktop notification for each incoming message when the
terminal supports notification OSC sequences. Notifications show the sender,
not message content. Set `OPENTUI_NOTIFICATIONS=0` to disable them.

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
meshtalk room create "Project Team"
meshtalk group list
meshtalk group members <group-id>
meshtalk group messages <group-id>
meshtalk group send <group-id> "hello team"
meshtalk group leave <group-id>
meshtalk backend status
meshtalk backend stop
```

The launcher starts the backend as a detached daemon and writes its output to
`~/.meshtalk/backend.log`. Later TUI and CLI invocations reuse that daemon.

MeshTalk creates fresh state in `~/.meshtalk`.

For safe key-exchange diagnostics, run `meshtalk -- --debug`. It logs
connection direction, endpoints, and public-key fingerprints, but never private
keys, room secrets, or message content.

## Docker

Pre-built multi-arch images (amd64 and arm64) are published to GitHub Container
Registry on every push to `main`.

```bash
# Pull images
docker pull ghcr.io/qincai-rui/meshtalk/control:latest
docker pull ghcr.io/qincai-rui/meshtalk/client:latest

# Run with docker compose
docker compose up -d
docker compose run -it client
```

The `docker-compose.yml` starts the control service and a client with the TUI.
LAN discovery uses host networking by default. Override environment variables
with a `.env` file or inline:

```bash
CONTROL_PORT=8787 docker compose up -d
```

To build images locally instead of pulling from GHCR:

```bash
docker compose build
docker compose run -it client
```

## Group Chats And Remote Rooms

Run the control service locally for development:

```bash
bun run dev:control
```

In the TUI, press `Ctrl+P`, select **Control server**, and choose the public
server or enter a custom URL. Then select **Private rooms** to create a named
group or paste an invite. Groups appear beside direct conversations; the TUI
shows their cached member list, local history, unread count, and per-member
delivery state. Created invites are copied to the clipboard automatically.

For local control-service development, select **Use a custom server** and enter
`ws://127.0.0.1:8787/v1/rendezvous`.

The equivalent CLI flow is:

```bash
meshtalk control set-url ws://127.0.0.1:8787/v1/rendezvous
meshtalk room create "Project Team"
```

Share the `meshtalk:` room invite or `meshtalk-group:` group invite through a trusted channel. On another MeshTalk
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

Named groups are backed by private rendezvous rooms. A `meshtalk-group:` invite
has a third, encrypted metadata segment containing the group name;
two-segment `meshtalk:` room invites remain ordinary unnamed rooms. Signed room
cards form each device's local cached roster even when no public STUN endpoint
is available. Group
messages are fanned out directly and encrypted separately for every recipient,
not encrypted once with a shared group key.

An outgoing group message records `sent`, `delivered`, `queued`, or
`unavailable` independently for each cached member. Messages for offline members
with a known encryption key are durably queued on the sender and sent when that
peer reconnects. There is no server-side storage or group-history replay: a
member receives only messages addressed to that device while it is in the
sender's cached roster, plus later delivery of messages already queued for it.
Leaving sends a signed leave event to online members and queues it for known
offline group-capable members before removing the group locally. Existing local
history is retained and becomes visible again if the same invite is rejoined;
messages missed while absent are not replayed.

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

> [!WARNING]
> **Post-quantum limitation:** MeshTalk uses X25519 for all key exchange (E2EE
> envelopes, UDP transport sessions). X25519 is not resistant to quantum
> computers. An adversary who records encrypted traffic today and later obtains a
> private key — or builds a fault-tolerant quantum computer — can decrypt past
> sessions. This is a "store now, decrypt later" risk. MeshTalk does not
> currently support hybrid or post-quantum key encapsulation (e.g., ML-KEM /
> Kyber).

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
- Group traffic may be accepted from a non-friend only when the sender is an
  active member in the recipient's local roster and negotiated `group_chat`.
  Ordinary direct messages remain friend-only.
- Blocking a group member suppresses their incoming group messages and excludes
  them from local outgoing fanout without changing the shared roster.
- STUN providers learn the source address of STUN requests. Direct peers
  necessarily learn each other's public IP and UDP port.

UDP hole punching does not work through every symmetric NAT, firewall, carrier
network, or UDP-blocking policy. MeshTalk does not include a TURN relay, so it
fails closed instead of routing chat content through the control service.

## Features

- Offline LAN discovery and authenticated TCP peer connections
- Encrypted multi-peer room rendezvous through a configurable control service
- Named room-backed group chats with pairwise per-recipient E2EE and offline queueing
- Public endpoint discovery through configurable STUN
- Reliable, encrypted, authenticated UDP peer transport with NAT hole punching
- End-to-end message encryption using X25519 and AES-GCM
- SQLite persistence, conversation history, and unread counts
- Endpoint and active-transport visibility in the CLI and TUI

Group chats currently have no administrators, member revocation, invite
rotation protocol, history synchronization, or advanced group cryptography
such as sender keys, tree-based key agreement, or post-compromise security.

## License

GPLv3
