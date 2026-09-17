# AGENTS.md

Guidance for AI coding agents working in the MeshTalk repository.

## Project Summary

MeshTalk is a privacy-first, end-to-end encrypted peer-to-peer messaging system for LAN and internet peers. No accounts, no central message store, local-only history. It's a monorepo with a Python backend, a TypeScript control service, and TypeScript TUI/CLI clients.

**Architecture in one paragraph**: LAN peers find each other via UDP broadcast and talk over authenticated TCP. Remote peers exchange opaque encrypted endpoint cards through a control service, use STUN for NAT traversal, and fall back to a DERP relay when direct UDP fails. All content is E2EE with X25519 + Ed25519 + AES-256-GCM. TUI and CLI are thin clients that talk to the Python backend over a local IPC socket.

## Repository Layout

| Path | Language | Role |
|------|----------|------|
| `backend/` | Python 3.12+ (asyncio, `cryptography`, `aiosqlite`) | Core: identity, networking, encryption, persistence, IPC server |
| `control/` | TypeScript (Bun) | Opaque WebSocket rendezvous service (never sees chat) |
| `tui/` | TypeScript (React, OpenTUI) | Interactive terminal UI |
| `cli/` | TypeScript (Bun) | Scriptable commands |
| `common/` | TypeScript | Shared IPC client used by TUI and CLI |
| `docs/` | Markdown | Design, protocol, file-transfer, analytics specs |
| `scripts/` | Shell / PowerShell | Installers and profiling helpers |
| `bin/` | TypeScript | Monorepo CLI entry (`meshtalk.ts`) |
| `analytics/` | TypeScript / Cloudflare Worker | Optional analytics backend (off by default) |
| `docker/` | Dockerfiles & compose | Containerised deployment |

## Backend Map (`backend/meshtalk/`)

| File | Responsibility |
|------|----------------|
| `__main__.py` | Entry point (`run`). Boots identity, DB, discovery, peer manager, routers, IPC server |
| `identity.py` | Ed25519 (sign) + X25519 (encrypt) keypairs. Peer ID = SHA-256 of Ed25519 pubkey |
| `database.py` | SQLite via `aiosqlite`: messages, friends, transfers, settings |
| `discovery.py` | UDP broadcast discovery on port 24890 |
| `peer_manager.py` | Peer connections, handshakes, transport selection |
| `protocol.py` | Packet types, capability flags, serialisation |
| `message_router.py` | Text message routing and delivery |
| `group_router.py` | Group chats, fan-out, membership |
| `file_transfer.py` | Authenticated resumable v2 file transfers |
| `typing_router.py` | Typing indicators |
| `friends.py` | Friend requests, blocking, profiles |
| `encryption.py` | ECDH, AES-256-GCM, Ed25519 helpers |
| `tcp_transport.py` | LAN TCP transport (port 24891) |
| `udp_transport.py` | Remote UDP, NAT traversal, STUN, relay fallback |
| `ipc.py` | Local IPC server (Unix socket / loopback TCP) for TUI/CLI |
| `rendezvous.py` | Control service WebSocket client |
| `settings.py` | JSON settings load/save |
| `analytics.py` | Optional analytics (off by default) |

## Key Constants

- LAN discovery: **UDP 24890**
- LAN chat: **TCP 24891**
- Default data dir: `~/.meshtalk` (override with `MESHTALK_DATA_DIR`)
- File transfer limits: 50 MiB file, 28 KiB plaintext/chunk, 255-char filename, 64 KiB max packet

## Commands

### Install (end users)
```bash
# macOS / Linux
bash <(curl -fssL https://raw.githubusercontent.com/QinCai-rui/MeshTalk/refs/heads/main/scripts/install.sh)
# Windows
irm https://raw.githubusercontent.com/QinCai-rui/MeshTalk/refs/heads/main/scripts/install.ps1 | iex
```

### Setup for Development
```bash
cd backend && uv sync        # Python backend deps
bun install                  # all TS workspaces (root)
```

### Build
```bash
bun run build                # builds tui, cli, control (root)
```

### Run
```bash
bun run dev:tui              # TUI
bun run dev:cli              # CLI
bun run dev:control          # control service
cd backend && uv run meshtalk   # backend (or: python -m meshtalk)
```

### Test
```bash
cd backend && uv run pytest  # backend tests live in backend/tests/
```

### Environment Flags
- `MESHTALK_DATA_DIR` — override `~/.meshtalk`
- `MESHTALK_NO_ANALYTICS=1` or `DO_NOT_TRACK=1` — disable analytics
- `MESHTALK_ANALYTICS`, `MESHTALK_RELEASE` — analytics configuration

## Rules for Making Changes

1. **Protocol changes** start in `backend/meshtalk/protocol.py` — add packet types and capability flags there first.
2. **Backend logic** goes in the appropriate router (`message_router.py`, `group_router.py`, `file_transfer.py`, `typing_router.py`). Don't put routing logic in `__main__.py`.
3. **IPC surface** — any new command or event the clients need must be added in `backend/meshtalk/ipc.py`, and then mirrored in `common/ipc-client.ts`.
4. **TUI and CLI consume the shared client.** They should not open sockets to the backend directly; go through `common/ipc-client.ts`.
5. **Control service stays opaque.** It must never parse, inspect, or log message content or endpoint card payloads. Rate limiting and room membership are the only permitted logic.
6. **Docs are part of the change.** Update `docs/PROTOCOL.md` for wire changes, `docs/DESIGN.md` for architecture changes, `docs/FILE_TRANSFER.md` for transfer changes.

## Where to Look First

| Task | Start here |
|------|-----------|
| Add a new message type | `backend/meshtalk/protocol.py` → `message_router.py` → `ipc.py` → `common/ipc-client.ts` |
| Change encryption or key handling | `backend/meshtalk/encryption.py`, `identity.py` |
| Touch NAT traversal or remote connectivity | `backend/meshtalk/udp_transport.py`, `rendezvous.py`, `control/src/` |
| Modify file transfers | `backend/meshtalk/file_transfer.py` + `docs/FILE_TRANSFER.md` |
| Add a CLI command | `cli/src/` (register in the command table) |
| Add a TUI screen / widget | `tui/src/` (entry `tui/src/index.tsx`) |
| Persistence schema | `backend/meshtalk/database.py` |
| Change discovery behaviour | `backend/meshtalk/discovery.py` |

## Security Notes (do not violate)

- MeshTalk's key exchange (X25519) is **not post-quantum secure**. Do not claim otherwise in docs or code comments.
- Never log plaintext message content, filenames, or endpoint-card payloads.
- The control service must remain a blind relay — any PR that adds payload inspection is a regression.
- Analytics is off by default; keep it that way unless explicitly enabled via env.

## Conventions

- Python: `asyncio` throughout; use `uv` for env and dependency management. Tests via `pytest`.
- TypeScript: Bun runtime; workspaces share `common/`. Build output goes to `dist/`.
- Prefer extending existing routers/modules over adding new top-level files unless the responsibility is genuinely new.
- Keep wire protocol changes additive where possible; bump capability flags rather than breaking existing peers.