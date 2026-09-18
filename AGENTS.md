# Repository Guidelines

## Project Structure & Module Organization

MeshTalk combines a Bun/TypeScript client stack with a Python backend. `tui/` contains the OpenTUI React interface, `cli/` the command-line client, and `control/` the rendezvous/relay service. Shared TypeScript IPC helpers live in `common/`; `bin/` contains launch entry points. The Python peer-to-peer implementation is in `backend/meshtalk/`, with tests in `backend/tests/`. The site is in `web/`; analytics services are in `analytics/`. Protocol and design decisions belong in `docs/`.

The backend owns identity, persistence, networking, and message routing. `identity.py` and `encryption.py` handle keys and authenticated encryption; `database.py` stores local state; `discovery.py`, `tcp_transport.py`, and `udp_transport.py` handle LAN and remote transport; `peer_manager.py` selects connections; `message_router.py`, `group_router.py`, and `file_transfer.py` implement application flows; `ipc.py` exposes the local client API. The control service exchanges opaque endpoint cards and provides rendezvous/relay support; it must not become a chat-data store.

## Coding Style & Naming Conventions

Follow the surrounding file’s style: TypeScript source commonly uses 2-space indentation, no trailing semicolons, `camelCase` functions and variables, and `PascalCase` React components. Keep UI components under `tui/src/components/`; name their tests `ComponentName.test.tsx`. Python uses 4 spaces, `snake_case` functions/modules, and `PascalCase` classes. Prefer small, explicit changes in protocol and cryptography code; never log message contents, room secrets, or private keys.

## Architecture & Change Boundaries

Keep backend routing in its module (`message_router.py`, `group_router.py`, or `file_transfer.py`) rather than in the entry point. TUI and CLI code should use `common/ipc-client.ts` for backend communication. For wire or architecture changes, update the matching specification in `docs/` (for example, `docs/PROTOCOL.md` or `docs/FILE_TRANSFER.md`). The control service must remain opaque to chat content and endpoint-card payloads.

## Testing Guidelines

Tests use Bun’s `bun:test` for TypeScript and pytest for the backend. Add or update a colocated `*.test.ts`/`*.test.tsx` test for TUI, CLI, and control behavior, or a `backend/tests/test_*.py` test for backend changes. Exercise the smallest relevant suite before broader builds; cover both successful flows and error or boundary cases.

The TUI has rendering tests for narrow terminal widths and interactive state transitions; preserve those checks when changing layout or dialogs. Backend tests include transport, IPC, protocol, friends, groups, STUN, and file-transfer coverage. Tests should not depend on a developer’s `~/.meshtalk` state: use temporary directories, fixtures, and explicit test settings.

## Security, Privacy, and Configuration

MeshTalk’s key agreement uses X25519 and is not post-quantum secure; do not describe it as post-quantum safe. Never log plaintext messages, filenames, private keys, room secrets, or endpoint-card payloads. Analytics is disabled by default and must remain opt-in. The control service should validate authorization, rate-limit clients, and relay encrypted data without inspecting it.

For local development, MeshTalk stores state under `~/.meshtalk`; `MESHTALK_DATA_DIR` can override that location. LAN discovery uses UDP port `24890` and LAN chat uses TCP port `24891`. 

## Commit & Pull Request Guidelines

Use concise Conventional Commit-style subjects seen in history, such as `fix(tui): preserve failed send rows` or `feat: add relay diagnostics`; reserve `[ci skip]` prefix for version/automation-only work, or anything that should not trigger automatic pre-release. Keep commits focused. Pull requests should explain user-visible changes, link the related issue when applicable, list tests run, and include screenshots or terminal captures for TUI/web changes. Call out protocol, privacy, and configuration impacts.

Before committing, ideally spawn a subagent (if available) to review your work in the worktree and fix any issues it identifies. Re-review as needed. If anything requires a design decision or clarification, ask the user before proceeding.
