#!/usr/bin/env bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[-]${NC} $1"; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

REPO="QinCai-rui/MeshTalk"
RELEASE_URL="https://github.com/$REPO/releases/latest/download"

echo ""
echo "  MeshTalk Installer"
echo "  =================="
echo ""

# --- Check Python ---
if ! command_exists python3; then
  error "Python 3 is not installed. Install Python 3.12+ from https://python.org"
fi

PY_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 12 ]; }; then
  error "Python $PY_VERSION found but 3.12+ is required."
fi
info "Python $PY_VERSION"

# --- Check curl ---
if ! command_exists curl; then
  error "curl is not installed."
fi

# --- Create bin directory ---
mkdir -p bin

# --- Download binaries ---

info "Downloading TUI..."
curl -fsSL "$RELEASE_URL/meshtalk-tui" -o bin/meshtalk-tui
chmod +x bin/meshtalk-tui

info "Downloading CLI..."
curl -fsSL "$RELEASE_URL/meshtalk-cli" -o bin/meshtalk-cli
chmod +x bin/meshtalk-cli

info "Downloading control service..."
curl -fsSL "$RELEASE_URL/meshtalk-control" -o bin/meshtalk-control
chmod +x bin/meshtalk-control

info "Downloading backend..."
curl -fsSL "$RELEASE_URL/meshtalk-backend" -o bin/meshtalk-backend
chmod +x bin/meshtalk-backend

# --- Done ---

echo ""
info "Setup complete! Binaries are in bin/"
echo ""
echo "  Run the app:"
echo "    TUI:      ./bin/meshtalk-tui"
echo "    CLI:      ./bin/meshtalk-cli <command>"
echo "    Backend:  ./bin/meshtalk-backend"
echo ""
