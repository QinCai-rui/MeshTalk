#!/usr/bin/env bash

set -Eeuo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
REPOSITORY="QinCai-rui/MeshTalk"
RELEASES_URL="https://github.com/${REPOSITORY}/releases"
API_URL="https://api.github.com/repos/${REPOSITORY}"


ACTION="install"
DRY_RUN=0
AS_ROOT=0
NON_INTERACTIVE=0
ASSUME_YES=0
SIMPLE_MODE=0
LONG_OUTPUT=0
VERSION=""
INSTALL_DIR=""
DOWNLOAD_METHOD=auto
AUTH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

# ─── Colors ──────────────────────────────────────────────────────────────────
RESET="" BOLD="" DIM="" DIM_BOLD="" UNDERLINE=""
BLUE="" CYAN="" GREEN="" YELLOW="" RED="" GRAY="" PURPLE="" WHITE=""
TICK="" CROSS="" INFO="" OVER="" ARROW=""
TASK_LABEL="" CHECKSUM_NOTE=""

init_colors() {
  if { [ -t 1 ] && [ "$(tput colors 2>/dev/null || printf 0)" -ge 8 ]; } || [ "${FORCE_COLOR:-}" ]; then
    RESET=$'\e[0m'
    BOLD=$'\e[1m'
    DIM=$'\e[2m'
    DIM_BOLD=$'\e[2;1m'
    UNDERLINE=$'\e[4m'
    BLUE=$'\e[94m'
    CYAN=$'\e[96m'
    GREEN=$'\e[32m'
    YELLOW=$'\e[33m'
    RED=$'\e[91m'
    GRAY=$'\e[90m'
    PURPLE=$'\e[95m'
    WHITE=$'\e[97m'
  else
    RESET="" BOLD="" DIM="" DIM_BOLD="" UNDERLINE=""
    BLUE="" CYAN="" GREEN="" YELLOW="" RED="" GRAY="" PURPLE="" WHITE=""
  fi
  TICK="${GREEN}✓${RESET}"
  CROSS="${RED}✗${RESET}"
  INFO="${CYAN}▸${RESET}"
  OVER=$'\r\e[K'
  ARROW="${GREEN}→${RESET}"
}

# ─── UI Helpers ──────────────────────────────────────────────────────────────
divider() {
  printf '  %s────────────────────────────────────────────────────────%s\n' "$CYAN" "$RESET"
}

panel_start() {
  printf '\n  %s╭─ %s%s%s\n' "$CYAN" "$BOLD" "$1" "$RESET"
}

panel_line() {
  printf '  %s│%s %b\n' "$CYAN" "$RESET" "$1"
}

panel_end() {
  printf '  %s╰────────────────────────────────────────────────────────%s\n' "$CYAN" "$RESET"
}

panel_kv() {
  printf '  %s│%s %s%-10s%s %b\n' "$CYAN" "$RESET" "$DIM_BOLD" "$1" "$RESET" "$2"
}

clear_prompt_panel() {
  local lines=${1:-8}
  [[ -t 1 ]] || return 0
  local line
  for ((line = 0; line < lines; line++)); do
    printf '\033[1A\033[2K'
  done
  printf '\r'
}

# Live single-line progress. Overwrites itself until step_done is called.
step() {
  STEP_NUM=${STEP_NUM:-0}
  STEP_NUM=$((STEP_NUM + 1))
  TASK_LABEL=$1
  [[ -t 1 ]] || return
  if [[ $LONG_OUTPUT -eq 1 ]]; then
    printf '  %s[%s/5] %s...' "$CYAN" "$STEP_NUM" "$1"
  else
    printf '\r\033[2K  %s%s...' "$INFO" "$1"
  fi
}

# Resolve the overwriting line to a final status.
step_done() {
  local marker=${1:-"${GREEN}✓${RESET}"}
  local completed_label=${2:-$TASK_LABEL}
  if [[ $LONG_OUTPUT -eq 1 || ! -t 1 ]]; then
    [[ -t 1 ]] && printf '\033[2K\r'
    printf '  %s[%s/5] %s %s\n' "$CYAN" "$STEP_NUM" "$marker" "$completed_label"
  else
    printf '\033[2K\r  %s %s' "$marker" "$completed_label"
  fi
  TASK_LABEL=""
}

die() {
  step_done "${CROSS}" 2>/dev/null || true
  printf '\n  %sERROR%s %s\n' "${RED}${BOLD}" "$RESET" "$*" >&2
  divider
  exit 1
}

