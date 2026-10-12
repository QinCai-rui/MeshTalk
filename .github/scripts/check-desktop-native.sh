#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

bun run --cwd desktop icons
# Direct Cargo builds need the same sidecar override as `tauri dev --config`.
export TAURI_CONFIG="$(cat desktop/src-tauri/tauri.dev.json)"
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml
