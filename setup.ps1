# MeshTalk Installer for Windows
$ErrorActionPreference = "Stop"

function Write-Info($msg)  { Write-Host "[+] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Error($msg) { Write-Host "[-] $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  MeshTalk Installer"
Write-Host "  =================="
Write-Host ""

# --- Check Python ---
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    $python = Get-Command python3 -ErrorAction SilentlyContinue
}
if (-not $python) {
    Write-Error "Python is not installed. Install Python 3.12+ from https://python.org"
}

$pyVersion = & python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
$pyMajor = [int]($pyVersion.Split('.')[0])
$pyMinor = [int]($pyVersion.Split('.')[1])
if ($pyMajor -lt 3 -or ($pyMajor -eq 3 -and $pyMinor -lt 12)) {
    Write-Error "Python $pyVersion found but 3.12+ is required."
}
Write-Info "Python $pyVersion"

# --- Check uv ---
$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv) {
    Write-Warn "uv is not installed. Installing..."
    powershell -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
    $env:PATH = "$env:USERPROFILE\.local\bin;$env:PATH"
}
Write-Info "uv"

# --- Check Bun ---
$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
    Write-Warn "Bun is not installed. Installing..."
    powershell -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
}
Write-Info "bun"

# --- Install dependencies ---

Write-Info "Installing Python backend dependencies..."
Push-Location backend
uv sync
Pop-Location

Write-Info "Installing TUI dependencies..."
Push-Location tui
bun install
Pop-Location

Write-Info "Installing CLI dependencies..."
Push-Location cli
bun install
Pop-Location

Write-Info "Installing control service dependencies..."
Push-Location control
bun install
Pop-Location

# --- Done ---

Write-Host ""
Write-Info "Setup complete!"
Write-Host ""
Write-Host "  Run the app:"
Write-Host "    Backend:  cd backend; uv run python -m meshtalk"
Write-Host "    TUI:      cd tui; bun run dev"
Write-Host "    CLI:      cd cli; bun run dev"
Write-Host ""