warn() {
  printf '  %s%sWARNING%s %s\n' "${YELLOW}${BOLD}" "⚠" "$RESET" "$*" >&2
}

info() {
  printf '  %s %s\n' "$INFO" "$*"
}

verbose() {
  [[ $SIMPLE_MODE -eq 0 && $LONG_OUTPUT -eq 1 ]] || return 0
  printf '  %s %s\n' "$INFO" "$*"
}

success() {
  printf '  %s %s\n' "${TICK}" "$*"
}

task_start() {
  TASK_LABEL=$1
  [[ -t 1 ]] || return
  printf '\r\033[2K  %s %s...' "$INFO" "$TASK_LABEL"
}

task_finish() {
  local marker=${1:-"${GREEN}✓${RESET}"}
  local completed_label=${2:-$TASK_LABEL}
  local lines_to_clear=${3:-1}
  [[ -n $TASK_LABEL ]] || return 0
  if [[ -t 1 ]]; then
    local line
    for ((line = 0; line < lines_to_clear; line++)); do
      printf '\033[2K'
      (( line + 1 < lines_to_clear )) && printf '\033[1A'
    done
    printf '\r'
  fi
  printf '  %s %s\n' "$marker" "$completed_label"
  TASK_LABEL=""
}

confirm() {
  local prompt=$1
  local default=${2:-n}
  local force_prompt=${3:-0}
  local answer

  [[ $ASSUME_YES -eq 1 ]] && return 0
  [[ $NON_INTERACTIVE -eq 1 ]] && return 1
  if [[ $SIMPLE_MODE -eq 1 && $force_prompt -eq 0 ]]; then
    [[ $default == y ]]
    return
  fi

  if [[ $default == y ]]; then
    prompt_read answer $'\n  '"${BOLD}${prompt}${RESET} ${DIM}[Y/n]${RESET} " || true
    [[ -z $answer || $answer =~ ^[Yy]([Ee][Ss])?$ ]]
  else
    prompt_read answer $'\n  '"${BOLD}${prompt}${RESET} ${DIM}[y/N]${RESET} " || true
    [[ $answer =~ ^[Yy]([Ee][Ss])?$ ]]
  fi
}

prompt_read() {
  local silent=0
  if [[ ${1:-} == --silent ]]; then
    silent=1
    shift
  fi
  local __var=$1
  shift
  local prompt_str=$1
  shift
  if [[ -t 0 ]]; then
    if [[ $silent -eq 1 ]]; then read -r -s -p "$prompt_str" "$__var"; else read -r -p "$prompt_str" "$__var"; fi
  elif [[ -e /dev/tty ]]; then
    if [[ $silent -eq 1 ]]; then read -r -s -p "$prompt_str" "$__var" < /dev/tty; else read -r -p "$prompt_str" "$__var" < /dev/tty; fi
  else
    if [[ $silent -eq 1 ]]; then read -r -s -p "$prompt_str" "$__var"; else read -r -p "$prompt_str" "$__var"; fi
  fi
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# ─── Banner ──────────────────────────────────────────────────────────────────
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
  divider
  printf '  %sPeer-to-peer encrypted messaging over LAN and UDP.%s\n' "$DIM" "$RESET"
  divider
  printf '\n'
}

# ─── Help ────────────────────────────────────────────────────────────────────
print_help() {
  cat <<EOF
${BOLD}MeshTalk Installer${RESET}

${UNDERLINE}Usage:${RESET}
  $0 [options]

${UNDERLINE}Options:${RESET}
  ${GREEN}-s, --simple${RESET}            Accept defaults; only ask before replace/uninstall
  ${GREEN}    --long${RESET}               Keep panels and completed progress visible
  ${GREEN}    --version VERSION${RESET}    Install a specific release tag
  ${GREEN}    --prerelease${RESET}         Install the latest pre-release
  ${GREEN}    --method METHOD${RESET}      Download via auto, gh, curl, or wget
  ${GREEN}-n, --non-interactive${RESET}   Disable prompts; use stable release and default dir
  ${GREEN}-y, --yes${RESET}               Auto-answer yes to prompts
  ${GREEN}    --install-dir DIR${RESET}   Use a specific installation directory
  ${GREEN}    --uninstall${RESET}          Remove an existing installation
  ${GREEN}    --dry-run${RESET}            Show planned actions without making changes
  ${GREEN}    --i-understand-the-risks-of-running-as-root${RESET}
                              Allow running as root (not recommended)
  ${GREEN}    --help${RESET}               Show this help

${DIM}The installer is intended for Bash on POSIX systems, Git Bash, and WSL.
It never requires root or sudo.${RESET}
EOF
}

