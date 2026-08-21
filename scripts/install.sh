#!/usr/bin/env bash

set -Eeuo pipefail

REPOSITORY="QinCai-rui/MeshTalk"
RELEASES_URL="https://github.com/${REPOSITORY}/releases"
API_URL="https://api.github.com/repos/${REPOSITORY}"
METADATA_NAME=".meshtalk-installer"

ACTION="install"
DRY_RUN=0
AS_ROOT=0
VERSION=""
INSTALL_DIR=""
AUTH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

RESET=""
BOLD=""
DIM=""
BLUE=""
CYAN=""
GREEN=""
YELLOW=""
RED=""
TASK_LABEL=""
CHECKSUM_NOTE=""

init_colors() {
  [[ -t 1 && -z ${NO_COLOR:-} ]] || return
  command -v tput >/dev/null 2>&1 || return
  [[ $(tput colors 2>/dev/null || printf 0) -ge 8 ]] || return

  RESET=$(tput sgr0 2>/dev/null || true)
  BOLD=$(tput bold 2>/dev/null || true)
  DIM=$(tput dim 2>/dev/null || true)
  BLUE=$(tput setaf 4 2>/dev/null || true)
  CYAN=$(tput setaf 6 2>/dev/null || true)
  GREEN=$(tput setaf 2 2>/dev/null || true)
  YELLOW=$(tput setaf 3 2>/dev/null || true)
  RED=$(tput setaf 1 2>/dev/null || true)
}

show_banner() {
  printf '\n%s' "$CYAN"
  cat <<'EOF'
███╗   ███╗███████╗███████╗██╗  ██╗████████╗ █████╗ ██╗     ██╗  ██╗
████╗ ████║██╔════╝██╔════╝██║  ██║╚══██╔══╝██╔══██╗██║     ██║ ██╔╝
██╔████╔██║█████╗  ███████╗███████║   ██║   ███████║██║     █████╔╝
██║╚██╔╝██║██╔══╝  ╚════██║██╔══██║   ██║   ██╔══██║██║     ██╔═██╗
██║ ╚═╝ ██║███████╗███████║██║  ██║   ██║   ██║  ██║███████╗██║  ██╗
╚═╝     ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
EOF
  printf '%s\n' "$RESET"
  printf '  %sStandalone installer%s\n\n' "$DIM" "$RESET"
}

print_help() {
  cat <<EOF
MeshTalk installer

Usage:
  $0 [options]

Options:
  --version VERSION       Install a specific release tag instead of prompting.
  --install-dir DIRECTORY Use a specific user-owned installation directory.
  --uninstall             Remove an installation recorded by its metadata file.
  --dry-run               Show the planned action without network or filesystem changes.
  --i-understand-the-risks-of-running-as-root          Allow running as root (not recommended).
  --help                  Show this help.

The installer is intended for Bash on POSIX systems, Git Bash, and WSL.
It never requires root or sudo.
EOF
}

die() {
  task_finish "${RED}[${BOLD}✗${RESET}${RED}]${RESET}" || true
  printf '  %s[%s✗%s] %sError:%s %s\n' "$RED" "$BOLD" "$RESET$RED" "$BOLD" "$RESET" "$*" >&2
  exit 1
}

warn() {
  printf '  %s[%s!%s] %s\n' "$YELLOW" "$BOLD" "$RESET" "$*" >&2
}

info() {
  printf '  %s[%si%s] %s\n' "$CYAN" "$BOLD" "$RESET" "$*"
}

success() {
  printf '  %s[%s✓%s] %s\n' "$GREEN" "$BOLD" "$RESET" "$*"
}

task_start() {
  TASK_LABEL=$1
  printf '  %s[%si%s] %s...' "$CYAN" "$BOLD" "$RESET" "$TASK_LABEL"
}

task_finish() {
  local marker=${1:-"${GREEN}[${BOLD}✓${RESET}${GREEN}]${RESET}"}
  [[ -n $TASK_LABEL ]] || return 0

  if [[ -t 1 ]]; then
    printf '\r\033[K'
  else
    printf '\n'
  fi
  printf '  %s %s\n' "$marker" "$TASK_LABEL"
  TASK_LABEL=""
}

