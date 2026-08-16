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

# --- Setup ---
$repo = "QinCai-rui/MeshTalk"
$releaseUrl = "https://github.com/$repo/releases/latest/download"

New-Item -ItemType Directory -Force -Path bin | Out-Null

# --- Download binaries ---

Write-Info "Downloading TUI..."
Invoke-WebRequest -Uri "$releaseUrl/meshtalk-tui.exe" -OutFile "bin\meshtalk-tui.exe" -UseBasicParsing

Write-Info "Downloading CLI..."
Invoke-WebRequest -Uri "$releaseUrl/meshtalk-cli.exe" -OutFile "bin\meshtalk-cli.exe" -UseBasicParsing

Write-Info "Downloading control service..."
Invoke-WebRequest -Uri "$releaseUrl/meshtalk-control.exe" -OutFile "bin\meshtalk-control.exe" -UseBasicParsing

Write-Info "Downloading backend..."
Invoke-WebRequest -Uri "$releaseUrl/meshtalk-backend.exe" -OutFile "bin\meshtalk-backend.exe" -UseBasicParsing

# --- Done ---

Write-Host ""
Write-Info "Setup complete! Binaries are in bin\"
Write-Host ""
Write-Host "  Run the app:"
Write-Host "    TUI:      bin\meshtalk-tui.exe"
Write-Host "    CLI:      bin\meshtalk-cli.exe <command>"
Write-Host "    Backend:  bin\meshtalk-backend.exe"
Write-Host ""
