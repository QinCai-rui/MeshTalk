#!/usr/bin/env bash
# Sample a MeshTalk process consistently for idle and active-load comparisons.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <seconds> <command> [args...]" >&2
  exit 2
fi

duration=$1
shift

"$@" &
pid=$!
cleanup() {
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "elapsed_s,rss_kib,cpu_percent"
for ((elapsed = 0; elapsed <= duration; elapsed++)); do
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid"
    exit $?
  fi
  read -r rss cpu < <(ps -o rss= -o %cpu= -p "$pid")
  echo "$elapsed,$rss,$cpu"
  sleep 1
done