confirm() {
  local prompt=$1
  local default=${2:-n}
  local answer

  if [[ $default == y ]]; then
    prompt_read answer "${BOLD}${prompt}${RESET} ${DIM}[Y/n]${RESET}: " || true
    [[ -z $answer || $answer =~ ^[Yy]([Ee][Ss])?$ ]]
  else
    prompt_read answer "${BOLD}${prompt}${RESET} ${DIM}[y/N]${RESET}: " || true
    [[ $answer =~ ^[Yy]([Ee][Ss])?$ ]]
  fi
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

prompt_read() {
  # Read a line into the named variable, using /dev/tty for curl | bash.
  local silent=0
  if [[ ${1:-} == --silent ]]; then
    silent=1
    shift
  fi

  # When stdin is not a terminal (e.g. curl | bash), read from /dev/tty.
  local __var=$1
  shift
  if [[ -t 0 ]]; then
    if [[ $silent -eq 1 ]]; then read -r -s -p "$*" "$__var"; else read -r -p "$*" "$__var"; fi
  elif [[ -e /dev/tty ]]; then
    if [[ $silent -eq 1 ]]; then read -r -s -p "$*" "$__var" < /dev/tty; else read -r -p "$*" "$__var" < /dev/tty; fi
  else
    if [[ $silent -eq 1 ]]; then read -r -s -p "$*" "$__var"; else read -r -p "$*" "$__var"; fi
  fi
}

require_not_root() {
  if [[ ${AS_ROOT} -eq 0 && ${EUID:-1} -eq 0 ]]; then
    die "Do not run this installer as root. Running as root can overwrite system files, create security vulnerabilities, and cause permission conflicts with your user account. Use --i-understand-the-risks-of-running-as-root if you accept these risks."
  fi
}

detect_platform() {
  local system machine
  system=$(uname -s)
  machine=$(uname -m)

  case $system in
    Darwin)
      PLATFORM=macos
      ;;
    Linux)
      PLATFORM=linux
      ;;
    MINGW*|MSYS*)
      PLATFORM=windows
      ;;
    CYGWIN*)
      die "Cygwin is not supported. Use Git Bash or WSL instead."
      ;;
    *)
      die "Unsupported operating system: $system"
      ;;
  esac

  case $machine in
    x86_64|amd64)
      ARCH=x64
      ;;
    aarch64|arm64)
      ARCH=arm64
      ;;
    *)
      die "Unsupported CPU architecture: $machine"
      ;;
  esac

  if [[ $PLATFORM == windows ]]; then
    EXECUTABLE_SUFFIX=.exe
    DEFAULT_INSTALL_DIR="${HOME}/AppData/Local/MeshTalk"
  else
    EXECUTABLE_SUFFIX=""
    DEFAULT_INSTALL_DIR="${HOME}/.local/bin"
  fi
  DATA_DIR="${HOME}/.meshtalk"
  METADATA_FILE="${DATA_DIR}/${METADATA_NAME}"

  ASSET_ARCH=$ARCH
  WINDOWS_ARM64_EMULATION=0
  if [[ $PLATFORM == windows && $ARCH == arm64 ]]; then
    # GitHub releases currently provide Windows x64 only; Windows ARM64 runs it through emulation.
    ASSET_ARCH=x64
    WINDOWS_ARM64_EMULATION=1
  fi

  ASSET_NAME="meshtalk-${PLATFORM}-${ASSET_ARCH}${EXECUTABLE_SUFFIX}.tar.gz"
  LAUNCHER_NAME="meshtalk${EXECUTABLE_SUFFIX}"
  EXPECTED_FILES=(
    "meshtalk${EXECUTABLE_SUFFIX}"
    "meshtalk-backend${EXECUTABLE_SUFFIX}"
    "meshtalk-cli${EXECUTABLE_SUFFIX}"
    "meshtalk-tui${EXECUTABLE_SUFFIX}"
  )
}

