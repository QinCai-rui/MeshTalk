#Requires -Version 5.1
<#
.SYNOPSIS
    MeshTalk Installer (PowerShell port)
.DESCRIPTION
    Peer-to-peer encrypted messaging over LAN and UDP.
    PowerShell port of the original Bash installer for QinCai-rui/MeshTalk.
.PARAMETER Version
    Install a specific release tag
.PARAMETER Prerelease
    Install the latest pre-release
.PARAMETER Method
    Download via Auto, Gh, or WebRequest
.PARAMETER NonInteractive
    Disable prompts; use stable release and default dir
.PARAMETER Yes
    Auto-answer yes to prompts
.PARAMETER InstallDir
    Use a specific installation directory
.PARAMETER Uninstall
    Remove an existing installation
.PARAMETER DryRun
    Show planned actions without making changes
#>

[CmdletBinding()]
param(
    [string]$Version,
    [switch]$Prerelease,
    [ValidateSet('auto', 'gh', 'webrequest')][string]$Method = 'auto',
    [Alias('n')][switch]$NonInteractive,
    [Alias('y')][switch]$Yes,
    [string]$InstallDir,
    [switch]$Uninstall,
    [switch]$DryRun,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ─── Configuration ───────────────────────────────────────────────────────────
$Repository     = 'QinCai-rui/MeshTalk'
$ReleasesUrl    = "https://github.com/$Repository/releases"
$ApiUrl         = "https://api.github.com/repos/$Repository"


$script:Action         = if ($Uninstall) { 'uninstall' } else { 'install' }
$script:DryRunFlag      = [bool]$DryRun
$script:NonInteractive  = [bool]$NonInteractive
$script:AssumeYes       = [bool]$Yes
$script:VersionSel      = if ($Prerelease) { 'latest-prerelease' } elseif ($Version) { $Version } else { 'latest' }
$script:InstallDirSel   = $InstallDir
$script:DownloadMethod  = $Method.ToLowerInvariant()
$script:AuthToken       = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } elseif ($env:GH_TOKEN) { $env:GH_TOKEN } else { '' }
$script:CHECKSUM_NOTE   = ''
$script:TaskLabel       = ''

if ($Help) {
    @"
MeshTalk Installer

Usage:
  install-meshtalk.ps1 [options]

Options:
  -Version <tag>           Install a specific release tag
  -Prerelease              Install the latest pre-release
  -Method <auto|gh|webrequest>  Download via auto, gh, or webrequest
  -NonInteractive          Disable prompts; use stable release and default dir
  -Yes                     Auto-answer yes to prompts
  -InstallDir <dir>        Use a specific installation directory
  -Uninstall               Remove an existing installation
  -DryRun                  Show planned actions without making changes
  -Help                    Show this help

The installer is intended for Windows PowerShell 5.1+ and PowerShell 7+.
It never requires an elevated (Administrator) session.
"@ | Write-Host
    exit 0
}

# ─── Colors ──────────────────────────────────────────────────────────────────
# PowerShell console coloring is done via Write-Host -ForegroundColor rather
# than embedded ANSI escapes, but we keep ANSI available for hosts that
# support VT sequences (Windows Terminal, pwsh 7+, ConHost with VT enabled).
$script:UseAnsi = $false

function Initialize-Colors {
    $supportsAnsi = $false
    try {
        if ($Host.UI.SupportsVirtualTerminal) { $supportsAnsi = $true }
    } catch { }
    if ($env:FORCE_COLOR) { $supportsAnsi = $true }
    if (-not [Console]::IsOutputRedirected -and $supportsAnsi) {
        $script:UseAnsi = $true
    }

    if ($script:UseAnsi) {
        $script:RESET      = "`e[0m"
        $script:BOLD       = "`e[1m"
        $script:DIM        = "`e[2m"
        $script:DIM_BOLD   = "`e[2;1m"
        $script:UNDERLINE  = "`e[4m"
        $script:BLUE       = "`e[94m"
        $script:CYAN       = "`e[96m"
        $script:GREEN      = "`e[32m"
        $script:YELLOW     = "`e[33m"
        $script:RED        = "`e[91m"
        $script:GRAY       = "`e[90m"
        $script:PURPLE     = "`e[95m"
        $script:WHITE      = "`e[97m"
    } else {
        $script:RESET = $script:BOLD = $script:DIM = $script:DIM_BOLD = $script:UNDERLINE = ''
        $script:BLUE = $script:CYAN = $script:GREEN = $script:YELLOW = ''
        $script:RED = $script:GRAY = $script:PURPLE = $script:WHITE = ''
    }
    $script:TICK  = "$($script:GREEN)✓$($script:RESET)"
    $script:CROSS = "$($script:RED)✗$($script:RESET)"
    $script:INFO  = "$($script:CYAN)▸$($script:RESET)"
    $script:ARROW = "$($script:GREEN)→$($script:RESET)"
}

