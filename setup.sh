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
VERSION="${MESHTALK_VERSION:-latest}"
BASE_URL="https://github.com/$REPO/releases/download/$VERSION"

echo ""
echo "  MeshTalk Installer"
echo "  =================="
echo ""

# --- Detect OS and architecture ---

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="macos" ;;
  *)      error "Unsupported OS: $OS" ;;
esac

case "$ARCH" in
  x86_64|amd64)  PLATFORM="$PLATFORM-x64" ;;
  aarch64|arm64) PLATFORM="$PLATFORM-arm64" ;;
  *)             error "Unsupported architecture: $ARCH" ;;
esac

TARBALL="meshtalk-${PLATFORM}.tar.gz"
info "Detected platform: $PLATFORM"

# --- Check curl ---
if ! command_exists curl; then
  error "curl is not installed."
fi

# --- Download and extract ---

mkdir -p bin
info "Downloading $TARBALL..."
curl -fsSL "$BASE_URL/$TARBALL" -o "/tmp/$TARBALL"
info "Extracting..."
tar -xzf "/tmp/$TARBALL" -C bin/
rm -f "/tmp/$TARBALL"
chmod +x bin/*

# --- Done ---

echo ""
info "Setup complete! Binaries are in bin/"
echo ""
echo "  Run the app:"
echo "    TUI:      ./bin/meshtalk-tui"
echo "    CLI:      ./bin/meshtalk-cli <command>"
echo "    Backend:  ./bin/meshtalk-backend"
echo ""