parse_arguments() {
  while (($# > 0)); do
    case $1 in
      --help|-h)
        print_help
        exit 0
        ;;
      --dry-run)
        DRY_RUN=1
        ;;
      --i-understand-the-risks-of-running-as-root)
        AS_ROOT=1
        ;;
      --uninstall)
        ACTION=uninstall
        ;;
      --version)
        (($# >= 2)) || die "--version requires a release tag"
        VERSION=$2
        shift
        ;;
      --version=*)
        VERSION=${1#*=}
        [[ -n $VERSION ]] || die "--version requires a release tag"
        ;;
      --install-dir)
        (($# >= 2)) || die "--install-dir requires a directory"
        INSTALL_DIR=$2
        shift
        ;;
      --install-dir=*)
        INSTALL_DIR=${1#*=}
        [[ -n $INSTALL_DIR ]] || die "--install-dir requires a directory"
        ;;
      *)
        die "Unknown option: $1 (use --help for usage)"
        ;;
    esac
    shift
  done
}

choose_action() {
  if [[ $ACTION != install || -n $VERSION || -n $INSTALL_DIR || $DRY_RUN -eq 1 ]]; then
    return
  fi

  info "Manage a standalone MeshTalk release for the current user."
  printf '\n  %s1%s  Install or upgrade MeshTalk\n' "$BOLD$CYAN" "$RESET"
  printf '  %s2%s  Uninstall MeshTalk\n' "$BOLD$CYAN" "$RESET"
  printf '  %sq%s  Quit\n\n' "$BOLD$CYAN" "$RESET"
  local choice
  prompt_read choice "${BOLD}Choose an action${RESET} ${DIM}[1]${RESET}: " || true
  case ${choice:-1} in
    1) ACTION=install ;;
    2) ACTION=uninstall ;;
    q|Q) exit 0 ;;
    *) die "Invalid choice" ;;
  esac
}

choose_version() {
  if [[ -n $VERSION ]]; then
    return
  fi

  info "Press Enter to install the latest stable release."
  prompt_read VERSION "${BOLD}Release tag${RESET} ${DIM}[latest stable]${RESET}: " || true
  VERSION=${VERSION:-latest}
}

choose_install_dir() {
  if [[ -z $INSTALL_DIR ]]; then
    if [[ $ACTION == uninstall ]]; then
      info "MeshTalk will be removed without root or sudo."
    else
      info "MeshTalk will be installed without root or sudo."
    fi
    prompt_read INSTALL_DIR "${BOLD}Installation directory${RESET} ${DIM}[${DEFAULT_INSTALL_DIR}]${RESET}: " || true
    INSTALL_DIR=${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}
  fi

  # Expand shell-style home paths even when the directory came from an option.
  case $INSTALL_DIR in
    '~') INSTALL_DIR=$HOME ;;
    '~/'*) INSTALL_DIR="$HOME/${INSTALL_DIR:2}" ;;
  esac
}

sha256_file() {
  local file=$1

  if command_exists sha256sum; then
    sha256sum "$file" | awk '{print $1}'
  elif command_exists shasum; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command_exists openssl; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  else
    return 1
  fi
}

curl_args() {
  CURL_ARGS=(-fsSL --retry 2 -H 'Accept: application/vnd.github+json')
  if [[ -n $AUTH_TOKEN ]]; then
    CURL_ARGS+=(-H "Authorization: Bearer ${AUTH_TOKEN}")
  fi
}

fetch_api() {
  local url=$1
  curl_args
  if command_exists curl; then
    curl "${CURL_ARGS[@]}" "$url"
  elif command_exists wget; then
    if [[ -n $AUTH_TOKEN ]]; then
      wget -qO- --header="Accept: application/vnd.github+json" --header="Authorization: Bearer ${AUTH_TOKEN}" "$url"
    else
      wget -qO- --header="Accept: application/vnd.github+json" "$url"
    fi
  else
    return 1
  fi
}

download_url() {
  local url=$1
  local destination=$2
  curl_args
  if command_exists curl; then
    curl "${CURL_ARGS[@]}" -o "$destination" "$url"
  elif command_exists wget; then
    if [[ -n $AUTH_TOKEN ]]; then
      wget -qO "$destination" --header="Authorization: Bearer ${AUTH_TOKEN}" "$url"
    else
      wget -qO "$destination" "$url"
    fi
  else
    return 1
  fi
}