# ─── UI Helpers ──────────────────────────────────────────────────────────────
function Write-Divider {
    Write-Host "  $($script:CYAN)────────────────────────────────────────────────────────$($script:RESET)"
}

function Start-Panel {
    param(
        [string]$Title,
        [string]$Color = $script:CYAN
    )
    Write-Host ''
    Write-Host "  $Color╭─ $($script:BOLD)$Title$($script:RESET)"
}

function Write-PanelLine {
    param(
        [string]$Line,
        [string]$Color = $script:CYAN
    )
    Write-Host "  $Color│$($script:RESET)  $Line"
}

function Stop-Panel {
    param([string]$Color = $script:CYAN)
    Write-Host "  $Color╰────────────────────────────────────────────────────────$($script:RESET)"
}

function Write-PanelKv {
    param([string]$Key, [string]$Value)
    $paddedKey = $Key.PadRight(10)
    Write-Host "  $($script:CYAN)│$($script:RESET) $($script:DIM_BOLD)$paddedKey$($script:RESET) $Value"
}

function Invoke-Die {
    param([string]$Message)
    if ($script:TaskLabel) {
        try { Complete-Step -Marker $script:CROSS } catch { }
    }
    Write-Host ''
    Write-Host "  $($script:RED)$($script:BOLD)ERROR$($script:RESET) $Message"
    Write-Divider
    exit 1
}

function Write-WarnMsg {
    param([string]$Message)
    Write-Host "  $($script:YELLOW)$($script:BOLD)⚠ WARNING$($script:RESET) $Message"
}

function Write-Info {
    param([string]$Message)
    Write-Host "  $($script:INFO) $Message"
}

function Write-Verbose2 {
    param([string]$Message)
    Write-Host "  $($script:INFO) $Message"
}

function Write-Success {
    param([string]$Message)
    Write-Host "  $($script:TICK) $Message"
}

function Start-Step {
    param([string]$Label)
    $script:TaskLabel = $Label
    if ([Console]::IsOutputRedirected -or -not $script:UseAnsi) {
        Write-Host "  $($script:INFO)  $Label..."
    } else {
        Write-Host -NoNewline "  $($script:INFO)  $Label..."
    }
}

function Complete-Step {
    param(
        [string]$Marker = $script:TICK,
        [string]$CompletedLabel = $script:TaskLabel
    )
    if ([Console]::IsOutputRedirected -or -not $script:UseAnsi) {
        Write-Host "  $Marker  $CompletedLabel"
    } else {
        Write-Host "`e[2K`r  $Marker  $CompletedLabel"
    }
    $script:TaskLabel = ''
}

function Read-Confirmation {
    param(
        [string]$Prompt,
        [string]$Default = 'n'
    )

    if ($script:AssumeYes) { return $true }
    if ($script:NonInteractive) { return $false }
    Write-Host ''
    if ($Default -eq 'y') {
        $answer = Read-Host "  $($script:BOLD)$Prompt$($script:RESET) $($script:DIM)[Y/n]$($script:RESET)"
        return ([string]::IsNullOrEmpty($answer) -or $answer -match '^[Yy]([Ee][Ss])?$')
    } else {
        $answer = Read-Host "  $($script:BOLD)$Prompt$($script:RESET) $($script:DIM)[y/N]$($script:RESET)"
        return ($answer -match '^[Yy]([Ee][Ss])?$')
    }
}

function Read-BoxInput {
    param(
        [string]$Prompt,
        [string]$Default,
        [string]$Color = $script:CYAN
    )

    $hint = if ($Default) { "$($script:DIM)[$Default]$($script:RESET)" } else { '' }
    Stop-Panel -Color $Color
    Write-Host ''
    return (Read-Host "  $($script:BOLD)$Prompt$($script:RESET) $hint")
}

function Read-BoxConfirmation {
    param(
        [string]$Prompt,
        [string]$Default = 'n',
        [string]$Color = $script:RED
    )

    if ($script:AssumeYes) {
        Stop-Panel -Color $Color
        return $true
    }
    if ($script:NonInteractive) {
        Stop-Panel -Color $Color
        return $false
    }

    $hint = if ($Default -eq 'y') {
        "$($script:DIM)[Y/n]$($script:RESET)"
    } else {
        "$($script:DIM)[y/N]$($script:RESET)"
    }
    Stop-Panel -Color $Color
    Write-Host ''
    $answer = Read-Host "  $($script:BOLD)$Prompt$($script:RESET) $hint"

    if ($Default -eq 'y') {
        return ([string]::IsNullOrEmpty($answer) -or $answer -match '^[Yy]([Ee][Ss])?$')
    }
    return ($answer -match '^[Yy]([Ee][Ss])?$')
}

