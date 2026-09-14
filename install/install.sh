#!/usr/bin/env bash
# Rafiki Code installer. Served at https://get.rafikiai.io and kept in the
# repository under install/install.sh. Downloads the release archive for this
# machine, verifies it against the SHA256SUMS published with the release, and
# installs the binary atomically into a user owned directory.
set -euo pipefail

# Every product specific value lives in this block. Environment variables of
# the same family override the release locations so tests can point at a
# local mock release server.
APP=rafikicode
OWNER=paneotech-dev
REPO=rafiki-code-cli
INSTALLER_URL="https://get.rafikiai.io"
RELEASE_API="${RAFIKICODE_RELEASE_API:-https://api.github.com/repos/${OWNER}/${REPO}}"
RELEASE_BASE="${RAFIKICODE_RELEASE_BASE:-https://github.com/${OWNER}/${REPO}/releases}"
CHECKSUMS=SHA256SUMS
INSTALL_DIR="${RAFIKICODE_INSTALL_DIR:-$HOME/.${APP}/bin}"
# File name of the binary inside the archive and on disk (.exe on Windows).
BIN_NAME="$APP"

MUTED='\033[0;2m'
RED='\033[0;31m'
NC='\033[0m'

# Release overrides must be https URLs with a plain host name, no user info.
# Plain http is accepted only for the literal loopback addresses 127.0.0.1 and
# [::1], and only with the explicit test switch (--allow-http-loopback or
# RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK=1) for local mock release servers.
# Host names (localhost included), other spellings of loopback and IPv4 mapped
# addresses are refused. Checked after the options are read, before anything
# is downloaded. Every download is pinned to https, redirects included, unless
# the loopback test switch is in use.
allow_http_loopback="${RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK:-}"
CURL_PROTO=(--proto '=https' --proto-redir '=https')
URL_PATH_RE='(/[A-Za-z0-9._~%/+=-]*)?'
HTTPS_RE="^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?${URL_PATH_RE}\$"
LOOPBACK_RE="^http://(127\\.0\\.0\\.1|\\[::1\\])(:[0-9]{1,5})?${URL_PATH_RE}\$"

check_override() {
    local name=$1 value=$2
    [ -z "$value" ] && return 0
    if [[ "$value" =~ $HTTPS_RE ]]; then
        return 0
    fi
    if [[ "$value" =~ $LOOPBACK_RE ]] && [ "$allow_http_loopback" = "1" ]; then
        CURL_PROTO=()
        return 0
    fi
    printf 'Error: %s must be an https URL (plain http is accepted only for 127.0.0.1 or [::1] with --allow-http-loopback, for local tests).\n' "$name" >&2
    exit 1
}

# Scratch directory for downloads: a new directory from mktemp (random name,
# mode 0700, owned by this user), so no other user can plant it or swap the
# archive between the checksum check and the install. Removed on every exit
# path; HUP, INT and TERM exit through the same cleanup.
TMP_DIR=""
cleanup() {
    if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

usage() {
    cat <<EOF
Rafiki Code installer

Usage: install.sh [options]

Options:
    -h, --help               Show this message
    -v, --version <version>  Install a specific version (for example 1.0.3)
    -p, --prefix <dir>       Install into <dir> instead of ${INSTALL_DIR}
    -b, --binary <path>      Install from a local binary instead of downloading
        --no-modify-path     Do not edit shell startup files, only print the PATH note
        --dry-run            Resolve the version and print what would happen, download nothing
        --allow-http-loopback  Accept http release overrides on 127.0.0.1 or [::1] (local tests only)

Environment:
    VERSION                  Same as --version
    RAFIKICODE_INSTALL_DIR   Same as --prefix
    RAFIKICODE_RELEASE_API   Release API base (default ${RELEASE_API})
    RAFIKICODE_RELEASE_BASE  Release download base (default ${RELEASE_BASE})

Examples:
    curl -fsSL ${INSTALLER_URL} | bash
    curl -fsSL ${INSTALLER_URL} | bash -s -- --version 1.0.3
    ./install.sh --binary /path/to/${APP}
EOF
}

requested_version=${VERSION:-}
no_modify_path=false
dry_run=false
binary_path=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        -v|--version)
            if [[ -n "${2:-}" ]]; then
                requested_version="$2"
                shift 2
            else
                echo -e "${RED}Error: --version requires a version argument${NC}" >&2
                exit 1
            fi
            ;;
        -p|--prefix)
            if [[ -n "${2:-}" ]]; then
                INSTALL_DIR="$2"
                shift 2
            else
                echo -e "${RED}Error: --prefix requires a directory argument${NC}" >&2
                exit 1
            fi
            ;;
        -b|--binary)
            if [[ -n "${2:-}" ]]; then
                binary_path="$2"
                shift 2
            else
                echo -e "${RED}Error: --binary requires a path argument${NC}" >&2
                exit 1
            fi
            ;;
        --no-modify-path)
            no_modify_path=true
            shift
            ;;
        --dry-run)
            dry_run=true
            shift
            ;;
        --allow-http-loopback)
            allow_http_loopback=1
            shift
            ;;
        *)
            echo -e "${RED}Error: unknown option '$1'${NC}" >&2
            usage >&2
            exit 1
            ;;
    esac
