#!/bin/sh
set -e

DATA_DIR="/data/meshtalk"
SOCKET_PATH="${DATA_DIR}/meshtalk.sock"
BACKEND_LOG="${DATA_DIR}/backend.log"
BACKEND_TIMEOUT=60

mkdir -p "${DATA_DIR}"
chmod 700 "${DATA_DIR}"

if [ ! -e "${HOME}/.meshtalk" ]; then
  ln -s "${DATA_DIR}" "${HOME}/.meshtalk"
fi

cleanup() {
  if [ -n "${BACKEND_PID}" ] && kill -0 "${BACKEND_PID}" 2>/dev/null; then
    echo "[entrypoint] Stopping backend..."
    kill "${BACKEND_PID}" 2>/dev/null || true
    wait "${BACKEND_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

echo "[entrypoint] Starting MeshTalk backend..."
meshtalk-backend >>"${BACKEND_LOG}" 2>&1 &

BACKEND_PID=$!

elapsed=0
while [ ${elapsed} -lt ${BACKEND_TIMEOUT} ]; do
  if [ -S "${SOCKET_PATH}" ]; then
    echo "[entrypoint] Backend IPC ready on ${SOCKET_PATH}"
    break
  fi
  if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    echo "[entrypoint] Backend exited unexpectedly"
    if [ -f "${BACKEND_LOG}" ]; then
      echo "[entrypoint] Backend log:"
      tail -20 "${BACKEND_LOG}"
    fi
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

if [ ${elapsed} -ge ${BACKEND_TIMEOUT} ]; then
  echo "[entrypoint] Backend did not start within ${BACKEND_TIMEOUT}s"
  if [ -f "${BACKEND_LOG}" ]; then
    echo "[entrypoint] Backend log:"
    tail -20 "${BACKEND_LOG}"
  fi
  exit 1
fi

exec meshtalk-tui "$@"
