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
VERSION=""
INSTALL_DIR=""
DOWNLOAD_METHOD=auto
AUTH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

CHECKSUM_NOTE=""
TASK_LABEL=""

# ─── Colors & Glyphs ─────────────────────────────────────────────────────────
RESET="" BOLD="" DIM="" UNDERLINE=""
TEAL="" MINT="" GOLD="" CORAL="" SLATE="" LILAC="" WHITE=""
TICK="" CROSS="" BULLET="" ARROW="" WARN_ICON=""

init_colors() {
  if { [ -t 1 ] && [ "$(tput colors 2>/dev/null || printf 0)" -ge 8 ]; } || [ "${FORCE_COLOR:-}" ]; then
    RESET=$'\e[0m'
    BOLD=$'\e[1m'
    DIM=$'\e[2m'
    UNDERLINE=$'\e[4m'
    TEAL=$'\e[38;5;80m'
    MINT=$'\e[38;5;114m'
    GOLD=$'\e[38;5;179m'
    CORAL=$'\e[38;5;203m'
    SLATE=$'\e[38;5;245m'
    LILAC=$'\e[38;5;140m'
    WHITE=$'\e[97m'
  fi
  TICK="${MINT}✓${RESET}"
  CROSS="${CORAL}✗${RESET}"
  BULLET="${TEAL}▸${RESET}"
  ARROW="${MINT}→${RESET}"
  WARN_ICON="${GOLD}!${RESET}"
}

# ─── UI Primitives ───────────────────────────────────────────────────────────
# All panels/rules are sized to a fixed inner width so boxes always line up.
BOX_WIDTH=60

hr() {
  printf '  %s%s%s\n' "$SLATE" "$(printf '─%.0s' $(seq 1 $BOX_WIDTH))" "$RESET"
}

box_top() {
  printf '\n  %s╭─ %s%s%s\n' "$TEAL" "$BOLD" "$1" "$RESET"
}

box_line() {
  printf '  %s│%s  %b\n' "$TEAL" "$RESET" "$1"
}

box_kv() {
  printf '  %s│%s  %s%-11s%s %b\n' "$TEAL" "$RESET" "$DIM" "$1" "$RESET" "$2"
}

box_bottom() {
  printf '  %s╰%s%s\n\n' "$TEAL" "$(printf '─%.0s' $(seq 1 $((BOX_WIDTH - 1))))" "$RESET"
}

die() {
  if [[ -n $TASK_LABEL ]]; then
    task_finish "$CROSS" "$TASK_LABEL"
  fi
  printf '\n  %s%s✗ ERROR%s  %s\n\n' "$CORAL" "$BOLD" "$RESET" "$*" >&2
  exit 1
}

warn() {
  printf '  %s%s%s  %s\n' "$GOLD" "$WARN_ICON" "$RESET" "$*" >&2
}

info() {
  printf '  %s  %s\n' "$BULLET" "$*"
}

verbose() {
  printf '  %s  %s\n' "$BULLET" "$*"
}

success() {
  printf '  %s  %s\n' "$TICK" "$*"
}

task_start() {
  TASK_LABEL=$1
  if [[ -t 1 ]]; then
    printf '  %s  %s...' "$BULLET" "$TASK_LABEL"
  else
    printf '  %s  %s...\n' "$BULLET" "$TASK_LABEL"
  fi
}

task_finish() {
  local marker=${1:-$TICK}
  local label=${2:-$TASK_LABEL}
  if [[ -t 1 ]]; then
    printf '\r\033[2K  %s  %s\n' "$marker" "$label"
  else
    printf '  %s  %s\n' "$marker" "$label"
  fi
  TASK_LABEL=""
}

confirm() {
  local prompt=$1
  local default=${2:-n}
  local answer
  local hint

  [[ $ASSUME_YES -eq 1 ]] && return 0
  [[ $NON_INTERACTIVE -eq 1 ]] && return 1

  if [[ $default == y ]]; then
    hint="${DIM}[${RESET}${MINT}Y${RESET}${DIM}/n]${RESET}"
  else
    hint="${DIM}[y/${RESET}${CORAL}N${RESET}${DIM}]${RESET}"
  fi
  prompt_read answer $'\n  '"${BOLD}${prompt}${RESET} ${hint} " || true
  if [[ $default == y ]]; then
    [[ -z $answer || $answer =~ ^[Yy]([Ee][Ss])?$ ]]
  else
    [[ $answer =~ ^[Yy]([Ee][Ss])?$ ]]
  fi
}