# ─── Platform Detection ──────────────────────────────────────────────────────
detect_platform() {
  local system machine
  system=$(uname -s)
  machine=$(uname -m)

  case $system in
    Darwin)    PLATFORM=macos ;;
    Linux)     PLATFORM=linux ;;
    MINGW*|MSYS*) PLATFORM=windows ;;
    CYGWIN*)   die "Cygwin is not supported. Use Git Bash or WSL instead." ;;
    *)         die "Unsupported operating system: $system" ;;
  esac

  case $machine in
    x86_64|amd64)  ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *)             die "Unsupported CPU architecture: $machine" ;;
  esac

  if [[ $PLATFORM == windows ]]; then
    EXECUTABLE_SUFFIX=.exe
    DEFAULT_INSTALL_DIR="${HOME}/AppData/Local/MeshTalk"
  else
    EXECUTABLE_SUFFIX=""
    DEFAULT_INSTALL_DIR="${HOME}/.local/bin"
  fi
  ASSET_ARCH=$ARCH
  WINDOWS_ARM64_EMULATION=0
  if [[ $PLATFORM == windows && $ARCH == arm64 ]]; then
    ASSET_ARCH=x64
    WINDOWS_ARM64_EMULATION=1
  fi

  ASSET_NAME="meshtalk-${PLATFORM}-${ASSET_ARCH}${EXECUTABLE_SUFFIX}.tar.gz"
  LAUNCHER_NAME="meshtalk${EXECUTABLE_SUFFIX}"
  EXPECTED_FILES=(
    "meshtalk${EXECUTABLE_SUFFIX}"
    "meshtalk-backend${EXECUTABLE_SUFFIX}"
  )
}

# ─── Argument Parsing ────────────────────────────────────────────────────────
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
      --non-interactive|-n)
        NON_INTERACTIVE=1
        ;;
      --simple|-s)
        SIMPLE_MODE=1
        ;;
      --long)
        LONG_OUTPUT=1
        ;;
      --yes|-y)
        ASSUME_YES=1
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
      --prerelease)
        VERSION=latest-prerelease
        ;;
      --method)
        (($# >= 2)) || die "--method requires auto, gh, curl, or wget"
        DOWNLOAD_METHOD=$2
        shift
        ;;
      --method=*)
        DOWNLOAD_METHOD=${1#*=}
        [[ -n $DOWNLOAD_METHOD ]] || die "--method requires auto, gh, curl, or wget"
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

  case $DOWNLOAD_METHOD in
    auto|gh|curl|wget) ;;
    *) die "Invalid download method: ${DOWNLOAD_METHOD}. Use auto, gh, curl, or wget." ;;
  esac
}

require_not_root() {
  if [[ ${AS_ROOT} -eq 0 && ${EUID:-1} -eq 0 ]]; then
    die "Do not run this installer as root.\n    Use --i-understand-the-risks-of-running-as-root if you accept these risks."
  fi
}

# ─── GitHub Helpers ──────────────────────────────────────────────────────────
curl_args() {
  CURL_ARGS=(-fSL --retry 2 -H 'Accept: application/vnd.github+json')
  if [[ -n $AUTH_TOKEN ]]; then
    CURL_ARGS+=(-H "Authorization: Bearer ${AUTH_TOKEN}")
  fi
}

fetch_api() {
  local url=$1
  curl_args
  if [[ $DOWNLOAD_METHOD == wget ]]; then
    if [[ -n $AUTH_TOKEN ]]; then
      wget -qO- --header="Accept: application/vnd.github+json" --header="Authorization: Bearer ${AUTH_TOKEN}" "$url"
    else
      wget -qO- --header="Accept: application/vnd.github+json" "$url"
    fi
  elif command_exists curl; then
    curl "${CURL_ARGS[@]}" "$url" 2>/dev/null
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
  if [[ $DOWNLOAD_METHOD == wget ]]; then
    if [[ -n $AUTH_TOKEN ]]; then
      wget --show-progress -O "$destination" --header="Authorization: Bearer ${AUTH_TOKEN}" "$url"
    else
      wget --show-progress -O "$destination" "$url"
    fi
  elif command_exists curl; then
    curl --progress-bar "${CURL_ARGS[@]}" -o "$destination" "$url"
  elif command_exists wget; then
    if [[ -n $AUTH_TOKEN ]]; then
      wget --show-progress -O "$destination" --header="Authorization: Bearer ${AUTH_TOKEN}" "$url"
    else
      wget --show-progress -O "$destination" "$url"
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
  [[ -n $AUTH_TOKEN ]] && return 0
  [[ $NON_INTERACTIVE -eq 0 && $SIMPLE_MODE -eq 0 ]] || die "GitHub API access requires GITHUB_TOKEN or GH_TOKEN in simple or non-interactive mode."
  printf '\n'
  warn "Anonymous GitHub release access was unavailable."
  info "Provide a GitHub token, or press Enter to cancel."
  prompt_read --silent AUTH_TOKEN "  GitHub token: " || true
  AUTH_TOKEN=${AUTH_TOKEN:-}
  printf '\n'
  [[ -n $AUTH_TOKEN ]]
}