done

check_override RAFIKICODE_RELEASE_API "${RAFIKICODE_RELEASE_API:-}"
check_override RAFIKICODE_RELEASE_BASE "${RAFIKICODE_RELEASE_BASE:-}"

print_message() {
    local level=$1
    local message=$2
    local color=""
    case $level in
        info) color="${NC}" ;;
        warning) color="${NC}" ;;
        error) color="${RED}" ;;
    esac
    echo -e "${color}${message}${NC}"
}

fail() {
    print_message error "Error: $1" >&2
    exit 1
}

need() {
    command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but not installed."
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        fail "neither sha256sum nor shasum is available to verify the download."
    fi
}

# Platform detection. Produces os, arch, target (with baseline and musl
# suffixes when needed), filename and archive_ext.
detect_platform() {
    local raw_os
    raw_os=$(uname -s)
    os=$(echo "$raw_os" | tr '[:upper:]' '[:lower:]')
    case "$raw_os" in
      Darwin*) os="darwin" ;;
      Linux*) os="linux" ;;
      MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    esac

    arch=$(uname -m)
    if [[ "$arch" == "aarch64" ]]; then arch="arm64"; fi
    if [[ "$arch" == "x86_64" ]]; then arch="x64"; fi

    if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
      local rosetta_flag
      rosetta_flag=$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)
      if [ "$rosetta_flag" = "1" ]; then arch="arm64"; fi
    fi

    case "$os-$arch" in
      linux-x64|linux-arm64|darwin-x64|darwin-arm64|windows-x64) ;;
      *) fail "unsupported OS or architecture: $os/$arch" ;;
    esac

    archive_ext=".zip"
    if [ "$os" = "linux" ]; then archive_ext=".tar.gz"; fi
    if [ "$os" = "windows" ]; then BIN_NAME="$APP.exe"; fi

    local is_musl=false
    if [ "$os" = "linux" ]; then
      if [ -f /etc/alpine-release ]; then is_musl=true; fi
      if command -v ldd >/dev/null 2>&1; then
        if ldd --version 2>&1 | grep -qi musl; then is_musl=true; fi
      fi
    fi

    local needs_baseline=false
    if [ "$arch" = "x64" ]; then
      if [ "$os" = "linux" ]; then
        if ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then needs_baseline=true; fi
      fi
      if [ "$os" = "darwin" ]; then
        local avx2
        avx2=$(sysctl -n hw.optional.avx2_0 2>/dev/null || echo 0)
        if [ "$avx2" != "1" ]; then needs_baseline=true; fi
      fi
    fi

    target="$os-$arch"
    if [ "$needs_baseline" = "true" ]; then target="$target-baseline"; fi
    if [ "$is_musl" = "true" ]; then target="$target-musl"; fi
    filename="$APP-$target$archive_ext"
}

