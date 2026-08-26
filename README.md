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
 an opaque control service and public STUN. MeshTalk Relay provides a bounded,
peer-ID-only fallback path when direct UDP is unavailable. The control service
exchanges encrypted endpoint cards and never stores chat traffic.

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
      |
      +---- MeshTalk Relay (fallback; encrypted WSS frames) ---- remote peers
```

## Quick Start

### Quick Install

The quick installer downloads the latest release for your platform and places
the binaries in `~/.local/bin` (or `%LOCALAPPDATA%\MeshTalk` on Windows):

```bash
curl -fsSL https://go.qincai.xyz/getmeshtalk | bash
```

Pass `--non-interactive` to skip prompts and accept all defaults:

```bash
curl -fsSL https://go.qincai.xyz/getmeshtalk | bash -s -- --non-interactive --yes
```

Other options: `--version TAG`, `--install-dir DIR`, `--prerelease`, `--uninstall`, `--dry-run`. Run with `--help` for the full list.

### Manual Install

Download the `.tar.gz` archive for your platform from the [latest release](../../releases/latest),
extract it, and run the launcher. The archive contains the backend, CLI, TUI, and
their runtimes, so it does not require Python, uv, Bun, or another package manager.

Release binaries are provided for macOS (Intel and Apple Silicon), Linux (x64
and ARM64), and Windows (x64). The Linux binaries require glibc 2.38 or newer
(Ubuntu 24.04+, Debian 13+, Fedora 39+, or equivalent). Older distributions
can run MeshTalk by building from source instead.

```bash
./meshtalk         # macOS or Linux: launches backend + TUI
```

To update the installation that launched MeshTalk, run:

```bash
./meshtalk update --install
```

To update a different existing MeshTalk installation, use its directory:

```bash
./meshtalk update --install --dir /path/to/MeshTalk
```

The target directory must contain the complete MeshTalk release binaries.

Updates use `QinCai-rui/MeshTalk` by default. To use releases from another
GitHub repository, configure its user and repository name:

```bash
./meshtalk update repo example-user example-repository
```

Run `./meshtalk update repo` to view the active repository, or
`./meshtalk update repo clear` to restore the default. The environment
variables `MESHTALK_GITHUB_USER` and `MESHTALK_GITHUB_REPO` override the
saved values for a single launch.

On Windows, run `meshtalk.exe` from the extracted archive. Keep these files
together in the extracted directory: `meshtalk`, `meshtalk-backend`,
`meshtalk-cli`, and `meshtalk-tui` (all end in `.exe` on Windows). Only the
`meshtalk` launcher is invoked directly.

### First Launch

The first launch offers guided remote-discovery setup. Press `Ctrl+P` at any
time to open commands for control-server status and setup, named group-chat
room management, and changing your display name. Group invites can be pasted
when joining and are copied to the clipboard when creating a group.

MeshTalk also sends a desktop notification for each incoming message when the
terminal supports notification OSC sequences. Notifications show the sender,
not message content. Set `OPENTUI_NOTIFICATIONS=0` to disable them.

## Run From Source

Running from source requires [Bun](https://bun.sh) and
[uv](https://docs.astral.sh/uv/). This is the development workflow and does not
produce standalone release binaries:

```bash
git clone <repo-url> && cd meshtalk
bun install
bun run meshtalk                 # launch the TUI with a managed backend
bun run meshtalk -- status       # run a CLI command
bun run meshtalk --help          # show CLI help
bun run meshtalk -- <command> --help
```

The CLI is optional. Run `bun run meshtalk --help` to see available commands,
or append `--help` to an individual command for its usage.

The TUI starts an attached backend and stops it when the TUI exits. Its output
is written to `~/.meshtalk/backend.log`, so it does not interfere with the TUI.
Use `bun run meshtalk -- backend start --daemonise` to run a persistent backend;
later TUI and CLI invocations reuse any running backend.

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

## DERP Relay Deployment

The control service embeds a MeshTalk-only DERP relay. Direct UDP remains
preferred; if direct HELLO/READY setup expires, clients carry their authenticated
and encrypted MeshTalk datagrams through the existing control `wss://` connection.

Deploy only the `control` service. It needs no UDP relay ports or shared secrets.
Cloudflare Tunnel can expose it directly because clients use WebSocket traffic:

