# MeshTalk Installer for Windows
$ErrorActionPreference = "Stop"

function Write-Info($msg)  { Write-Host "[+] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Error($msg) { Write-Host "[-] $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  MeshTalk Installer"
Write-Host "  =================="
Write-Host ""

# --- Detect architecture ---
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq "ARM64") {
    Write-Warn "Windows ARM detected, using x64 build (emulation)"
    $platform = "windows-x64"
} elseif ($arch -eq "AMD64") {
    $platform = "windows-x64"
} else {
    Write-Error "Unsupported architecture: $arch"
}

Write-Info "Detected platform: $platform"

# --- Download and extract ---
$repo = "QinCai-rui/MeshTalk"
$version = if ($env:MESHTALK_VERSION) { $env:MESHTALK_VERSION } else { "latest" }
$baseUrl = "https://github.com/$repo/releases/download/$version"
$targz = "meshtalk-$platform.tar.gz"

New-Item -ItemType Directory -Force -Path bin | Out-Null

Write-Info "Downloading $targz..."
$downloadPath = Join-Path $env:TEMP $targz
Invoke-WebRequest -Uri "$baseUrl/$targz" -OutFile $downloadPath -UseBasicParsing

Write-Info "Extracting..."
tar -xzf $downloadPath -C bin
Remove-Item $downloadPath -ErrorAction SilentlyContinue

# --- Done ---

Write-Host ""
Write-Info "Setup complete! Binaries are in bin\"
Write-Host ""
Write-Host "  Run the app:"
Write-Host "    TUI:      bin\meshtalk-tui.exe"
Write-Host "    CLI:      bin\meshtalk-cli.exe <command>"
Write-Host "    Backend:  bin\meshtalk-backend.exe"
Write-Host ""