# Version resolution. Produces specific_version and url.
resolve_version() {
    need curl
    if [ -z "$requested_version" ]; then
        specific_version=$(curl -fsSL ${CURL_PROTO[@]+"${CURL_PROTO[@]}"} -H "Accept: application/vnd.github+json" "${RELEASE_API}/releases/latest" \
            | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)
        if [[ -z "$specific_version" ]]; then
            fail "could not read the latest version from ${RELEASE_API}/releases/latest"
        fi
    else
        specific_version="${requested_version#v}"
    fi
    url="${RELEASE_BASE}/download/v${specific_version}/${filename}"
    sums_url="${RELEASE_BASE}/download/v${specific_version}/${CHECKSUMS}"
}

check_installed() {
    if [ -x "${INSTALL_DIR}/${BIN_NAME}" ]; then
        local installed_version
        installed_version=$("${INSTALL_DIR}/${BIN_NAME}" --version 2>/dev/null || echo "")
        if [[ -n "$installed_version" && "$installed_version" == "$specific_version" ]]; then
            print_message info "${MUTED}Version ${NC}$specific_version${MUTED} is already installed at ${NC}${INSTALL_DIR}/${BIN_NAME}"
            exit 0
        elif [[ -n "$installed_version" ]]; then
            print_message info "${MUTED}Installed version: ${NC}$installed_version"
        fi
    fi
}

download_and_install() {
    if [ "$os" = "linux" ]; then need tar; else need unzip; fi
    print_message info "\n${MUTED}Installing ${NC}${APP} ${MUTED}version ${NC}${specific_version}"
    TMP_DIR=$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/${APP}_install.XXXXXXXXXX") || fail "could not create a private temporary directory."
    chmod 700 "$TMP_DIR"
    if [ ! -d "$TMP_DIR" ] || [ -L "$TMP_DIR" ] || [ ! -O "$TMP_DIR" ]; then
        fail "the temporary directory ${TMP_DIR} is not a private directory owned by this user."
    fi
    local tmp_dir="$TMP_DIR"

    if ! curl -fsSL ${CURL_PROTO[@]+"${CURL_PROTO[@]}"} -o "$tmp_dir/$CHECKSUMS" "$sums_url"; then
        fail "could not download ${CHECKSUMS} for v${specific_version} from ${sums_url}. Is the version published?"
    fi
    local expected
    expected=$(awk -v f="$filename" '$2 == f || $2 == "*" f {print tolower($1)}' "$tmp_dir/$CHECKSUMS" | head -n 1)
    if [[ -z "$expected" ]]; then
        fail "${CHECKSUMS} for v${specific_version} has no entry for ${filename}."
    fi

    if [ -t 2 ]; then
        curl -fL -# ${CURL_PROTO[@]+"${CURL_PROTO[@]}"} -o "$tmp_dir/$filename" "$url" || fail "download failed: $url"
    else
        curl -fsSL ${CURL_PROTO[@]+"${CURL_PROTO[@]}"} -o "$tmp_dir/$filename" "$url" || fail "download failed: $url"
    fi

    local actual
    actual=$(sha256_of "$tmp_dir/$filename")
    if [[ "$actual" != "$expected" ]]; then
        fail "checksum mismatch for ${filename}: expected ${expected}, got ${actual}. Nothing was installed."
    fi
    print_message info "${MUTED}Checksum verified${NC}"

    if [ "$os" = "linux" ]; then
        tar -xzf "$tmp_dir/$filename" -C "$tmp_dir"
    else
        unzip -q "$tmp_dir/$filename" -d "$tmp_dir"
    fi
    [ -f "$tmp_dir/$BIN_NAME" ] || fail "the archive does not contain ${BIN_NAME}."

    mkdir -p "$INSTALL_DIR"
    chmod 755 "$tmp_dir/$BIN_NAME"
    # Stage next to the target and rename over it so the path never disappears.
    mv "$tmp_dir/$BIN_NAME" "${INSTALL_DIR}/${BIN_NAME}.new"
    mv -f "${INSTALL_DIR}/${BIN_NAME}.new" "${INSTALL_DIR}/${BIN_NAME}"
}