json_value_without_jq() {
  local key=$1
  local file=${2:-}
  if [[ -n $file ]]; then
    tr '\n' ' ' < "$file" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
  else
    tr '\n' ' ' | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
  fi
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

release_api_endpoint() {
  if [[ $VERSION == latest ]]; then
    printf '%s/releases/latest' "$API_URL"
  elif [[ $VERSION == latest-prerelease ]]; then
    printf '%s/releases?per_page=100' "$API_URL"
  else
    local encoded_version=${VERSION//\//%2F}
    printf '%s/releases/tags/%s' "$API_URL" "$encoded_version"
  fi
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

# ─── Release Loading ─────────────────────────────────────────────────────────
load_release_with_gh() {
  local release_ref=$VERSION tag

  if [[ $release_ref == latest ]]; then
    tag=$(run_gh release view --repo "$REPOSITORY" --json tagName --jq '.tagName' 2>/dev/null) || return 1
  elif [[ $release_ref == latest-prerelease ]]; then
    tag=$(run_gh release list --repo "$REPOSITORY" --exclude-drafts --limit 100 \
      --json tagName,isPrerelease --jq 'map(select(.isPrerelease))[0].tagName' 2>/dev/null) || return 1
  else
    tag=$(run_gh release view "$release_ref" --repo "$REPOSITORY" --json tagName --jq '.tagName' 2>/dev/null) || return 1
  fi

  [[ -n $tag ]] || return 1
  RELEASE_TAG=$tag

  local asset_name
  asset_name=$(run_gh release view "$tag" --repo "$REPOSITORY" --json assets --jq ".assets[] | select(.name == \"${ASSET_NAME}\") | .name" 2>/dev/null) || return 1
  [[ $asset_name == "$ASSET_NAME" ]] || return 1

  EXPECTED_DIGEST=$(run_gh release view "$tag" --repo "$REPOSITORY" --json assets --jq ".assets[] | select(.name == \"${ASSET_NAME}\") | .digest" 2>/dev/null) || return 1
  [[ $EXPECTED_DIGEST != null ]] || EXPECTED_DIGEST=""
  DOWNLOAD_MODE=gh
}

load_release_with_api() {
  local metadata_file=$1
  local endpoint
  endpoint=$(release_api_endpoint)
  fetch_api "$endpoint" > "$metadata_file" || return 1

  if command_exists jq; then
    if [[ $VERSION == latest-prerelease ]]; then
      RELEASE_TAG=$(jq -er 'map(select(.prerelease == true and .draft == false))[0].tag_name' "$metadata_file") || return 1
      local asset_name
      asset_name=$(jq -er --arg name "$ASSET_NAME" 'map(select(.prerelease == true and .draft == false))[0].assets[] | select(.name == $name) | .name' "$metadata_file") || return 1
      EXPECTED_DIGEST=$(jq -r --arg name "$ASSET_NAME" 'map(select(.prerelease == true and .draft == false))[0].assets[] | select(.name == $name) | .digest // empty' "$metadata_file") || return 1
    else
      RELEASE_TAG=$(jq -er '.tag_name' "$metadata_file") || return 1
      local asset_name
      asset_name=$(jq -er --arg name "$ASSET_NAME" '.assets[] | select(.name == $name) | .name' "$metadata_file") || return 1
      EXPECTED_DIGEST=$(jq -r --arg name "$ASSET_NAME" '.assets[] | select(.name == $name) | .digest // empty' "$metadata_file") || return 1
    fi
    [[ $asset_name == "$ASSET_NAME" ]] || return 1
  else
    [[ $VERSION != latest-prerelease ]] || die "jq is required to select the latest pre-release when gh is unavailable."
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

  case $DOWNLOAD_METHOD in
    gh)
      command_exists gh || die "The forced download method gh is not installed."
      load_release_with_gh && return 0
      die "Unable to access the GitHub release with gh."
      ;;
    curl|wget)
      load_release_with_api "$metadata_file" && return 0
      ;;
    auto)
      if command_exists gh && load_release_with_gh; then
        return 0
      fi
      ;;
  esac

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

# ─── Pre-release Staleness Check ────────────────────────────────────────────
check_stable_vs_prerelease() {
  [[ $VERSION == latest-prerelease ]] || return 0

  local stable_tag="" stable_date="" stable_json=""
  if [[ $DOWNLOAD_MODE == gh ]]; then
    stable_tag=$(run_gh release view --repo "$REPOSITORY" --json tagName --jq '.tagName' 2>/dev/null) || return 0
    stable_date=$(run_gh release view "$stable_tag" --repo "$REPOSITORY" --json publishedAt --jq '.publishedAt' 2>/dev/null) || return 0
  else
    stable_json=$(fetch_api "${API_URL}/releases/latest" 2>/dev/null) || return 0
    if command_exists jq; then
      stable_tag=$(printf '%s' "$stable_json" | jq -er '.tag_name' 2>/dev/null) || return 0
      stable_date=$(printf '%s' "$stable_json" | jq -er '.published_at' 2>/dev/null) || return 0
    else
      stable_tag=$(json_value_without_jq tag_name <(printf '%s' "$stable_json"))
      [[ -n $stable_tag ]] || return 0
    fi
  fi

  [[ -n $stable_tag ]] || return 0
  local prerelease_tag=$RELEASE_TAG
  [[ $stable_tag != "$prerelease_tag" ]] || return 0

  local prerelease_date=""
  if [[ $DOWNLOAD_MODE == gh ]]; then
    prerelease_date=$(run_gh release view "$prerelease_tag" --repo "$REPOSITORY" --json publishedAt --jq '.publishedAt' 2>/dev/null) || true
  elif [[ -n ${stable_date:-} ]]; then
    local prerelease_json=""
    prerelease_json=$(fetch_api "${API_URL}/releases/tags/${prerelease_tag}" 2>/dev/null) || true
    if [[ -n $prerelease_json ]]; then
      if command_exists jq; then
        prerelease_date=$(printf '%s' "$prerelease_json" | jq -er '.published_at' 2>/dev/null) || true
      else
        prerelease_date=$(json_value_without_jq published_at <(printf '%s' "$prerelease_json"))
      fi
    fi
  fi

  local warn_stable=0
  if [[ -n ${stable_date:-} && -n ${prerelease_date:-} ]]; then
    local stable_epoch prerelease_epoch
    if command_exists date && date --version >/dev/null 2>&1; then
      stable_epoch=$(date -d "$stable_date" +%s 2>/dev/null) || true
      prerelease_epoch=$(date -d "$prerelease_date" +%s 2>/dev/null) || true
    else
      stable_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$stable_date" +%s 2>/dev/null) || true
      prerelease_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$prerelease_date" +%s 2>/dev/null) || true
    fi
    if [[ -n ${stable_epoch:-} && -n ${prerelease_epoch:-} ]]; then
      (( stable_epoch > prerelease_epoch )) && warn_stable=1
    fi
  fi

  if [[ $warn_stable -eq 1 ]]; then
    printf '\n'
    warn "A stable release ${BOLD}${stable_tag}${RESET}${YELLOW} is newer than pre-release ${BOLD}${prerelease_tag}${RESET}"
    warn "The stable release may be more reliable for most users."
    if ! confirm "Continue installing the older pre-release?" n; then
      die "Installation cancelled. Run without --prerelease to install the stable release."
    fi
  fi
}

# ─── Download & Verify ───────────────────────────────────────────────────────
download_archive() {
  local destination=$1

  if [[ $DOWNLOAD_MODE == gh ]]; then
    local download_dir
    download_dir=$(dirname "$destination")
    run_gh release download "$RELEASE_TAG" \
      --repo "$REPOSITORY" \
      --pattern "$ASSET_NAME" \
      --dir "$download_dir" \
      --clobber
    [[ -f "$download_dir/$ASSET_NAME" ]] || die "gh did not download the expected asset."
    return
  fi

  local asset_url="${RELEASES_URL}/download/${RELEASE_TAG}/${ASSET_NAME}"
  download_url "$asset_url" "$destination" || die "Unable to download ${ASSET_NAME}."
}

verify_archive() {
  local archive=$1
  local expected=${EXPECTED_DIGEST#sha256:}

  [[ -n $expected ]] || return 1

  local actual
  actual=$(sha256_file "$archive") || die "Cannot verify the download: no SHA-256 tool available."
  local actual_lower expected_lower
  actual_lower=$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')
  expected_lower=$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')
  if [[ $actual_lower != "$expected_lower" ]]; then
    die "SHA-256 verification failed for ${ASSET_NAME}."
  fi
}

# ─── PATH Configuration ──────────────────────────────────────────────────────
is_path_entry() {
  case :${PATH:-}: in
    *:"$1":*) return 0 ;;
    *) return 1 ;;
  esac
}