prompt_read() {
  local silent=0
  local input_fd=-1
  local echoes=0
  if [[ ${1:-} == --silent ]]; then
    silent=1
    shift
  fi
  local __var=$1
  shift
  local prompt_str=$1
  shift
  if [[ -t 0 ]]; then
    echoes=1
    if [[ $silent -eq 1 ]]; then read -r -s -p "$prompt_str" "$__var"; else read -r -p "$prompt_str" "$__var"; fi
  elif [[ -t 1 ]] && exec {input_fd}<>/dev/tty 2>/dev/null; then
    echoes=1
    if [[ $silent -eq 1 ]]; then read -r -s -p "$prompt_str" "$__var" <&$input_fd; else read -r -p "$prompt_str" "$__var" <&$input_fd; fi
    exec {input_fd}>&-
  else
    if [[ $silent -eq 1 ]]; then read -r -s -p "$prompt_str" "$__var"; else read -r -p "$prompt_str" "$__var"; fi
  fi
  [[ $silent -eq 1 || $echoes -eq 0 ]] && printf '\n'
  return 0
}

box_prompt() {
  local __var=$1
  shift
  local prompt_str=$1
  shift
  local default=${1:-}
  local color=${2:-$TEAL}
  local hint
  if [[ -n $default ]]; then
    hint="${DIM}[${RESET}${MINT}${default}${RESET}${DIM}]${RESET}"
  else
    hint=""
  fi

  printf '  %s╰%s%s\n\n' "$color" "$(printf '─%.0s' $(seq 1 $((BOX_WIDTH - 1))))" "$RESET"
  prompt_read "$__var" "  ${BOLD}${prompt_str}${RESET} ${hint}: " || true
}