run_gh() {
  if [[ -n $AUTH_TOKEN ]]; then
    GH_TOKEN=$AUTH_TOKEN gh "$@"
  else
    gh "$@"
  fi
}

prompt_for_token() {
  if [[ -n $AUTH_TOKEN ]]; then
    return 0
  fi

  info "Anonymous GitHub release access was unavailable."
  info "Provide a GitHub token, or press Enter to cancel and install/authenticate gh."
  prompt_read --silent AUTH_TOKEN "GitHub token: " || true
  AUTH_TOKEN=${AUTH_TOKEN:-}
  printf '\n'
  [[ -n $AUTH_TOKEN ]]
}

release_api_endpoint() {
  if [[ $VERSION == latest ]]; then
    printf '%s/releases/latest' "$API_URL"
  else
    local encoded_version=${VERSION//\//%2F}
    printf '%s/releases/tags/%s' "$API_URL" "$encoded_version"
  fi
}

load_release_with_gh() {
  local release_ref=$VERSION
  local tag

  if [[ $release_ref == latest ]]; then
    tag=$(run_gh release view --repo "$REPOSITORY" --json tagName --jq '.tagName' 2>/dev/null) || return 1
  else
    tag=$(run_gh release view "$release_ref" --repo "$REPOSITORY" --json tagName --jq '.tagName' 2>/dev/null) || return 1
  fi

  [[ -n $tag ]] || return 1
  RELEASE_TAG=$tag

  local asset_name
  if [[ $release_ref == latest ]]; then
    asset_name=$(run_gh release view --repo "$REPOSITORY" --json assets --jq ".assets[] | select(.name == \"${ASSET_NAME}\") | .name" 2>/dev/null) || return 1
  else
    asset_name=$(run_gh release view "$release_ref" --repo "$REPOSITORY" --json assets --jq ".assets[] | select(.name == \"${ASSET_NAME}\") | .name" 2>/dev/null) || return 1
  fi
  [[ $asset_name == "$ASSET_NAME" ]] || return 1

  if [[ $release_ref == latest ]]; then
    EXPECTED_DIGEST=$(run_gh release view --repo "$REPOSITORY" --json assets --jq ".assets[] | select(.name == \"${ASSET_NAME}\") | .digest" 2>/dev/null) || return 1
  else
    EXPECTED_DIGEST=$(run_gh release view "$release_ref" --repo "$REPOSITORY" --json assets --jq ".assets[] | select(.name == \"${ASSET_NAME}\") | .digest" 2>/dev/null) || return 1
  fi
  [[ $EXPECTED_DIGEST != null ]] || EXPECTED_DIGEST=""
  DOWNLOAD_MODE=gh
}

json_value_without_jq() {
  local key=$1
  local file=$2
  tr '\n' ' ' < "$file" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

json_asset_exists_without_jq() {
  local asset_name=$1
  local file=$2
  local compact_json

  compact_json=$(tr '\n' ' ' < "$file" | tr -d '[:space:]')
  case $compact_json in
    *"\"name\":\"${asset_name}\""*) return 0 ;;
    *) return 1 ;;
  esac
}

load_release_with_api() {
  local metadata_file=$1
  local endpoint
  endpoint=$(release_api_endpoint)
  fetch_api "$endpoint" > "$metadata_file" || return 1

  if command_exists jq; then
    RELEASE_TAG=$(jq -er '.tag_name' "$metadata_file") || return 1
    local asset_name
    asset_name=$(jq -er --arg name "$ASSET_NAME" '.assets[] | select(.name == $name) | .name' "$metadata_file") || return 1
    [[ $asset_name == "$ASSET_NAME" ]] || return 1
    EXPECTED_DIGEST=$(jq -r --arg name "$ASSET_NAME" '.assets[] | select(.name == $name) | .digest // empty' "$metadata_file") || return 1
  else
    RELEASE_TAG=$(json_value_without_jq tag_name "$metadata_file")
    [[ -n $RELEASE_TAG ]] || return 1
    json_asset_exists_without_jq "$ASSET_NAME" "$metadata_file" || return 1
    CHECKSUM_NOTE="jq is not installed; the release asset name was checked, but its checksum cannot be verified."
    EXPECTED_DIGEST=""
  fi

  DOWNLOAD_MODE=api
}