configure_windows_path() {
  if ! command_exists cygpath || ! command_exists powershell.exe; then
    warn "Cannot update the Windows user PATH automatically."
    verbose "Add this directory to the Windows user PATH manually: ${INSTALL_DIR}"
    return
  fi

  local windows_dir result
  windows_dir=$(cygpath -w "$INSTALL_DIR") || die "Unable to convert the installation directory to a Windows path."
  if ! confirm "Add ${windows_dir} to the Windows user PATH?" y; then
    verbose "Add this directory to the Windows user PATH manually if needed: ${windows_dir}"
    return
  fi

  result=$(MESHTALK_INSTALL_DIR="$windows_dir" powershell.exe -NoProfile -NonInteractive -Command '$dir = $env:MESHTALK_INSTALL_DIR.TrimEnd([IO.Path]::DirectorySeparatorChar); $path = [Environment]::GetEnvironmentVariable("Path", "User"); $entries = @($path -split ";" | Where-Object { $_ }); if (@($entries | Where-Object { $_.TrimEnd([IO.Path]::DirectorySeparatorChar) -ieq $dir }).Count -gt 0) { "already" } else { [Environment]::SetEnvironmentVariable("Path", (($entries + $dir) -join ";"), "User"); "added" }' 2>/dev/null) || {
    warn "Unable to update the Windows user PATH."
    verbose "Add this directory to the Windows user PATH manually: ${windows_dir}"
    return
  }

  if [[ $result == already ]]; then
    verbose "${windows_dir} is already on the Windows user PATH."
  else
    verbose "Added ${windows_dir} to the Windows user PATH."
  fi
  verbose "Open a new terminal, then run: ${LAUNCHER_NAME}"
}