box_confirm() {
  local prompt=$1
  local default=${2:-n}
  local color=${3:-$TEAL}
  local answer
  if [[ $ASSUME_YES -eq 1 ]]; then
    printf '  %s╰%s%s\n\n' "$color" "$(printf '─%.0s' $(seq 1 $((BOX_WIDTH - 1))))" "$RESET"
    return 0
  fi
  if [[ $NON_INTERACTIVE -eq 1 ]]; then
    printf '  %s╰%s%s\n\n' "$color" "$(printf '─%.0s' $(seq 1 $((BOX_WIDTH - 1))))" "$RESET"
    return 1
  fi

  local hint
  if [[ $default == y ]]; then
    hint="${DIM}[${RESET}${MINT}Y${RESET}${DIM}/n]${RESET}"
  else
    hint="${DIM}[y/${RESET}${CORAL}N${RESET}${DIM}]${RESET}"
  fi
  printf '  %s╰%s%s\n\n' "$color" "$(printf '─%.0s' $(seq 1 $((BOX_WIDTH - 1))))" "$RESET"
  prompt_read answer "  ${BOLD}${prompt}${RESET} ${hint}: " || true

  if [[ $default == y ]]; then
    [[ -z $answer || $answer =~ ^[Yy]([Ee][Ss])?$ ]]
  else
    [[ $answer =~ ^[Yy]([Ee][Ss])?$ ]]
  fi
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# ─── Banner ──────────────────────────────────────────────────────────────────
show_banner() {
  printf '\n%s' "$TEAL"
  cat <<'EOF'
███╗   ███╗███████╗███████╗██╗  ██╗████████╗ █████╗ ██╗     ██╗  ██╗
████╗ ████║██╔════╝██╔════╝██║  ██║╚══██╔══╝██╔══██╗██║     ██║ ██╔╝
██╔████╔██║█████╗  ███████╗███████║   ██║   ███████║██║     █████╔╝
██║╚██╔╝██║██╔══╝  ╚════██║██╔══██║   ██║   ██╔══██║██║     ██╔═██╗
██║ ╚═╝ ██║███████╗███████║██║  ██║   ██║   ██║  ██║███████╗██║  ██╗
╚═╝     ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
EOF
  printf '%s\n' "$RESET"
  hr
  printf '  %sPeer-to-peer encrypted messaging over LAN and UDP.%s\n' "$DIM" "$RESET"
  hr
  printf '\n'
}

# ─── Help ────────────────────────────────────────────────────────────────────
print_help() {
  cat <<EOF
${BOLD}MeshTalk Installer${RESET}

${UNDERLINE}Usage${RESET}
  $0 [options]

${UNDERLINE}Common options${RESET}
  ${MINT}-y, --yes${RESET}               Auto-answer yes to prompts
  ${MINT}-n, --non-interactive${RESET}   Disable prompts; use stable release and default dir
  ${MINT}    --uninstall${RESET}          Remove an existing installation
  ${MINT}    --dry-run${RESET}            Show planned actions without making changes
  ${MINT}    --help${RESET}               Show this help

${UNDERLINE}Fine-tuning${RESET}
  ${MINT}    --version VERSION${RESET}    Install a specific release tag
  ${MINT}    --prerelease${RESET}         Install the latest pre-release
  ${MINT}    --method METHOD${RESET}      Download via auto, gh, curl, or wget
  ${MINT}    --install-dir DIR${RESET}   Use a specific installation directory
  ${MINT}    --i-understand-the-risks-of-running-as-root${RESET}
                              Allow running as root (not recommended)

${DIM}Works with Bash on POSIX systems, Git Bash, and WSL.
Never requires root or sudo.${RESET}

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
      wget -q -O "$destination" --header="Authorization: Bearer ${AUTH_TOKEN}" "$url" 2>/dev/null
    else
      wget -q -O "$destination" "$url" 2>/dev/null
    fi
  elif command_exists curl; then
    curl -s "${CURL_ARGS[@]}" -o "$destination" "$url"
  elif command_exists wget; then
    if [[ -n $AUTH_TOKEN ]]; then
      wget -q -O "$destination" --header="Authorization: Bearer ${AUTH_TOKEN}" "$url" 2>/dev/null
    else
      wget -q -O "$destination" "$url" 2>/dev/null
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
  [[ $NON_INTERACTIVE -eq 0 ]] || die "GitHub API access requires GITHUB_TOKEN or GH_TOKEN in non-interactive mode."
  printf '\n'
  warn "Anonymous GitHub release access was unavailable."
  info "Provide a GitHub token, or press Enter to cancel."
  prompt_read --silent AUTH_TOKEN "  Token: " || true
  AUTH_TOKEN=${AUTH_TOKEN:-}
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
    warn "Stable release ${BOLD}${stable_tag}${RESET} is newer than pre-release ${BOLD}${prerelease_tag}${RESET}"
    if ! confirm "Continue installing the older pre-release anyway?" n; then
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
      --clobber \
      >/dev/null 2>&1
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

  local shell_name=${SHELL:-}
  shell_name=${shell_name##*/}

  local startup_file
  case $shell_name in
    zsh)
      startup_file=${HOME}/.zshrc
      ;;
    bash)
      if [[ -f ${HOME}/.bashrc ]]; then
        startup_file=${HOME}/.bashrc
      elif [[ -f ${HOME}/.bash_profile ]]; then
        startup_file=${HOME}/.bash_profile
      elif [[ -f ${HOME}/.profile ]]; then
        startup_file=${HOME}/.profile
      else
        startup_file=${HOME}/.bashrc
      fi
      ;;
    sh|dash|ash|ksh|mksh)
      startup_file=${HOME}/.profile
      ;;
    fish|csh|tcsh|*)
      startup_file=
      ;;
  esac

  if [[ -z $startup_file ]]; then
    local shell_manual
    case $shell_name in
      fish)
        printf -v shell_manual 'fish_add_path %q' "$INSTALL_DIR"
        ;;
      csh|tcsh)
        printf -v shell_manual 'setenv PATH "%s:$PATH"' "$INSTALL_DIR"
        ;;
      *)
        printf -v shell_manual 'export PATH=%q:$PATH' "$INSTALL_DIR"
        ;;
    esac
    warn "Automatic PATH configuration is unavailable for ${shell_name:-the current shell}."
    info "Configure it manually with: ${shell_manual}"
    return
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

