# Repository Guidelines

MeshTalk is peer-to-peer encrypted messaging. A Python backend owns identity, persistence, networking, and routing. TypeScript clients (TUI, CLI, desktop) talk to it over local IPC. The control service does rendezvous and relay only; it is opaque to chat content and endpoint-card payloads. Details live in `README.md` and `docs/`.

## Coding style

Follow the surrounding file. TypeScript uses 2-space indentation, no trailing semicolons, `camelCase` functions and variables, and `PascalCase` React components. Python uses 4 spaces, `snake_case` functions and modules, and `PascalCase` classes. Keep UI components under `tui/src/components/` with colocated `ComponentName.test.tsx` tests. Keep changes to protocol and cryptography code small and explicit. Never log message contents, room secrets, filenames, or private keys.

## Architecture boundaries

Keep backend routing in its module (`message_router.py`, `group_router.py`, or `file_transfer.py`) rather than in the entry point. TUI and CLI code should use `common/ipc-client.ts` for backend communication. For wire or architecture changes, update the matching specification in `docs/` (for example `docs/PROTOCOL.md` or `docs/FILE_TRANSFER.md`). The control service must remain opaque to chat content and endpoint-card payloads.

## Testing

Prefer `bun` for install, run, and test across JS/TS packages. Use `uv` for Python dependencies and pytest runs. Exercise the smallest relevant suite before broader builds. Cover successful flows and error or boundary cases.

- Backend: add or update `backend/tests/test_*.py`. Tests must not depend on a developer's `~/.meshtalk` state; use temporary directories, fixtures, and explicit test settings.
- TUI, CLI, control: add or update colocated `*.test.ts` or `*.test.tsx` files run with `bun test`. Preserve the TUI narrow-terminal rendering checks and interactive state-transition checks when changing layout or dialogs.
- Desktop: `bun run --cwd desktop build` typechecks and bundles, `bun run --cwd desktop test` runs unit tests, and `bun run --cwd desktop test:e2e` runs Playwright specs against demo mode (`/?demo=...`), which needs no backend. Playwright cleans its output directory on each run, so regenerate or restore `desktop/test-results` rather than committing incidental changes to it.

## Verification

Verify before claiming something works. Start with a targeted check and run a full suite only when needed.

- After any UI change (desktop, TUI, or web), exercise every touched screen in each of its states (on and off, empty and filled, light and dark where applicable) and look at each capture with vision before claiming it is done. Function passing is not rendering passing. A sample of the captures is not enough.
- UI proof belongs in the pull request body as attached images or clips, not as binaries committed to the branch.
- After addressing review findings, re-run the affected checks and confirm the review verdict changed before asking for another look.

## Security, privacy, and configuration

Key agreement uses X25519 and is not post-quantum secure. Never describe it as post-quantum safe. Never log plaintext messages, filenames, private keys, room secrets, or endpoint-card payloads. Analytics is disabled by default and must remain opt-in. The control service should validate authorization, rate-limit clients, and relay encrypted data without inspecting it.

For local development, state lives under `~/.meshtalk` and `MESHTALK_DATA_DIR` can override that location. LAN discovery uses UDP port `24890` and LAN chat uses TCP port `24891`.

## Commits and pull requests

Use concise Conventional Commit subjects such as `fix(tui): preserve failed send rows` or `feat: add relay diagnostics`. Use the `[ci skip]` prefix for version and automation-only work that should not trigger a release. Keep commits focused.

Pull requests should explain user-visible changes, link the related issue when applicable, list tests run, and call out protocol, privacy, and configuration impacts. UI changes need screenshots or clips in the body. Automated review may request changes; address each finding or rebut it with a reason, keep the change minimal, and keep the branch green before merge.

### CI / Checks Follow-up

**Always watch CI checks after pushing.** Do not push and walk away.

After pushing:

- Monitor CI with `gh pr checks <PR_NUMBER> --watch`.
- Use `gh pr view <PR_NUMBER> --json statusCheckRollup` for programmatic check status.

If checks fail:

1. Find the failed run ID from the `gh pr checks` output.
2. Read the logs with `gh run view <run-id> --log-failed`.
3. Fix the problem locally.
4. Push the fix.