function Read-SecureLine {
    param([string]$PromptText)
    $secure = Read-Host -Prompt $PromptText -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Test-CommandExists {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# ─── Banner ──────────────────────────────────────────────────────────────────
function Show-Banner {
    Write-Host ''
    $banner = @'
███╗   ███╗███████╗███████╗██╗  ██╗████████╗ █████╗ ██╗     ██╗  ██╗
████╗ ████║██╔════╝██╔════╝██║  ██║╚══██╔══╝██╔══██╗██║     ██║ ██╔╝
██╔████╔██║█████╗  ███████╗███████║   ██║   ███████║██║     █████╔╝
██║╚██╔╝██║██╔══╝  ╚════██║██╔══██║   ██║   ██╔══██║██║     ██╔═██╗
██║ ╚═╝ ██║███████╗███████║██║  ██║   ██║   ██║  ██║███████╗██║  ██╗
╚═╝     ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
'@
    Write-Host "$($script:CYAN)$banner$($script:RESET)"
    Write-Divider
    Write-Host "  $($script:DIM)Peer-to-peer encrypted messaging over LAN and UDP.$($script:RESET)"
    Write-Divider
    Write-Host ''
}

# ─── Platform Detection ──────────────────────────────────────────────────────
function Get-PlatformInfo {
    # This script is intended to run under Windows PowerShell / pwsh on Windows,
    # but pwsh also runs on macOS/Linux, so detect accordingly.
    if ($env:OS -eq 'Windows_NT') {
        $script:PlatformName = 'windows'
    } elseif ($IsMacOS) {
        $script:PlatformName = 'macos'
    } elseif ($IsLinux) {
        $script:PlatformName = 'linux'
    } else {
        Invoke-Die "Unsupported operating system."
    }

    $archRaw = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    switch ($archRaw) {
        'X64'   { $script:Arch = 'x64' }
        'Arm64' { $script:Arch = 'arm64' }
        default { Invoke-Die "Unsupported CPU architecture: $archRaw" }
    }

    if ($script:PlatformName -eq 'windows') {
        $script:ExecutableSuffix = '.exe'
        $script:DefaultInstallDir = Join-Path $env:LOCALAPPDATA 'MeshTalk'
    } else {
        $script:ExecutableSuffix = ''
        $script:DefaultInstallDir = Join-Path $HOME '.local/bin'
    }
    $script:AssetArch = $script:Arch
    $script:WindowsArm64Emulation = $false
    if ($script:PlatformName -eq 'windows' -and $script:Arch -eq 'arm64') {
        $script:AssetArch = 'x64'
        $script:WindowsArm64Emulation = $true
    }

    $script:AssetName = "meshtalk-$($script:PlatformName)-$($script:AssetArch)$($script:ExecutableSuffix).tar.gz"
    $script:LauncherName = "meshtalk$($script:ExecutableSuffix)"
    $script:ExpectedFiles = @(
        "meshtalk$($script:ExecutableSuffix)",
        "meshtalk-backend$($script:ExecutableSuffix)"
    )
}

# ─── Validation ──────────────────────────────────────────────────────────────
function Confirm-DownloadMethod {
    switch ($script:DownloadMethod) {
        { $_ -in @('auto', 'gh', 'webrequest') } { }
        default { Invoke-Die "Invalid download method: $($script:DownloadMethod). Use auto, gh, or webrequest." }
    }
}

function Confirm-NotAdministrator {
    if ($script:PlatformName -ne 'windows') { return }
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($isAdmin) {
        Write-WarnMsg "Running with Administrator privileges is not recommended for this installer."
        Write-WarnMsg "Continuing anyway, since Windows does not allow this check to block execution the way root does on POSIX."
    }
}

# ─── GitHub Helpers ──────────────────────────────────────────────────────────
function Get-AuthHeaders {
    $headers = @{ 'Accept' = 'application/vnd.github+json' }
    if ($script:AuthToken) {
        $headers['Authorization'] = "Bearer $($script:AuthToken)"
    }
    return $headers
}

function Invoke-GitHubApi {
    param([string]$Url)
    $headers = Get-AuthHeaders
    try {
        return Invoke-RestMethod -Uri $Url -Headers $headers -Method Get -ErrorAction Stop
    } catch {
        return $null
    }
}

function Invoke-GitHubApiRaw {
    param([string]$Url)
    $headers = Get-AuthHeaders
    try {
        return (Invoke-WebRequest -Uri $Url -Headers $headers -Method Get -ErrorAction Stop).Content
    } catch {
        return $null
    }
}

function Save-UrlToFile {
    param([string]$Url, [string]$Destination)
    $headers = @{}
    if ($script:AuthToken) { $headers['Authorization'] = "Bearer $($script:AuthToken)" }
    try {
        Invoke-WebRequest -Uri $Url -Headers $headers -OutFile $Destination -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Invoke-Gh {
    param([string[]]$GhArgs)
    $output = $null
    if ($script:AuthToken) {
        $oldToken = $env:GH_TOKEN
        $env:GH_TOKEN = $script:AuthToken
        try {
            $output = & gh @GhArgs 2>$null
        } finally {
            $env:GH_TOKEN = $oldToken
        }
    } else {
        $output = & gh @GhArgs 2>$null
    }
    if ($LASTEXITCODE -ne 0) {
        throw "gh exited with code $LASTEXITCODE"
    }
    return $output
}

function Request-Token {
    if ($script:AuthToken) { return $true }
    if ($script:NonInteractive) {
        Invoke-Die "GitHub API access requires GITHUB_TOKEN or GH_TOKEN in non-interactive mode."
    }
    Write-Host ''
    Write-WarnMsg "Anonymous GitHub release access was unavailable."
    Write-Info "Provide a GitHub token, or press Enter to cancel."
    $token = Read-SecureLine "  GitHub token"
    $script:AuthToken = if ($token) { $token } else { '' }
    Write-Host ''
    return [bool]$script:AuthToken
}

function Get-ReleaseApiEndpoint {
    if ($script:VersionSel -eq 'latest') {
        return "$ApiUrl/releases/latest"
    } elseif ($script:VersionSel -eq 'latest-prerelease') {
        return "$ApiUrl/releases?per_page=100"
    } else {
        $encodedVersion = $script:VersionSel -replace '/', '%2F'
        return "$ApiUrl/releases/tags/$encodedVersion"
    }
}

function Get-Sha256OfFile {
    param([string]$Path)
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# ─── Release Loading ─────────────────────────────────────────────────────────
function Import-ReleaseWithGh {
    if (-not (Test-CommandExists 'gh')) { return $false }

    $tag = $null
    try {
        if ($script:VersionSel -eq 'latest') {
            $tag = Invoke-Gh @('release', 'view', '--repo', $Repository, '--json', 'tagName', '--jq', '.tagName')
        } elseif ($script:VersionSel -eq 'latest-prerelease') {
            $tag = Invoke-Gh @('release', 'list', '--repo', $Repository, '--exclude-drafts', '--limit', '100',
                '--json', 'tagName,isPrerelease', '--jq', 'map(select(.isPrerelease))[0].tagName')
        } else {
            $tag = Invoke-Gh @('release', 'view', $script:VersionSel, '--repo', $Repository, '--json', 'tagName', '--jq', '.tagName')
        }
    } catch { return $false }

    if ([string]::IsNullOrWhiteSpace($tag)) { return $false }
    $script:ReleaseTag = $tag.Trim()

    $assetName = $null
    try {
        $assetName = Invoke-Gh @('release', 'view', $script:ReleaseTag, '--repo', $Repository, '--json', 'assets',
            '--jq', ".assets[] | select(.name == ""$($script:AssetName)"") | .name")
    } catch { return $false }
    if ([string]::IsNullOrWhiteSpace($assetName) -or $assetName.Trim() -ne $script:AssetName) { return $false }

    $digest = $null
    try {
        $digest = Invoke-Gh @('release', 'view', $script:ReleaseTag, '--repo', $Repository, '--json', 'assets',
            '--jq', ".assets[] | select(.name == ""$($script:AssetName)"") | .digest")
    } catch { return $false }
    $script:ExpectedDigest = if (-not [string]::IsNullOrWhiteSpace($digest) -and $digest.Trim() -ne 'null') { $digest.Trim() } else { '' }
    $script:DownloadMode = 'gh'
    return $true
}

function Import-ReleaseWithApi {
    param([string]$MetadataFile)

    $endpoint = Get-ReleaseApiEndpoint
    $raw = Invoke-GitHubApiRaw -Url $endpoint
    if (-not $raw) { return $false }
    Set-Content -Path $MetadataFile -Value $raw -NoNewline

    try {
        $data = $raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $false
    }

    if ($script:VersionSel -eq 'latest-prerelease') {
        $candidate = $data | Where-Object { $_.prerelease -eq $true -and $_.draft -eq $false } | Select-Object -First 1
        if (-not $candidate) { return $false }
        $script:ReleaseTag = $candidate.tag_name
        $asset = $candidate.assets | Where-Object { $_.name -eq $script:AssetName } | Select-Object -First 1
        if (-not $asset) { return $false }
        $script:ExpectedDigest = if ($asset.PSObject.Properties['digest']) { $asset.digest } else { '' }
    } else {
        if (-not $data.tag_name) { return $false }
        $script:ReleaseTag = $data.tag_name
        $asset = $data.assets | Where-Object { $_.name -eq $script:AssetName } | Select-Object -First 1
        if (-not $asset) { return $false }
        $script:ExpectedDigest = if ($asset.PSObject.Properties['digest']) { $asset.digest } else { '' }
    }

    if (-not $script:ExpectedDigest) { $script:ExpectedDigest = '' }
    $script:DownloadMode = 'api'
    return $true
}

function Import-Release {
    param([string]$MetadataFile)

    switch ($script:DownloadMethod) {
        'gh' {
            if (-not (Test-CommandExists 'gh')) { Invoke-Die "The forced download method gh is not installed." }
            if (Import-ReleaseWithGh) { return }
            Invoke-Die "Unable to access the GitHub release with gh."
        }
        'webrequest' {
            if (Import-ReleaseWithApi -MetadataFile $MetadataFile) { return }
        }
        'auto' {
            if ((Test-CommandExists 'gh') -and (Import-ReleaseWithGh)) { return }
        }
    }

    if (-not $script:AuthToken) {
        $probe = Invoke-GitHubApiRaw -Url (Get-ReleaseApiEndpoint)
        if (-not $probe) {
            if (-not (Request-Token)) { Invoke-Die "No GitHub token provided. Install/authenticate gh and try again." }
        }
    }

    if (Import-ReleaseWithApi -MetadataFile $MetadataFile) { return }

    if (-not $script:AuthToken) {
        if (-not (Request-Token)) { Invoke-Die "Unable to access the GitHub release." }
        if (-not (Import-ReleaseWithApi -MetadataFile $MetadataFile)) {
            Invoke-Die "Unable to access the GitHub release with the supplied token."
        }
        return
    }

    Invoke-Die "Unable to access the GitHub release. Check the token and release tag."
}

# ─── Pre-release Staleness Check ────────────────────────────────────────────
function Test-StableVsPrerelease {
    if ($script:VersionSel -ne 'latest-prerelease') { return }

    $stableTag = $null
    $stableDate = $null

    if ($script:DownloadMode -eq 'gh') {
        try {
            $stableTag = Invoke-Gh @('release', 'view', '--repo', $Repository, '--json', 'tagName', '--jq', '.tagName')
            if (-not [string]::IsNullOrWhiteSpace($stableTag)) {
                $stableDate = Invoke-Gh @('release', 'view', $stableTag.Trim(), '--repo', $Repository, '--json', 'publishedAt', '--jq', '.publishedAt')
            }
        } catch { return }
    } else {
        $stableJson = Invoke-GitHubApi -Url "$ApiUrl/releases/latest"
        if (-not $stableJson) { return }
        $stableTag = $stableJson.tag_name
        $stableDate = $stableJson.published_at
    }

    if ([string]::IsNullOrWhiteSpace($stableTag)) { return }
    $stableTag = $stableTag.Trim()
    $prereleaseTag = $script:ReleaseTag
    if ($stableTag -eq $prereleaseTag) { return }

    $prereleaseDate = $null
    if ($script:DownloadMode -eq 'gh') {
        try {
            $prereleaseDate = Invoke-Gh @('release', 'view', $prereleaseTag, '--repo', $Repository, '--json', 'publishedAt', '--jq', '.publishedAt')
        } catch { }
    } elseif ($stableDate) {
        $prereleaseJson = Invoke-GitHubApi -Url "$ApiUrl/releases/tags/$prereleaseTag"
        if ($prereleaseJson) { $prereleaseDate = $prereleaseJson.published_at }
    }

    $warnStable = $false
    if ($stableDate -and $prereleaseDate) {
        try {
            $stableEpoch = [DateTimeOffset]::Parse($stableDate.Trim())
            $prereleaseEpoch = [DateTimeOffset]::Parse($prereleaseDate.Trim())
            if ($stableEpoch -gt $prereleaseEpoch) { $warnStable = $true }
        } catch { }
    }

    if ($warnStable) {
        Write-Host ''
        Write-WarnMsg "A stable release $($script:BOLD)$stableTag$($script:RESET)$($script:YELLOW) is newer than pre-release $($script:BOLD)$prereleaseTag$($script:RESET)"
        Write-WarnMsg "The stable release may be more reliable for most users."
        if (-not (Read-Confirmation -Prompt "Continue installing the older pre-release?" -Default 'n')) {
            Invoke-Die "Installation cancelled. Run without -Prerelease to install the stable release."
        }
    }
}

# ─── Download & Verify ───────────────────────────────────────────────────────
function Save-Archive {
    param([string]$Destination)

    if ($script:DownloadMode -eq 'gh') {
        $downloadDir = Split-Path -Parent $Destination
        try {
            Invoke-Gh @('release', 'download', $script:ReleaseTag, '--repo', $Repository,
                '--pattern', $script:AssetName, '--dir', $downloadDir, '--clobber') | Out-Null
        } catch {
            Invoke-Die "gh did not download the expected asset."
        }
        $downloaded = Join-Path $downloadDir $script:AssetName
        if (-not (Test-Path $downloaded)) { Invoke-Die "gh did not download the expected asset." }
        return
    }

    $assetUrl = "$ReleasesUrl/download/$($script:ReleaseTag)/$($script:AssetName)"
    if (-not (Save-UrlToFile -Url $assetUrl -Destination $Destination)) {
        Invoke-Die "Unable to download $($script:AssetName)."
    }
}

function Confirm-Archive {
    param([string]$Archive)

    $expected = $script:ExpectedDigest -replace '^sha256:', ''
    if (-not $expected) { return $false }

    $actual = Get-Sha256OfFile -Path $Archive
    if ($actual.ToLowerInvariant() -ne $expected.ToLowerInvariant()) {
        Invoke-Die "SHA-256 verification failed for $($script:AssetName)."
    }
    return $true
}

# ─── PATH Configuration ──────────────────────────────────────────────────────
function Test-PathEntry {
    param([string]$Dir)
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { return $false }
    $entries = $userPath -split ';' | Where-Object { $_ }
    foreach ($entry in $entries) {
        if ($entry.TrimEnd('\') -ieq $Dir.TrimEnd('\')) { return $true }
    }
    return $false
}

function Set-WindowsUserPath {
    if (Test-PathEntry -Dir $script:InstallDirSel) {
        Write-Verbose2 "$($script:InstallDirSel) is already on the Windows user PATH."
        return
    }

    if (-not (Read-Confirmation -Prompt "Add $($script:InstallDirSel) to the Windows user PATH?" -Default 'y')) {
        Write-Verbose2 "Add this directory to the Windows user PATH manually if needed: $($script:InstallDirSel)"
        return
    }

    try {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $entries = @($userPath -split ';' | Where-Object { $_ })
        $entries += $script:InstallDirSel
        [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
        Write-Verbose2 "Added $($script:InstallDirSel) to the Windows user PATH."
        Write-Verbose2 "Open a new terminal, then run: $($script:LauncherName)"
    } catch {
        Write-WarnMsg "Unable to update the Windows user PATH."
        Write-Verbose2 "Add this directory to the Windows user PATH manually: $($script:InstallDirSel)"
    }
}

function Set-UnixShellPath {
    if (Test-PathEntryUnix -Dir $script:InstallDirSel) {
        Write-Verbose2 "$($script:InstallDirSel) is already on PATH."
        return
    }

    if (-not (Read-Confirmation -Prompt "Add $($script:InstallDirSel) to your shell PATH?" -Default 'y')) {
        Write-Verbose2 "Add this directory to PATH manually if needed: $($script:InstallDirSel)"
        return
    }

    $shellName = if ($env:SHELL) { (Split-Path -Leaf $env:SHELL).ToLowerInvariant() } else { '' }
    if ($shellName -eq 'zsh') {
        $startupFile = "$HOME/.zshrc"
    } elseif ($shellName -eq 'bash') {
        $startupFile = $null
        foreach ($candidate in @("$HOME/.bashrc", "$HOME/.bash_profile", "$HOME/.profile")) {
            if (Test-Path $candidate) { $startupFile = $candidate; break }
        }
        if (-not $startupFile) { $startupFile = "$HOME/.bashrc" }
    } else {
        $shellLabel = if ($shellName) { $shellName } else { 'active shell' }
        $manualCommand = switch ($shellName) {
            'fish' { "fish_add_path `"$($script:InstallDirSel)`"" }
            { $_ -in @('csh', 'tcsh') } { "setenv PATH `"$($script:InstallDirSel):`$PATH`"" }
            default { "export PATH=`"$($script:InstallDirSel):`$PATH`"" }
        }
        Write-WarnMsg "Automatic PATH configuration is unavailable for $shellLabel."
        Write-Info "Configure it manually with: $manualCommand"
        return
    }

    if ((Test-Path $startupFile) -and (Select-String -Path $startupFile -SimpleMatch $script:InstallDirSel -Quiet)) {
        Write-Verbose2 "$($script:InstallDirSel) is already configured in $startupFile."
        return
    }

    Add-Content -Path $startupFile -Value "`n# MeshTalk installer`nexport PATH=`"$($script:InstallDirSel):`$PATH`""
    Write-Verbose2 "Added $($script:InstallDirSel) to $startupFile."
    Write-Verbose2 "Run $($script:BOLD)source $startupFile$($script:RESET) or open a new shell."
}

function Test-PathEntryUnix {
    param([string]$Dir)
    $pathVar = $env:PATH
    if (-not $pathVar) { return $false }
    $entries = $pathVar -split ':'
    return ($entries -contains $Dir)
}

function Set-InstallPath {
    if ($script:PlatformName -eq 'windows') {
        Set-WindowsUserPath
    } else {
        Set-UnixShellPath
    }
}

function Select-Action {
    if ($script:Action -ne 'install' -or $script:VersionSel -ne 'latest' -or $script:InstallDirSel -or $script:DryRunFlag -or $script:NonInteractive) {
        return
    }

    Start-Panel "What would you like to do?"
    Write-PanelLine "$($script:GREEN)1$($script:RESET)  Install or upgrade MeshTalk"
    Write-PanelLine "$($script:GREEN)2$($script:RESET)  Uninstall MeshTalk"
    Write-PanelLine "$($script:DIM)q$($script:RESET)  Quit"
    $choice = Read-BoxInput -Prompt 'Choose' -Default '1' -Color $script:CYAN
    switch ($choice) {
        '' { $script:Action = 'install' }
        '1' { $script:Action = 'install' }
        '2' { $script:Action = 'uninstall' }
        { $_ -in @('q', 'Q') } { exit 0 }
        default { Invoke-Die "Invalid choice. Choose 1, 2, or q." }
    }
}

function Select-Version {
    if ($script:VersionSel -ne 'latest') { return }
    if ($script:NonInteractive) { return }

    Start-Panel "Choose a release channel"
    Write-PanelLine "$($script:GREEN)1$($script:RESET)  Latest stable release $($script:DIM)(recommended)$($script:RESET)"
    Write-PanelLine "$($script:GREEN)2$($script:RESET)  Latest pre-release"
    Write-PanelLine "$($script:GREEN)3$($script:RESET)  Specific release tag"
    $choice = Read-BoxInput -Prompt 'Channel' -Default '1' -Color $script:CYAN
    switch ($choice) {
        '' { $script:VersionSel = 'latest' }
        '1' { $script:VersionSel = 'latest' }
        '2' { $script:VersionSel = 'latest-prerelease' }
        '3' {
            Start-Panel "Release tag"
            $tag = Read-BoxInput -Prompt 'Tag' -Default '' -Color $script:CYAN
            if (-not $tag) { Invoke-Die "A release tag is required." }
            $script:VersionSel = $tag
        }
        default { Invoke-Die "Invalid release channel. Choose 1, 2, or 3." }
    }
}

function Select-InstallDir {
    if (-not $script:InstallDirSel) {
        if (-not $script:NonInteractive) {
            Start-Panel "Installation directory"
            Write-PanelLine "MeshTalk will be installed here. Press Enter to use the default."
            $entered = Read-BoxInput -Prompt 'Directory' -Default $script:DefaultInstallDir -Color $script:CYAN
            if ($entered) { $script:InstallDirSel = $entered }
        }
        if (-not $script:InstallDirSel) { $script:InstallDirSel = $script:DefaultInstallDir }
    }

    if ($script:InstallDirSel -eq '~') {
        $script:InstallDirSel = $HOME
    } elseif ($script:InstallDirSel.StartsWith('~/') -or $script:InstallDirSel.StartsWith('~\')) {
        $script:InstallDirSel = Join-Path $HOME $script:InstallDirSel.Substring(2)
    }
}

function Install-MeshTalk {
    Select-Version
    Select-InstallDir

    if ($script:WindowsArm64Emulation) {
        Write-WarnMsg "Windows ARM64 detected. Installing the x64 build through emulation."
    }

    if ($script:DryRunFlag) {
        Start-Panel "Install preview"
        Write-PanelKv "Platform" "$($script:PlatformName)/$($script:Arch)"
        Write-PanelKv "Release" "$($script:VersionSel)"
        Write-PanelKv "Asset" "$($script:AssetName)"
        Write-PanelKv "Directory" "$($script:InstallDirSel)"
        Stop-Panel
        return
    }

    # Check for existing installation
    if ((Test-Path $script:InstallDirSel) -and -not (Test-Path $script:InstallDirSel -PathType Container)) {
        Invoke-Die "Installation path exists but is not a directory: $($script:InstallDirSel)"
    }

    $existingFile = ''
    foreach ($file in $script:ExpectedFiles) {
        $candidate = Join-Path $script:InstallDirSel $file
        if (Test-Path $candidate) { $existingFile = $file; break }
    }
    if ($existingFile) {
        $existingPath = Join-Path $script:InstallDirSel $existingFile
        Start-Panel "File already exists" -Color $script:RED
        Write-PanelLine "$($script:DIM)$existingPath$($script:RESET)" -Color $script:RED
        if (-not (Read-BoxConfirmation -Prompt "Replace the MeshTalk installation?" -Default 'n' -Color $script:RED)) {
            if (-not $script:NonInteractive) { Invoke-Die "$existingPath already exists. Re-run with -Yes to replace." }
            Write-Info "Installation cancelled."
            return
        }
    }

    # Verify dependencies
    if (-not (Test-CommandExists 'tar')) { Invoke-Die "tar is required to extract release archives (available by default on Windows 10 1803+)." }
    switch ($script:DownloadMethod) {
        'gh' { if (-not (Test-CommandExists 'gh')) { Invoke-Die "The forced download method gh is not installed." } }
    }

    # Set up temp directory
    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("meshtalk-installer." + [System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    try {
        Start-Step "Downloading and preparing MeshTalk $($script:VersionSel)"
        Import-Release -MetadataFile (Join-Path $tempDir 'release.json')
        Test-StableVsPrerelease
        $archive = Join-Path $tempDir $script:AssetName
        Save-Archive -Destination $archive
        if ($script:ExpectedDigest) {
            Confirm-Archive -Archive $archive | Out-Null
        } else {
            Write-WarnMsg "Checksum unavailable; continuing without verification."
        }
        Complete-Step -Marker $script:TICK -CompletedLabel "Download ready ($($script:ReleaseTag))."

        $extractDir = Join-Path $tempDir 'extracted'
        New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

        $listing = & tar -tzf $archive
        if ($LASTEXITCODE -ne 0) { Invoke-Die "Unable to inspect the release archive." }
        foreach ($entry in $listing) {
            if ($entry -match '^[/\\]|^[A-Za-z]:[/\\]|(^|[/\\])\.\.([/\\]|$)') {
                Invoke-Die "The release archive contains an unsafe path: $entry"
            }
        }
        & tar -xzf $archive --no-same-owner --no-same-permissions -C $extractDir
        if ($LASTEXITCODE -ne 0) { Invoke-Die "Unable to extract the release archive." }

        foreach ($file in $script:ExpectedFiles) {
            $extractedFile = Join-Path $extractDir $file
            if (-not (Test-Path $extractedFile -PathType Leaf)) { Invoke-Die "The release archive is missing $file." }
        }

        Start-Step "Installing MeshTalk to $($script:InstallDirSel)"
        New-Item -ItemType Directory -Path $script:InstallDirSel -Force | Out-Null
        foreach ($file in $script:ExpectedFiles) {
            Copy-Item -Path (Join-Path $extractDir $file) -Destination (Join-Path $script:InstallDirSel $file) -Force
        }
        Complete-Step -Marker $script:TICK -CompletedLabel "Installed MeshTalk to $($script:InstallDirSel)."

        Set-InstallPath

        Start-Panel "MeshTalk is ready"
        Write-PanelKv "Version" "$($script:ReleaseTag)"
        Write-PanelKv "Run" "$($script:BOLD)$($script:LauncherName)$($script:RESET)"
        Write-PanelKv "Location" "$($script:InstallDirSel)"
        Stop-Panel
        Write-Info "Open a new terminal if you just added MeshTalk to your PATH."
    } finally {
        Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ─── Uninstall ───────────────────────────────────────────────────────────────
function Uninstall-MeshTalk {
    Select-InstallDir

    if ($script:DryRunFlag) {
        Start-Panel "Uninstall preview"
        Write-PanelKv "Directory" "$($script:InstallDirSel)"
        Stop-Panel
        return
    }

    $found = $false
    foreach ($file in $script:ExpectedFiles) {
        $candidate = Join-Path $script:InstallDirSel $file
        if (Test-Path $candidate) { $found = $true; break }
    }
    if (-not $found) {
        Invoke-Die "No MeshTalk binaries found in $($script:InstallDirSel)."
    }

    Start-Panel "Remove MeshTalk installation" -Color $script:RED
    Write-PanelLine "$($script:DIM)$($script:InstallDirSel)$($script:RESET)" -Color $script:RED
    Write-PanelLine 'This action cannot be undone.' -Color $script:RED
    if (-not (Read-BoxConfirmation -Prompt "Remove MeshTalk from $($script:InstallDirSel)?" -Default 'n' -Color $script:RED)) {
        Write-Info "Uninstall cancelled."
        return
    }

    Start-Step "Removing MeshTalk from $($script:InstallDirSel)"
    foreach ($file in $script:ExpectedFiles) {
        $target = Join-Path $script:InstallDirSel $file
        Remove-Item -Path $target -Force -ErrorAction SilentlyContinue
    }
    Complete-Step -Marker $script:TICK -CompletedLabel "Removed MeshTalk from $($script:InstallDirSel)."
}

# ─── Entry Point ─────────────────────────────────────────────────────────────
function Main {
    Initialize-Colors
    Confirm-DownloadMethod
    Get-PlatformInfo
    Confirm-NotAdministrator
    Show-Banner
    Select-Action

    if ($script:Action -eq 'uninstall') {
        Uninstall-MeshTalk
    } else {
        Install-MeshTalk
    }
}

Main
