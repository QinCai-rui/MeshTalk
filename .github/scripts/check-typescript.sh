#!/usr/bin/env bash
set -euo pipefail

case "$1" in
  tui|cli|control)
    bun "$1/node_modules/typescript/bin/tsc" --noEmit -p "$1/tsconfig.json"
    bun run --cwd "$1" build
    bun test "./$1/src"
    ;;
  desktop)
    bun run --cwd desktop build
    bun run --cwd desktop test
    ;;
  common)
    bun test ./common
    ;;
  launcher)
    bun build bin/meshtalk.ts --target=bun --packages=external --outdir "${RUNNER_TEMP:-/tmp/opencode}/meshtalk-launcher-check"
    ;;
  *)
    echo "Unknown TypeScript check target" >&2
    exit 1
    ;;
esac
