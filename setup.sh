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

# --- Check dependencies ---

echo ""
echo "  MeshTalk Installer"
echo "  =================="
echo ""

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

if ! command_exists uv; then
  warn "uv is not installed. Installing..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
info "uv $(uv --version 2>/dev/null || echo 'installed')"

if ! command_exists bun; then
  warn "Bun is not installed. Installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
info "bun $(bun --version 2>/dev/null || echo 'installed')"

# --- Install dependencies ---

info "Installing Python backend dependencies..."
cd backend
uv sync
cd ..

info "Installing TUI dependencies..."
cd tui
bun install
cd ..

info "Installing CLI dependencies..."
cd cli
bun install
cd ..

info "Installing control service dependencies..."
cd control
bun install
cd ..

# --- Build binaries ---

info "Building TUI binary..."
cd tui
bun build src/index.tsx --target=bun --compile --outfile ../bin/meshtalk-tui
cd ..

info "Building CLI binary..."
cd cli
bun build src/index.ts --target=bun --compile --outfile ../bin/meshtalk-cli
cd ..

info "Building control service binary..."
cd control
bun build src/index.ts --target=bun --compile --outfile ../bin/meshtalk-control
cd ..

info "Building Python backend..."
cd backend
uv run pyinstaller --onefile --name meshtalk-backend --distpath ../bin meshtalk/__main__.py 2>/dev/null || {
  warn "PyInstaller failed, using uv run as fallback"
  cd ..
  mkdir -p bin
  cat > bin/meshtalk-backend << 'WRAPPER'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR/backend" && uv run python -m meshtalk "$@"
WRAPPER
  chmod +x bin/meshtalk-backend
  cd backend
}
cd ..

chmod +x bin/meshtalk-tui bin/meshtalk-cli bin/meshtalk-control bin/meshtalk-backend 2>/dev/null || true

# --- Done ---

echo ""
info "Setup complete! Binaries are in bin/"
echo ""
echo "  Run the app:"
echo "    TUI:      ./bin/meshtalk-tui"
echo "    CLI:      ./bin/meshtalk-cli <command>"
echo "    Backend:  ./bin/meshtalk-backend"
echo ""
echo "  Or use the unified launcher:"
echo "    ./bin/meshtalk-tui          (starts backend + TUI)"
echo ""