load_release() {
  local metadata_file=$1

  if command_exists gh && load_release_with_gh; then
    return 0
  fi

  if [[ -z $AUTH_TOKEN ]] && ! fetch_api "$(release_api_endpoint)" >/dev/null 2>&1; then
    prompt_for_token || die "No GitHub token provided. Install/authenticate gh and try again."
  fi

  if load_release_with_api "$metadata_file"; then
    return 0
  fi

  if [[ -z $AUTH_TOKEN ]]; then
    prompt_for_token || die "Unable to access the GitHub release."
    load_release_with_api "$metadata_file" || die "Unable to access the GitHub release with the supplied token."
    return 0
  fi

  die "Unable to access the GitHub release. Check the token and release tag."
}

download_archive() {
  local destination=$1

  if [[ $DOWNLOAD_MODE == gh ]]; then
    local download_dir
    download_dir=$(dirname "$destination")
    run_gh release download "$RELEASE_TAG" \
      --repo "$REPOSITORY" \
      --pattern "$ASSET_NAME" \
      --dir "$download_dir" \
      --clobber >/dev/null
    [[ -f "$download_dir/$ASSET_NAME" ]] || die "gh did not download the expected asset."
    return
  fi

  local asset_url="${RELEASES_URL}/download/${RELEASE_TAG}/${ASSET_NAME}"
  download_url "$asset_url" "$destination" || die "Unable to download ${ASSET_NAME}."
}

verify_archive() {
  local archive=$1
  local expected=${EXPECTED_DIGEST#sha256:}

  if [[ -z $expected ]]; then
    return 1
  fi

  local actual
  actual=$(sha256_file "$archive") || die "Cannot verify the download: no SHA-256 tool (sha256sum, shasum, or openssl) is available."
  local actual_lower expected_lower
  actual_lower=$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')
  expected_lower=$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')
  if [[ $actual_lower != "$expected_lower" ]]; then
    die "SHA-256 verification failed for ${ASSET_NAME}."
  fi
}

is_path_entry() {
  case :${PATH:-}: in
    *:"$1":*) return 0 ;;
    *) return 1 ;;
  esac
}

configure_windows_path() {
  if ! command_exists cygpath || ! command_exists powershell.exe; then
    warn "Cannot update the Windows user PATH automatically."
    info "Add this directory to the Windows user PATH manually: ${INSTALL_DIR}"
    return
  fi

  local windows_dir result
  windows_dir=$(cygpath -w "$INSTALL_DIR") || die "Unable to convert the installation directory to a Windows path."
  if ! confirm "Add ${windows_dir} to the Windows user PATH for Command Prompt and PowerShell?" y; then
    info "Add this directory to the Windows user PATH manually if needed: ${windows_dir}"
    return
  fi

  result=$(MESHTALK_INSTALL_DIR="$windows_dir" powershell.exe -NoProfile -NonInteractive -Command '$dir = $env:MESHTALK_INSTALL_DIR.TrimEnd([IO.Path]::DirectorySeparatorChar); $path = [Environment]::GetEnvironmentVariable("Path", "User"); $entries = @($path -split ";" | Where-Object { $_ }); if (@($entries | Where-Object { $_.TrimEnd([IO.Path]::DirectorySeparatorChar) -ieq $dir }).Count -gt 0) { "already" } else { [Environment]::SetEnvironmentVariable("Path", (($entries + $dir) -join ";"), "User"); "added" }' 2>/dev/null) || {
    warn "Unable to update the Windows user PATH."
    info "Add this directory to the Windows user PATH manually: ${windows_dir}"
    return
  }

  if [[ $result == already ]]; then
    info "${windows_dir} is already on the Windows user PATH."
  else
    success "Added ${windows_dir} to the Windows user PATH."
  fi
  info "Open a new Command Prompt or PowerShell window, then run: ${LAUNCHER_NAME}"
}