```bash
docker compose up -d control
cloudflared tunnel --url http://localhost:8787
```

The feature is called **MeshTalk Relay**. It is enabled by default; set
`CONTROL_RELAY_ENABLED=false` to disable forwarding on the control server. This
leaves LAN and direct UDP connectivity available. `MESHTALK_FORCE_RELAY=true` is
only for relay-only testing and requires MeshTalk Relay to be enabled.

Clients register their existing Ed25519 identity before joining rooms. Joining
requires an HMAC derived from the room invite secret; control stores only that
derived capability. A relay frame names an authenticated MeshTalk peer ID, and
control forwards it only when both devices are authorized members of a shared
room.

The control relay accepts frames up to 1200 bytes, limits each device to 1 MiB/s
combined ingress/egress with a 4 MiB burst, and permits eight active relay peers
per device. Over-limit frames are dropped rather than buffered. The service can
observe registrations, IP addresses, room IDs, peer IDs, timing, and encrypted
frame sizes, but not MeshTalk transport or message contents.

A peer that remains offline should use the same control URL and room invite as its
peer; inspect control logs for room authorization or relay quota drops.

## File Transfer

MeshTalk supports sending files (up to 50 MiB) directly between peers over the
existing E2EE transport. Files are chunked, encrypted per-chunk with ephemeral
X25519 keys, and reassembled by the receiver. In the TUI, press `Ctrl+P` or use
the file-send shortcut (`Ctrl+U`) while in a conversation to send a file. Copy an
image and press `Ctrl+V` in the composer to read it from the host clipboard and
send it. Terminal-managed `Cmd+V` may not reach terminal applications. Incoming files
show an image preview when the file is an image, and you can save them to any
location via `file_download`.

For group file transfers, the file is sent independently to every active cached
group member. Offline members with a known encryption key receive queued copies
that flush on reconnect.

Files are stored in `~/.meshtalk/files/<file_id>/` by default. Override the
storage directory with the `files_dir` IPC command or `MESHTALK_DATA_DIR`
environment variable.

## Compile From Source

To produce local standalone binaries, install [Bun](https://bun.sh),
[uv](https://docs.astral.sh/uv/), and a native build environment for your
platform. From the repository root, run:

```bash
bun install
mkdir -p dist/local

# Compile the launcher, CLI, and TUI for the current platform.
bun build ./bin/meshtalk.ts --compile --outfile dist/local/meshtalk
bun build ./cli/src/index.ts --compile --outfile dist/local/meshtalk-cli
bun build ./tui/src/index.tsx --compile \
  --define 'process.env.OPENTUI_LIBC="glibc"' \
  --outfile dist/local/meshtalk-tui

# Compile the Python backend into a standalone executable.
uv run --project backend --with pyinstaller pyinstaller \
  --noconfirm --onefile --name meshtalk-backend \
  --distpath dist/local --workpath build/pyinstaller \
  --specpath build/pyinstaller backend/meshtalk_launcher.py
```

The resulting `meshtalk`, `meshtalk-cli`, `meshtalk-tui`, and
`meshtalk-backend` files are in `dist/local`. Keep them together when running
the launcher. To compile for another Bun-supported target, add a target such
as `--target=bun-linux-arm64` to each `bun build` command. The PyInstaller
backend must be compiled on the target operating system and CPU architecture.

On Linux, the compiled backend uses the glibc version available on the build
system. Building on an older Linux distribution generally provides broader
compatibility with newer distributions; it cannot run on a system with an
older glibc than the build system.

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
- Message content and file chunks have a separate end-to-end encrypted envelope and
  are never sent through the control service.
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
network, or UDP-blocking policy. When MeshTalk Relay is enabled, clients fall
back to peer-ID-addressed encrypted frames through the control connection.

Peer networking and STUN are IPv4-only. Sockets bind to `0.0.0.0`/`127.0.0.1`,
STUN resolution is forced to `AF_INET`, LAN discovery uses IPv4 broadcast, and
endpoint candidates must be global unicast IPv4. Control-server IP pins support
both IPv4 and IPv6.

## Features

- Offline LAN discovery and authenticated TCP peer connections
- Encrypted multi-peer room rendezvous through a configurable control service
- Named room-backed group chats with pairwise per-recipient E2EE and offline queueing
- Cross-platform file transfer with image preview and download
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