choose_install_dir() {
  if [[ -z $INSTALL_DIR ]]; then
    if [[ $NON_INTERACTIVE -eq 0 ]]; then
      printf '\n'
      printf '  %s╭─ %s%sInstallation directory%s\n' "$TEAL" "$BOLD" "$TEAL" "$RESET"
      printf '  %s│%s  MeshTalk will be installed here. Press Enter to use the default.\n' "$TEAL" "$RESET"
      box_prompt INSTALL_DIR "Directory" "$DEFAULT_INSTALL_DIR" "$TEAL"
    fi
    INSTALL_DIR=${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}
  fi

  case $INSTALL_DIR in
    '~') INSTALL_DIR=$HOME ;;
    '~/'*) INSTALL_DIR="$HOME/${INSTALL_DIR:2}" ;;
  esac
}

choose_action() {
  if [[ $ACTION != install || -n $VERSION || -n $INSTALL_DIR || $DRY_RUN -eq 1 || $NON_INTERACTIVE -eq 1 ]]; then
    return
  fi

  printf '\n'
  printf '  %s╭─ %s%sWhat would you like to do?%s\n' "$TEAL" "$BOLD" "$TEAL" "$RESET"
  printf '  %s│%s  %s1%s  Install or upgrade MeshTalk\n' "$TEAL" "$RESET" "$MINT" "$RESET"
  printf '  %s│%s  %s2%s  Uninstall MeshTalk\n' "$TEAL" "$RESET" "$MINT" "$RESET"
  printf '  %s│%s  %sq%s  Quit\n' "$TEAL" "$RESET" "$DIM" "$RESET"
  local choice
  box_prompt choice "Choose" "1" "$TEAL"
  case ${choice:-1} in
    1) ACTION=install ;;
    2) ACTION=uninstall ;;
    q|Q) exit 0 ;;
    *) die "Invalid choice. Choose 1, 2, or q." ;;
  esac
}

choose_version() {
  [[ -n $VERSION ]] && return
  [[ $NON_INTERACTIVE -eq 1 ]] && { VERSION=latest; return; }

  printf '\n'
  printf '  %s╭─ %s%sChoose a release channel%s\n' "$TEAL" "$BOLD" "$TEAL" "$RESET"
  printf '  %s│%s  %s1%s  Latest stable release %s(recommended)%s\n' "$TEAL" "$RESET" "$MINT" "$RESET" "$DIM" "$RESET"
  printf '  %s│%s  %s2%s  Latest pre-release\n' "$TEAL" "$RESET" "$MINT" "$RESET"
  printf '  %s│%s  %s3%s  Specific release tag\n' "$TEAL" "$RESET" "$MINT" "$RESET"
  local choice tag
  box_prompt choice "Channel" "1" "$TEAL"
  case ${choice:-1} in
    1) VERSION=latest ;;
    2) VERSION=latest-prerelease ;;
    3)
      printf '\n'
      printf '  %s╭─ %s%sRelease tag%s\n' "$TEAL" "$BOLD" "$TEAL" "$RESET"
      box_prompt tag "Tag" "" "$TEAL"
      [[ -n $tag ]] || die "A release tag is required"
      VERSION=$tag
      ;;
    *) die "Invalid release channel. Choose 1, 2, or 3." ;;
  esac
}