configure_path() {
  if [[ $PLATFORM == windows ]]; then
    configure_windows_path
    return
  fi

  if is_path_entry "$INSTALL_DIR"; then
    verbose "${INSTALL_DIR} is already on PATH."
    return
  fi

  if ! confirm "Add ${INSTALL_DIR} to your shell PATH?" y; then
    verbose "Add this directory to PATH manually if needed: ${INSTALL_DIR}"
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
    verbose "${INSTALL_DIR} is already configured in ${startup_file}."
    return
  fi

  {
    printf '\n# MeshTalk installer\n'
    printf 'export PATH=%q:$PATH\n' "$INSTALL_DIR"
  } >> "$startup_file"
  verbose "Added ${INSTALL_DIR} to ${startup_file}."
  verbose "Run ${BOLD}source ${startup_file}${RESET} or open a new shell."
}

# ─── Install ─────────────────────────────────────────────────────────────────
choose_action() {
  if [[ $SIMPLE_MODE -eq 1 ]]; then
    ACTION=install
    return
  fi
  if [[ $ACTION != install || -n $VERSION || -n $INSTALL_DIR || $DRY_RUN -eq 1 || $NON_INTERACTIVE -eq 1 ]]; then
    return
  fi

  panel_start "What would you like to do?"
  panel_line "${GREEN}1${RESET}  Install or upgrade MeshTalk"
  panel_line "${GREEN}2${RESET}  Uninstall MeshTalk"
  panel_line "${DIM}q${RESET}  Quit"
  panel_end
  printf '\n'
  local choice
  prompt_read choice "  ${BOLD}Choose${RESET} ${DIM}[1]${RESET}: " || true
  [[ $LONG_OUTPUT -eq 1 ]] || clear_prompt_panel 8
  case ${choice:-1} in
    1) ACTION=install ;;
    2) ACTION=uninstall ;;
    q|Q) exit 0 ;;
    *) die "Invalid choice" ;;
  esac
}