install_from_binary() {
    [ -f "$binary_path" ] || fail "binary not found at ${binary_path}"
    print_message info "\n${MUTED}Installing ${NC}${APP} ${MUTED}from ${NC}${binary_path}"
    mkdir -p "$INSTALL_DIR"
    cp "$binary_path" "${INSTALL_DIR}/${APP}.new"
    chmod 755 "${INSTALL_DIR}/${APP}.new"
    mv -f "${INSTALL_DIR}/${APP}.new" "${INSTALL_DIR}/${APP}"
}

add_to_path() {
    local config_file=$1
    local command=$2
    if grep -Fxq "$command" "$config_file" 2>/dev/null; then
        print_message info "${MUTED}PATH entry already present in ${NC}$config_file"
    elif [[ -w $config_file ]]; then
        echo -e "\n# ${APP}" >> "$config_file"
        echo "$command" >> "$config_file"
        print_message info "${MUTED}Added ${NC}${INSTALL_DIR}${MUTED} to PATH in ${NC}$config_file"
    else
        print_message warning "Add the directory to your PATH in $config_file (or similar):"
        print_message info "  $command"
    fi
}

path_note() {
    local current_shell
    current_shell=$(basename "${SHELL:-sh}")
    XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
    case $current_shell in
        fish)
            config_files="$HOME/.config/fish/config.fish"
            command="fish_add_path $INSTALL_DIR"
            ;;
        zsh)
            config_files="${ZDOTDIR:-$HOME}/.zshrc ${ZDOTDIR:-$HOME}/.zshenv $XDG_CONFIG_HOME/zsh/.zshrc $XDG_CONFIG_HOME/zsh/.zshenv"
            command="export PATH=$INSTALL_DIR:\$PATH"
            ;;
        bash)
            config_files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
            command="export PATH=$INSTALL_DIR:\$PATH"
            ;;
        ash|sh)
            config_files="$HOME/.ashrc $HOME/.profile /etc/profile"
            command="export PATH=$INSTALL_DIR:\$PATH"
            ;;
        *)
            config_files="$HOME/.bashrc $HOME/.bash_profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
            command="export PATH=$INSTALL_DIR:\$PATH"
            ;;
    esac

    if [[ ":$PATH:" == *":$INSTALL_DIR:"* ]]; then
        print_message info "${MUTED}${INSTALL_DIR} is already on your PATH${NC}"
        return
    fi

    if [ "$no_modify_path" = "true" ]; then
        print_message info "\nAdd ${INSTALL_DIR} to your PATH for ${current_shell}:"
        print_message info "  $command"
        return
    fi

    local config_file=""
    for file in $config_files; do
        if [[ -f $file ]]; then
            config_file=$file
            break
        fi
    done
    if [[ -z $config_file ]]; then
        print_message info "\nNo shell startup file found. Add ${INSTALL_DIR} to your PATH for ${current_shell}:"
        print_message info "  $command"
        return
    fi
    add_to_path "$config_file" "$command"
    print_message info "${MUTED}Open a new terminal or run: ${NC}$command"
}

if [ -n "$binary_path" ]; then
    if [ "$dry_run" = "true" ]; then
        echo "dry run: would install ${binary_path} to ${INSTALL_DIR}/${APP}"
        exit 0
    fi
    install_from_binary
else
    detect_platform
    resolve_version
    if [ "$dry_run" = "true" ]; then
        echo "dry run: ${APP} ${specific_version} for ${target}"
        echo "  archive:   ${url}"
        echo "  checksums: ${sums_url}"
        echo "  install:   ${INSTALL_DIR}/${BIN_NAME}"
        exit 0
    fi
    check_installed
    download_and_install
fi

print_message info "${MUTED}Installed ${NC}${APP}${MUTED} at ${NC}${INSTALL_DIR}/${BIN_NAME}"
path_note
print_message info "\nRun ${APP} login to connect your Rafiki Console account, or set RAFIKICODE_API_KEY on servers."
