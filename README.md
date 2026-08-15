# LanChat

Peer-to-peer local network messaging with end-to-end encryption.

## Architecture

```
OpenTUI (React)  ──┐
                   ├── IPC ── Python Backend ── UDP/TCP ── Peers
CLI (TypeScript) ──┘
```

## Quick Start

### Backend

```bash
cd backend
uv sync
uv run lanchat
```

### TUI

```bash
cd tui
bun install
bun run dev
```

Peers refresh automatically. Use `Ctrl+Up` and `Ctrl+Down` to select a peer,
type a message, and press `Enter` to send. Press `Ctrl+C` to quit.

### CLI

```bash
cd cli
bun install
bun run dev -- status
```

Useful CLI commands:

```bash
bun run dev -- peers
bun run dev -- messages <peer-id>
bun run dev -- send <peer-id> "hello"
bun run dev -- watch
```

## Features

- UDP peer discovery on local network
- TCP peer connections
- End-to-end encryption (X25519 + AES-GCM)
- Multi-hop message forwarding
- Store-and-forward for offline peers
- SQLite persistence

## License

GPLv3