choose_version() {
  [[ -n $VERSION ]] && return
  [[ $NON_INTERACTIVE -eq 1 ]] && { VERSION=latest; return; }
  [[ $SIMPLE_MODE -eq 1 ]] && { VERSION=latest; return; }

  panel_start "Choose a release channel"
  panel_line "${GREEN}1${RESET}  Latest stable release ${DIM}(recommended)${RESET}"
  panel_line "${GREEN}2${RESET}  Latest pre-release"
  panel_line "${GREEN}3${RESET}  Specific release tag"
  panel_end
  printf '\n'
  local choice tag
  prompt_read choice "  ${BOLD}Channel${RESET} ${DIM}[1]${RESET}: " || true
  [[ $LONG_OUTPUT -eq 1 ]] || clear_prompt_panel 8
  case ${choice:-1} in
    1) VERSION=latest ;;
    2) VERSION=latest-prerelease ;;
    3)
      prompt_read tag "  ${BOLD}Release tag${RESET}: " || true
      [[ -n $tag ]] || die "A release tag is required"
      VERSION=$tag
      ;;
    *) die "Invalid release channel" ;;
  esac
}

choose_install_dir() {
  if [[ -z $INSTALL_DIR ]]; then
    if [[ $SIMPLE_MODE -eq 0 && $NON_INTERACTIVE -eq 0 ]]; then
      if [[ $ACTION == uninstall ]]; then
        [[ ${EUID:-1} -eq 0 ]] && verbose "MeshTalk will be removed as root." || verbose "MeshTalk will be removed without root or sudo."
      else
        [[ ${EUID:-1} -eq 0 ]] && verbose "MeshTalk will be installed as root." || verbose "MeshTalk will be installed without root or sudo."
      fi
    fi
    if [[ $NON_INTERACTIVE -eq 0 && $SIMPLE_MODE -eq 0 ]]; then
      prompt_read INSTALL_DIR "  ${BOLD}Install directory${RESET} ${DIM}[${DEFAULT_INSTALL_DIR}]${RESET}: " || true
    fi
    INSTALL_DIR=${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}
  fi

  case $INSTALL_DIR in
    '~') INSTALL_DIR=$HOME ;;
    '~/'*) INSTALL_DIR="$HOME/${INSTALL_DIR:2}" ;;
  esac
}