configure_path() {
  if [[ $PLATFORM == windows ]]; then
    configure_windows_path
    return
  fi

  if is_path_entry "$INSTALL_DIR"; then
    info "${INSTALL_DIR} is already on PATH."
    return
  fi

  if ! confirm "Add ${INSTALL_DIR} to Bash PATH?" y; then
    info "Add this directory to PATH manually if needed: ${INSTALL_DIR}"
    return
  fi

  local startup_file
  if [[ -f ${HOME}/.bashrc ]]; then
    startup_file=${HOME}/.bashrc
  elif [[ -f ${HOME}/.bash_profile ]]; then
    startup_file=${HOME}/.bash_profile
  elif [[ -f ${HOME}/.profile ]]; then
    startup_file=${HOME}/.profile
  else
    startup_file=${HOME}/.bashrc
  fi

  if [[ -f $startup_file ]] && grep -Fq -- "$INSTALL_DIR" "$startup_file"; then
    info "${INSTALL_DIR} is already configured in ${startup_file}."
    return
  fi

  {
    printf '\n# MeshTalk installer\n'
    printf 'export PATH=%q:$PATH\n' "$INSTALL_DIR"
  } >> "$startup_file"
  success "Added ${INSTALL_DIR} to ${startup_file}."
  info "Open a new shell, or run:"
  printf '  %ssource %s%s\n' "$BOLD" "$startup_file" "$RESET"
}

install_mesh_talk() {
  choose_version
  choose_install_dir

  if [[ $WINDOWS_ARM64_EMULATION -eq 1 ]]; then
    warn "Windows ARM64 detected. MeshTalk has no native ARM64 Windows release; installing the x64 build through Windows emulation."
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    info "No network or filesystem changes will be made."
    info "Platform: ${PLATFORM}/${ARCH}"
    info "Requested release: ${VERSION}"
    info "GitHub asset: ${ASSET_NAME}"
    info "Installation directory: ${INSTALL_DIR}"
    return
  fi

  if [[ -e $INSTALL_DIR && ! -d $INSTALL_DIR ]]; then
    die "Installation path exists but is not a directory: ${INSTALL_DIR}"
  fi
  if [[ -f $METADATA_FILE ]]; then
    local existing_version
    existing_version=$(sed -n 's/^version=//p' "$METADATA_FILE")
    if ! confirm "MeshTalk ${existing_version:-from this installer} is already installed in ${INSTALL_DIR}. Replace it?" n; then
      info "Installation cancelled."
      return
    fi
  else
    local existing_file=""
    for file in "${EXPECTED_FILES[@]}"; do
      if [[ -e $INSTALL_DIR/$file || -L $INSTALL_DIR/$file ]]; then
        existing_file=$file
        break
      fi
    done
    if [[ -n $existing_file ]] && ! confirm "${INSTALL_DIR}/${existing_file} already exists. Replace the MeshTalk installation?" n; then
      info "Installation cancelled."
      return
    fi
  fi

  command_exists tar || die "tar is required to extract release archives."
  if ! command_exists gh && ! command_exists curl && ! command_exists wget; then
    die "gh, curl, or wget is required to download releases."
  fi

  local temp_dir archive extract_dir file archive_listing archive_entry download_source
  temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/meshtalk-installer.XXXXXX")
  cleanup_temp() {
    rm -rf "$temp_dir"
  }
  trap cleanup_temp EXIT

  task_start "Resolving MeshTalk ${VERSION} release metadata"
  load_release "$temp_dir/release.json"
  task_finish
  info "Release ${RELEASE_TAG}; selected asset ${ASSET_NAME}."
  [[ -z $CHECKSUM_NOTE ]] || info "$CHECKSUM_NOTE"
  archive="$temp_dir/$ASSET_NAME"
  if [[ $DOWNLOAD_MODE == gh ]]; then
    download_source="GitHub CLI"
  else
    download_source="GitHub Releases API"
  fi
  task_start "Downloading ${ASSET_NAME} from GitHub Releases via ${download_source}"
  download_archive "$archive"
  task_finish

  if [[ -n ${EXPECTED_DIGEST:-} ]]; then
    task_start "Verifying SHA-256 digest from GitHub release metadata"
    verify_archive "$archive"
    task_finish
  elif [[ -z $CHECKSUM_NOTE ]]; then
    info "Checksum verification skipped because GitHub digest metadata is unavailable."
  fi

  task_start "Extracting standalone MeshTalk binaries"
  extract_dir="$temp_dir/extracted"
  mkdir -p "$extract_dir"
  archive_listing=$(tar -tzf "$archive") || die "Unable to inspect the release archive."
  while IFS= read -r archive_entry; do
    case $archive_entry in
      /*|../*|*/../*|*/..|..)
        die "The release archive contains an unsafe path: ${archive_entry}"
        ;;
    esac
  done <<< "$archive_listing"
  tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$extract_dir"
  for file in "${EXPECTED_FILES[@]}"; do
    [[ -f $extract_dir/$file && ! -L $extract_dir/$file ]] || die "The release archive is missing a regular ${file}."
  done
  task_finish

  task_start "Installing MeshTalk binaries to ${INSTALL_DIR}"
  mkdir -p "$INSTALL_DIR"
  for file in "${EXPECTED_FILES[@]}"; do
    cp "$extract_dir/$file" "$INSTALL_DIR/$file"
    chmod u+rx "$INSTALL_DIR/$file"
  done
  mkdir -p "$DATA_DIR"
  {
    printf 'version=%s\n' "$RELEASE_TAG"
    printf 'asset=%s\n' "$ASSET_NAME"
    printf 'files=%s\n' "$(IFS=,; printf '%s' "${EXPECTED_FILES[*]}")"
  } > "$METADATA_FILE"
  task_finish

  configure_path
  printf '\n'
  info "Binary: ${INSTALL_DIR}/${LAUNCHER_NAME}"
  info "MeshTalk data: ${HOME}/.meshtalk"
  info "Installer metadata: ${METADATA_FILE}"
  success "Installation complete! Run ${LAUNCHER_NAME} to get started."
  cleanup_temp
  trap - EXIT
}