# ─── Install ─────────────────────────────────────────────────────────────────
install_meshtalk() {
  choose_version
  choose_install_dir

  if [[ $WINDOWS_ARM64_EMULATION -eq 1 ]]; then
    warn "Windows ARM64 detected. Installing the x64 build through emulation."
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    box_top "Install preview ${DIM}(dry run)${RESET}"
    box_kv "Platform" "${PLATFORM}/${ARCH}"
    box_kv "Release" "${VERSION}"
    box_kv "Asset" "${ASSET_NAME}"
    box_kv "Directory" "${INSTALL_DIR}"
    box_bottom
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
  if [[ -n $existing_file ]]; then
    printf '\n'
    printf '  %s╭─ %s%sFile already exists%s\n' "$CORAL" "$BOLD" "$CORAL" "$RESET"
    printf '  %s│%s  %s%s%s\n' "$CORAL" "$RESET" "$DIM" "${INSTALL_DIR}/${existing_file}" "$RESET"
    if ! box_confirm "Replace the MeshTalk installation?" n "$CORAL"; then
      [[ $NON_INTERACTIVE -eq 0 ]] || die "${INSTALL_DIR}/${existing_file} already exists. Re-run with --yes to replace."
      info "Installation cancelled."
      return
    fi
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

  # Set up temp directory and signal handling.
  local temp_dir archive extract_dir file archive_listing archive_entry
  temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/meshtalk-installer.XXXXXX")

  cleanup_on_signal() {
    rm -rf "$temp_dir"
    printf '\n'
    die "Installation cancelled."
  }

  cleanup_on_exit() {
    rm -rf "$temp_dir"
  }

  trap cleanup_on_exit EXIT
  trap cleanup_on_signal SIGINT SIGTERM

  printf '\n'

  task_start "Downloading and preparing MeshTalk ${VERSION}"
  load_release "$temp_dir/release.json"
  check_stable_vs_prerelease
  archive="$temp_dir/$ASSET_NAME"
  download_archive "$archive"
  if [[ -n ${EXPECTED_DIGEST:-} ]]; then
    verify_archive "$archive"
  else
    warn "Checksum unavailable; continuing without verification."
  fi
  task_finish "$TICK" "Download ready (${RELEASE_TAG})."

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
  task_start "Installing MeshTalk to ${INSTALL_DIR}"
  mkdir -p "$INSTALL_DIR"
  for file in "${EXPECTED_FILES[@]}"; do
    cp "$extract_dir/$file" "$INSTALL_DIR/$file"
    chmod u+rx "$INSTALL_DIR/$file"
  done
  task_finish "$TICK" "Installed MeshTalk to ${INSTALL_DIR}."

  configure_path

  box_top "${MINT}${BOLD}MeshTalk is ready${RESET}"
  box_kv "Version" "${RELEASE_TAG}"
  box_kv "Run" "${BOLD}${LAUNCHER_NAME}${RESET}"
  box_kv "Location" "${INSTALL_DIR}"
  box_bottom
  info "Open a new terminal if you just added MeshTalk to your PATH."

  trap - EXIT SIGINT SIGTERM
}

# ─── Uninstall ───────────────────────────────────────────────────────────────
uninstall_meshtalk() {
  choose_install_dir

  if [[ $DRY_RUN -eq 1 ]]; then
    printf '\n'
    printf '  %s╭─ %s%sUninstall preview %s(dry run)%s\n' "$TEAL" "$BOLD" "$CORAL" "$DIM" "$RESET"
    printf '  %s│%s  %s%-11s%s %b\n' "$TEAL" "$RESET" "$DIM" "Directory" "$RESET" "${INSTALL_DIR}"
    printf '  %s╰%s%s\n\n' "$TEAL" "$(printf '─%.0s' $(seq 1 $((BOX_WIDTH - 1))))" "$RESET"
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

  printf '\n'
  printf '  %s╭─ %s%sRemove MeshTalk installation%s\n' "$CORAL" "$BOLD" "$CORAL" "$RESET"
  printf '  %s│%s  %s%s%s\n' "$CORAL" "$RESET" "$DIM" "${INSTALL_DIR}" "$RESET"
  printf '  %s│%s\n' "$CORAL" "$RESET"
  printf '  %s│%s  This action cannot be undone.\n' "$CORAL" "$RESET"
  if ! box_confirm "Remove MeshTalk from ${INSTALL_DIR}?" n "$CORAL"; then
    info "Uninstall cancelled."
    return
  fi

  printf '\n'
  task_start "Removing MeshTalk from ${INSTALL_DIR}"
  for file in "${EXPECTED_FILES[@]}"; do
    rm -f -- "$INSTALL_DIR/$file"
  done
  task_finish "$TICK" "Removed MeshTalk from ${INSTALL_DIR}."
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