install_meshtalk() {
  choose_version
  choose_install_dir

  if [[ $WINDOWS_ARM64_EMULATION -eq 1 ]]; then
    warn "Windows ARM64 detected. Installing the x64 build through emulation."
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    panel_start "Install preview"
    panel_kv "Platform" "${PLATFORM}/${ARCH}"
    panel_kv "Release" "${VERSION}"
    panel_kv "Asset" "${ASSET_NAME}"
    panel_kv "Directory" "${INSTALL_DIR}"
    panel_end
    return
  fi

  # Check for existing installation
  if [[ -e $INSTALL_DIR && ! -d $INSTALL_DIR ]]; then
    die "Installation path exists but is not a directory: ${INSTALL_DIR}"
  fi
  local existing_file=""
  for file in "${EXPECTED_FILES[@]}"; do
    if [[ -e $INSTALL_DIR/$file || -L $INSTALL_DIR/$file ]]; then
      existing_file=$file
      break
    fi
  done
  if [[ -n $existing_file ]] && ! confirm "${INSTALL_DIR}/${existing_file} already exists. Replace the MeshTalk installation?" n 1; then
    [[ $NON_INTERACTIVE -eq 0 ]] || die "${INSTALL_DIR}/${existing_file} already exists. Re-run with --yes to replace."
    info "Installation cancelled."
    return
  fi

  # Verify dependencies
  command_exists tar || die "tar is required to extract release archives."
  case $DOWNLOAD_METHOD in
    gh)  command_exists gh  || die "The forced download method gh is not installed." ;;
    curl) command_exists curl || die "The forced download method curl is not installed." ;;
    wget) command_exists wget || die "The forced download method wget is not installed." ;;
  esac
  if ! command_exists gh && ! command_exists curl && ! command_exists wget; then
    die "gh, curl, or wget is required to download releases."
  fi

  # Set up temp directory
  local temp_dir archive extract_dir file archive_listing archive_entry download_source
  temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/meshtalk-installer.XXXXXX")
  cleanup_temp() { rm -rf "$temp_dir"; }
  trap cleanup_temp EXIT

  # Step 1: Resolve release
  step "Resolving release metadata"
  load_release "$temp_dir/release.json"
  step_done "${TICK}"
  verbose "  Release ${BOLD}${RELEASE_TAG}${RESET}  Asset ${DIM}${ASSET_NAME}${RESET}"
  [[ -z $CHECKSUM_NOTE ]] || verbose "  ${DIM}${CHECKSUM_NOTE}${RESET}"
  check_stable_vs_prerelease

  # Step 2: Download
  archive="$temp_dir/$ASSET_NAME"
  step "Downloading ${ASSET_NAME}"
  download_archive "$archive"
  step_done "${TICK}"

  # Step 3: Verify
  if [[ -n ${EXPECTED_DIGEST:-} ]]; then
    step "Verifying SHA-256 digest"
    verify_archive "$archive"
    step_done "${TICK}"
  else
    step "Verifying download"
    step_done "${YELLOW}!${RESET}" "Checksum unavailable; continuing without verification"
  fi

  # Step 4: Extract
  step "Extracting binaries"
  extract_dir="$temp_dir/extracted"
  mkdir -p "$extract_dir"
  archive_listing=$(tar -tzf "$archive") || die "Unable to inspect the release archive."
  while IFS= read -r archive_entry; do
    case $archive_entry in
      /*|../*|*/../*|*/..|..) die "The release archive contains an unsafe path: ${archive_entry}" ;;
    esac
  done <<< "$archive_listing"
  tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$extract_dir"
  for file in "${EXPECTED_FILES[@]}"; do
    [[ -f $extract_dir/$file && ! -L $extract_dir/$file ]] || die "The release archive is missing ${file}."
  done
  step_done "${TICK}"

  # Step 5: Install
  step "Installing to ${INSTALL_DIR}"
  mkdir -p "$INSTALL_DIR"
  for file in "${EXPECTED_FILES[@]}"; do
    cp "$extract_dir/$file" "$INSTALL_DIR/$file"
    chmod u+rx "$INSTALL_DIR/$file"
  done
  step_done "${TICK}"

  configure_path

  # Done!
  printf '\n'
  if [[ $SIMPLE_MODE -eq 1 ]]; then
    success "MeshTalk ${RELEASE_TAG} is ready. Run ${LAUNCHER_NAME}."
  else
    panel_start "MeshTalk is ready"
    panel_kv "Status" "${GREEN}${BOLD}Installed${RESET}"
    panel_kv "Version" "${RELEASE_TAG}"
    panel_kv "Run" "${BOLD}${LAUNCHER_NAME}${RESET}"
    panel_kv "Location" "${INSTALL_DIR}"
    panel_end
    printf '\n'
    success "Open a new terminal if you just added MeshTalk to your PATH."
    divider
  fi
  printf '\n'

  cleanup_temp
  trap - EXIT
}

# ─── Uninstall ───────────────────────────────────────────────────────────────
uninstall_meshtalk() {
  choose_install_dir

  if [[ $DRY_RUN -eq 1 ]]; then
    panel_start "Uninstall preview"
    panel_kv "Directory" "${INSTALL_DIR}"
    panel_end
    return
  fi

  local found=0
  for file in "${EXPECTED_FILES[@]}"; do
    if [[ -e "$INSTALL_DIR/$file" || -L "$INSTALL_DIR/$file" ]]; then
      found=1
      break
    fi
  done
  if [[ $found -eq 0 ]]; then
    die "No MeshTalk binaries found in ${INSTALL_DIR}."
  fi

  panel_start "Remove MeshTalk installation"
  panel_line "${DIM}${INSTALL_DIR}${RESET}"
  panel_end
  if ! confirm "Remove MeshTalk from ${INSTALL_DIR}?" n 1; then
    info "Uninstall cancelled."
    return
  fi

  task_start "Removing MeshTalk from ${INSTALL_DIR}"
  for file in "${EXPECTED_FILES[@]}"; do
    rm -f -- "$INSTALL_DIR/$file"
  done
  task_finish "" "Removed MeshTalk from ${INSTALL_DIR}"
  success "MeshTalk was uninstalled from ${INSTALL_DIR}."
}

# ─── Entry Point ─────────────────────────────────────────────────────────────
main() {
  init_colors
  parse_arguments "$@"
  require_not_root
  detect_platform
  show_banner
  choose_action

  if [[ $ACTION == uninstall ]]; then
    uninstall_meshtalk
  else
    install_meshtalk
  fi
}

main "$@"