uninstall_mesh_talk() {
  choose_install_dir

  if [[ $DRY_RUN -eq 1 ]]; then
    info "No network or filesystem changes will be made."
    info "Would inspect installer metadata in: ${METADATA_FILE}"
    return
  fi

  local metadata_file=$METADATA_FILE
  [[ -f $metadata_file ]] || die "No MeshTalk installer metadata found in ${metadata_file}."

  local version files file
  version=$(sed -n 's/^version=//p' "$metadata_file")
  files=$(sed -n 's/^files=//p' "$metadata_file")
  [[ -n $files ]] || die "Installer metadata is incomplete: ${metadata_file}"
  if ! confirm "Remove MeshTalk ${version:-installation} from ${INSTALL_DIR}?" n; then
    info "Uninstall cancelled."
    return
  fi

  task_start "Removing MeshTalk ${version:-installation} from ${INSTALL_DIR}"
  IFS=',' read -r -a installed_files <<< "$files"
  for file in "${installed_files[@]}"; do
    case $file in
      meshtalk|meshtalk-backend|meshtalk-cli|meshtalk-tui|meshtalk.exe|meshtalk-backend.exe|meshtalk-cli.exe|meshtalk-tui.exe) ;;
      *) die "Refusing to remove an unsafe metadata path." ;;
    esac
    rm -f -- "$INSTALL_DIR/$file"
  done
  rm -f -- "$metadata_file"
  task_finish
  success "MeshTalk was uninstalled from ${INSTALL_DIR}."
}

main() {
  init_colors
  parse_arguments "$@"
  require_not_root
  detect_platform
  show_banner
  choose_action

  if [[ $ACTION == uninstall ]]; then
    choose_install_dir
    uninstall_mesh_talk
  else
    install_mesh_talk
  fi
}

main "$@"
