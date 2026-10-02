#!/usr/bin/env bash
# Rafiki Code installer. Served at https://get.rafikiai.io and kept in the
# repository under install/install.sh. Downloads the release archive for this
# machine, verifies it against the SHA256SUMS published with the release, and
# installs the binary atomically into a user owned directory.
# Every product specific value lives in this block. Environment variables of
# the same family override the release locations so tests can point at a
# local mock release server.
#
# This block sits above `set` and above the bash guard below, so that the guard
# can name the product and the install URL rather than repeating them. Everything
# in it is a plain assignment, so it parses and runs under any shell.
APP=rafikicode
OWNER=paneotech-dev
REPO=rafiki-code-cli
INSTALLER_URL="https://get.rafikiai.io"
RELEASE_API="${RAFIKICODE_RELEASE_API:-https://api.github.com/repos/${OWNER}/${REPO}}"
RELEASE_BASE="${RAFIKICODE_RELEASE_BASE:-https://github.com/${OWNER}/${REPO}/releases}"
CHECKSUMS=SHA256SUMS
# HOME decides where this goes, and it is not always set: cron, some CI images
# and a few jailshells start a process without it. Reading it unset under
# `set -u` ends the script on that line with "install.sh: line 18: HOME: unbound
# variable", which names neither the product nor anything the reader can do.
# Resolve it to empty here instead and check it after the options are read,
# because --prefix makes it unnecessary.
HOME_DIR="${HOME:-}"
INSTALL_DIR="${RAFIKICODE_INSTALL_DIR:-${HOME_DIR}/.${APP}/bin}"
# File name of the binary inside the archive and on disk (.exe on Windows).
BIN_NAME="$APP"

# --- This installer is bash, and must say so before it reads as nonsense ------
#
# Everything below this block is bash: `[[ ]]`, `local`, and an array for the
# curl protocol pins. Run under sh it used to die on the `set -euo pipefail`
# line with
#
#     /i.sh: 6: set: Illegal option -o pipefail
#
# which names a line number and an option and tells the person nothing. The habit
# that produces it, `curl -fsSL <url> | sh`, is extremely common, and the shells
# it lands in are the dash and BusyBox ash of shared and jailshell hosting -
# exactly the customers least able to work out what line 6 means. They conclude
# the product is broken.
#
# This block is the only part of the file that has to parse under every shell, so
# it is strict POSIX: no `[[ ]]`, no arrays, no `local`, no `$'...'`, no
# `echo -e`. That is enough, because dash and BusyBox ash parse and execute one
# command at a time instead of reading the whole file first, so this runs before
# any later bashism is reached - as a file and piped on stdin alike. Both are
# covered by install/test-install-shells.sh.
if [ -z "${BASH_VERSION:-}" ]; then
    # `sh ./install.sh`: the script is still a file on disk, so re-run it with
    # bash and the same arguments. The sentinel stops this looping if whatever
    # `bash` resolves to turns out not to be bash.
    if [ "${RAFIKICODE_INSTALL_REEXEC:-}" != "1" ] \
        && [ -n "${0:-}" ] && [ -r "${0:-}" ] \
        && command -v bash >/dev/null 2>&1; then
        RAFIKICODE_INSTALL_REEXEC=1
        export RAFIKICODE_INSTALL_REEXEC
        exec bash "$0" "$@"
    fi
    # `curl ... | sh`: the script arrived on stdin, so there is no file to re-run
    # and nothing can be salvaged from this process. It has to be run again, so
    # the only useful thing to print is the exact line to run.
    printf 'Error: the %s installer needs bash, and this is sh.\n' "$APP" >&2
    if command -v bash >/dev/null 2>&1; then
        printf '\n  bash is installed here. Run the same line with bash:\n' >&2
        printf '    curl -fsSL %s | bash\n' "$INSTALLER_URL" >&2
        printf '\n  Or, if you have already saved the script:\n' >&2
        printf '    bash install.sh\n' >&2
    else
        # No bash and no guidance would be the same dead end in a new costume, so
        # name the package manager this machine has. This repeats the detection
        # in detect_pkg_manager on purpose: that function is defined further down
        # in bash syntax this shell will never get to.
        printf '\n  bash is not installed here either, so install it first.\n' >&2
        guard_mgr=""
        for guard_candidate in apt-get dnf yum pacman apk zypper brew pkg; do
            if command -v "$guard_candidate" >/dev/null 2>&1; then
                guard_mgr="$guard_candidate"
                break
            fi
        done
        guard_sudo=""
        if [ "$(id -u 2>/dev/null || echo 0)" != "0" ] && [ "$guard_mgr" != "brew" ]; then
            guard_sudo="sudo "
        fi
        case "$guard_mgr" in
            apt-get) printf '    %sapt-get update && %sapt-get install -y bash\n' "$guard_sudo" "$guard_sudo" >&2 ;;
            dnf)     printf '    %sdnf install -y bash\n' "$guard_sudo" >&2 ;;
            yum)     printf '    %syum install -y bash\n' "$guard_sudo" >&2 ;;
            pacman)  printf '    %spacman -Sy --noconfirm bash\n' "$guard_sudo" >&2 ;;
            apk)     printf '    %sapk add bash\n' "$guard_sudo" >&2 ;;
            zypper)  printf '    %szypper install -y bash\n' "$guard_sudo" >&2 ;;
            brew)    printf '    brew install bash\n' >&2 ;;
            pkg)     printf '    %spkg install -y bash\n' "$guard_sudo" >&2 ;;
            *)
                printf '    No package manager was found here (looked for apt-get, dnf, yum,\n' >&2
                printf '    pacman, apk, zypper, brew and pkg).\n' >&2
                printf '    Send whoever runs this server this line:\n' >&2
                printf '      "Please install bash on this account. The %s installer needs it."\n' "$APP" >&2
                ;;
        esac
        if [ -n "$guard_sudo" ] && ! command -v sudo >/dev/null 2>&1; then
            printf '\n  There is no sudo here, so you may not be able to install it yourself.\n' >&2
            printf '  That is normal on shared and cPanel style hosting. Send whoever runs this\n' >&2
            printf '  server this line:\n' >&2
            printf '    "Please install bash on this account. The %s installer needs it."\n' "$APP" >&2
        fi
        printf '\n  Then run:\n' >&2
        printf '    curl -fsSL %s | bash\n' "$INSTALLER_URL" >&2
    fi
    exit 1
fi

set -euo pipefail

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
    -t, --target <name>      Install a named build instead of the detected one,
                             for example linux-x64-baseline or linux-arm64-musl
        --no-modify-path     Do not edit shell startup files, only print the PATH note
        --no-login           Do not start the sign in after installing, only print how to
        --dry-run            Resolve the version and print what would happen, download nothing
        --allow-http-loopback  Accept http release overrides on 127.0.0.1 or [::1] (local tests only)

Environment:
    VERSION                  Same as --version
    RAFIKICODE_INSTALL_DIR   Same as --prefix
    RAFIKICODE_INSTALL_TARGET  Same as --target
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
no_login=false
dry_run=false
binary_path=""
requested_target="${RAFIKICODE_INSTALL_TARGET:-}"

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
        -t|--target)
            if [[ -n "${2:-}" ]]; then
                requested_target="$2"
                shift 2
            else
                echo -e "${RED}Error: --target requires a build name, for example linux-x64-baseline${NC}" >&2
                exit 1
            fi
            ;;
        --no-login)
            no_login=true
            shift
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

# Only now is it known whether a home directory is needed at all: --prefix and
# --binary both name their own destination.
if [ -z "$HOME_DIR" ] && [ "$INSTALL_DIR" = "/.${APP}/bin" ]; then
    printf 'Error: HOME is not set, so there is nowhere to install %s.\n' "$APP" >&2
    {
        printf '  Set it to this account'"'"'s home directory:\n'
        printf '    HOME=/home/you curl -fsSL %s | bash\n' "$INSTALLER_URL"
        printf '  Or choose the directory yourself, and nothing is written outside it:\n'
        printf '    curl -fsSL %s | bash -s -- --prefix /opt/%s/bin\n' "$INSTALLER_URL" "$APP"
    } >&2
    exit 1
fi

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

# A missing tool is reported with the command that installs it, never as a bare
# condition. preflight checks these together up front; this stays as the backstop
# for anything reached another way.
need() {
    if command -v "$1" >/dev/null 2>&1; then return 0; fi
    missing_tools=""
    note_missing "$1"
    report_missing_tools
}

# --- Guidance for anything that is missing ----------------------------------
#
# Every stop in this installer has to answer two questions: what is missing, and
# what do I type to fix it. Naming the condition ("'tar' is required but not
# installed") answers neither, and the person who meets it has no way forward
# except to ask someone. So each missing prerequisite is reported with the exact
# command for the package manager this machine actually has.
#
# Detection probes for the manager's own binary rather than reading
# /etc/os-release, because the file lies often enough to matter: a container
# inherits it from the image it was derived from, minimal images drop the manager
# but keep the file, and a machine can carry both dnf and yum. The binary being
# there is the thing we actually depend on.
#
# Nothing here installs anything. It prints the command and lets the human run
# it: an installer that silently installs system packages is worse than one that
# asks.
PKG_MGR=""
detect_pkg_manager() {
    if [ -n "$PKG_MGR" ]; then return 0; fi
    local mgr
    for mgr in apt-get dnf yum pacman apk zypper brew pkg; do
        if command -v "$mgr" >/dev/null 2>&1; then
            PKG_MGR=$mgr
            return 0
        fi
    done
    return 1
}

# The package that carries a tool, where the package is not named after it.
pkg_name_for() {
    case "$1" in
        sha256sum|shasum) printf 'coreutils\n' ;;
        *) printf '%s\n' "$1" ;;
    esac
}

# Why the install needs each tool. Printed next to the name, so the command we
# are asking someone to run is not a mystery.
tool_purpose() {
    case "$1" in
        curl) printf 'downloads the release\n' ;;
        tar) printf 'unpacks the release archive\n' ;;
        unzip) printf 'unpacks the release archive\n' ;;
        sha256sum|shasum) printf 'checks the download against the published checksum\n' ;;
        ca-certificates) printf 'lets this machine verify the release server\n' ;;
        *) printf 'is needed to install %s\n' "$APP" ;;
    esac
}

# True when installing a package here probably needs sudo: not as root, and never
# for brew, which refuses to run under sudo at all.
needs_sudo() {
    if [ "$(id -u 2>/dev/null || echo 0)" = "0" ]; then return 1; fi
    if [ "$PKG_MGR" = "brew" ]; then return 1; fi
    return 0
}

have_sudo() {
    command -v sudo >/dev/null 2>&1
}

# The one line that installs these packages on this machine.
pkg_install_cmd() {
    local pkgs=$1 s=""
    if needs_sudo; then s="sudo "; fi
    case "$PKG_MGR" in
        apt-get) printf '%sapt-get update && %sapt-get install -y %s\n' "$s" "$s" "$pkgs" ;;
        dnf)     printf '%sdnf install -y %s\n' "$s" "$pkgs" ;;
        yum)     printf '%syum install -y %s\n' "$s" "$pkgs" ;;
        pacman)  printf '%spacman -Sy --noconfirm %s\n' "$s" "$pkgs" ;;
        apk)     printf '%sapk add %s\n' "$s" "$pkgs" ;;
        zypper)  printf '%szypper install -y %s\n' "$s" "$pkgs" ;;
        brew)    printf 'brew install %s\n' "$pkgs" ;;
        pkg)     printf '%spkg install -y %s\n' "$s" "$pkgs" ;;
    esac
}

# "is"/"are" and "it"/"them" for a space separated list, so every message below
# reads as a sentence whether one thing is missing or three.
is_are() { if [ "${1#* }" = "$1" ]; then printf 'is'; else printf 'are'; fi; }
it_them() { if [ "${1#* }" = "$1" ]; then printf 'it'; else printf 'them'; fi; }

# "curl", "curl and tar", "curl, tar and unzip".
and_list() {
    local out="" item count=0 total=0
    for item in $1; do total=$((total + 1)); done
    for item in $1; do
        count=$((count + 1))
        if [ "$count" = "1" ]; then out="$item"
        elif [ "$count" = "$total" ]; then out="$out and $item"
        else out="$out, $item"; fi
    done
    printf '%s' "$out"
}

# Collected by preflight so one run reports everything that is missing. Failing
# once per missing tool made someone on a minimal image run the installer three
# times to find out it needed three things.
missing_tools=""
note_missing() {
    case " $missing_tools " in
        *" $1 "*) return 0 ;;
    esac
    missing_tools="${missing_tools}${missing_tools:+ }$1"
}

# The sentence to send someone who can install packages on this machine when the
# user cannot. Shared and cPanel style hosting is the common case: there is a
# package manager, there is no sudo, and the honest advice is to ask the host.
print_ask_the_host() {
    local what=$1
    printf '  Otherwise send whoever runs this server this line:\n'
    printf '    "Please install %s on this account. The %s installer needs %s."\n' \
        "$what" "$APP" "$(it_them "$what")"
}

# The manual route that needs no package manager at all: fetch the archive on a
# machine that works, copy it over, install from the file. This is the answer for
# a locked down host, and it is the reason a missing tool is never a dead end.
print_offline_route() {
    printf '  There is also a route that needs no package manager and no network here:\n'
    printf '  on a machine that has a browser, download %s from\n' "${filename:-the archive for this machine}"
    printf '    %s/latest\n' "$RELEASE_BASE"
    printf '  copy it here, unpack it, and point the installer at the file:\n'
    printf '    ./install.sh --binary /path/to/%s\n' "$BIN_NAME"
}

# Report every missing tool at once, with the command to install them, and stop.
report_missing_tools() {
    if [ -z "$missing_tools" ]; then return 0; fi
    local tool pkgs="" pkg names
    names=$(and_list "$missing_tools")
    for tool in $missing_tools; do
        pkg=$(pkg_name_for "$tool")
        case " $pkgs " in
            *" $pkg "*) ;;
            *) pkgs="${pkgs}${pkgs:+ }$pkg" ;;
        esac
    done
    print_message error "Error: ${APP} cannot be installed yet: ${names} $(is_are "$missing_tools") missing." >&2
    {
        for tool in $missing_tools; do
            printf '  %s %s\n' "$tool" "$(tool_purpose "$tool")"
        done
        if detect_pkg_manager; then
            if needs_sudo && ! have_sudo; then
                printf '  This machine has %s, but no sudo, so you probably cannot install packages\n' "$PKG_MGR"
                printf '  yourself. That is normal on shared and cPanel style hosting.\n'
                printf '  If you do have administrator access, install %s with:\n' "$(it_them "$pkgs")"
                printf '    %s\n' "$(pkg_install_cmd "$pkgs")"
                print_ask_the_host "$pkgs"
            else
                printf '  This machine has %s. Install %s with:\n' "$PKG_MGR" "$(it_them "$pkgs")"
                printf '    %s\n' "$(pkg_install_cmd "$pkgs")"
                printf '  Then run this installer again.\n'
            fi
        else
            printf '  No package manager was found here: looked for apt-get, dnf, yum, pacman,\n'
            printf '  apk, zypper, brew and pkg, and none of them is on PATH.\n'
            printf '  If you can install software another way, install: %s\n' "$pkgs"
            print_ask_the_host "$pkgs"
        fi
        print_offline_route
    } >&2
    exit 1
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        missing_tools=""
        note_missing sha256sum
        report_missing_tools
    fi
}

# What is published, in the order the release workflow builds it. Named in the
# unsupported platform message, because "unsupported OS or architecture" tells
# someone their machine is wrong without telling them what would be right.
PUBLISHED_TARGETS="linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64 windows-arm64"

# No build for this machine. Print both uname values, because they are what a bug
# report needs and what the user cannot be expected to know to include.
unsupported_platform() {
    local raw=$1 windows_like=false
    # Only for the wording below. The case that chooses the asset is untouched:
    # this catches the spellings of Windows that it deliberately does not match,
    # such as the "Windows_NT" a native busybox or a Cygwin-less port reports.
    case "$raw" in
        MINGW*|MSYS*|CYGWIN*|Windows*|windows*|*WINDOWS*|*_NT*) windows_like=true ;;
    esac
    print_message error "Error: ${APP} has no build for this machine: ${os}/${arch}." >&2
    {
        printf '  uname -s said %s, uname -m said %s.\n' "$raw" "$(uname -m)"
        printf '  Published builds: %s\n' "$PUBLISHED_TARGETS"
        printf '  (Linux is also built in -musl and -baseline variants, chosen automatically.)\n'
        if [ "$windows_like" = "true" ]; then
            printf '\n  This looks like Windows. This installer is a shell script and needs a POSIX\n'
            printf '  shell, which plain cmd.exe and PowerShell do not provide. Two routes work:\n'
            printf '    - WSL, the Windows Subsystem for Linux. Run  wsl  and then the same install\n'
            printf '      line inside it; you get the linux-x64 build. This is the documented route.\n'
            printf '    - Git Bash or MSYS2. This installer runs there as it is and installs the\n'
            printf '      windows-x64 build.\n'
            # This branch carries install.ps1, so name it. Both of the lines that
            # used to stand here became false the moment it landed: there IS a
            # native installer now, and windows-arm64 IS published and accepted.
            printf '  There is also a native PowerShell installer:\n'
            printf '    irm https://github.com/%s/%s/releases/latest/download/install.ps1 | iex\n' "$OWNER" "$REPO"
            printf '  It is new in this release and has had less use than the shell one, so if it\n'
            printf '  does not work, WSL or Git Bash above is the proven route.\n'
        else
            printf '  If this machine should be supported, that is worth knowing: report it at\n'
            printf '    https://github.com/%s/%s/issues\n' "$OWNER" "$REPO"
            printf '  and paste the two uname values above.\n'
        fi
    } >&2
    exit 1
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
      linux-x64|linux-arm64|darwin-x64|darwin-arm64|windows-x64|windows-arm64) ;;
      *) unsupported_platform "$raw_os" ;;
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

    # --target names the build outright. It is for the cases detection cannot
    # settle: the baseline build on a CPU that reports AVX2 but should not use
    # it, and the release gate, which has to install every published build and
    # not only the one its runner would be given. The name is checked against
    # the builds that exist, because it becomes part of a URL.
    if [ -n "$requested_target" ]; then
        case "$requested_target" in
          linux-x64|linux-x64-baseline|linux-x64-musl|linux-x64-baseline-musl|linux-arm64|linux-arm64-musl) ;;
          darwin-arm64|darwin-x64|darwin-x64-baseline) ;;
          windows-x64|windows-x64-baseline|windows-arm64) ;;
          *)
            fail "--target ${requested_target} is not a build of ${APP}. The builds are: linux-x64, linux-x64-baseline, linux-x64-musl, linux-x64-baseline-musl, linux-arm64, linux-arm64-musl, darwin-arm64, darwin-x64, darwin-x64-baseline, windows-x64, windows-x64-baseline, windows-arm64."
            ;;
        esac
        case "$requested_target" in
          "$os"-*) ;;
          *) fail "--target ${requested_target} is a build for another operating system: this machine is ${os}." ;;
        esac
        target="$requested_target"
    fi
    filename="$APP-$target$archive_ext"
}

# The licence and the notice travel with the binary. The archive carries both
# beside it; they are kept in the product's own directory, which is where the
# configuration already lives and which `uninstall` removes. An archive from
# before they were packed has neither, and that is not an error. With no home
# directory there is nowhere of ours to put them, and the binary prints the same
# text with `licenses`.
install_licences() {
    local from=$1 dest
    [ -n "$HOME_DIR" ] || return 0
    [ -f "$from/LICENSE" ] || [ -f "$from/NOTICE" ] || return 0
    dest="${HOME_DIR}/.${APP}/licenses"
    mkdir -p "$dest" 2>/dev/null || return 0
    local name
    for name in LICENSE NOTICE; do
        if [ -f "$from/$name" ]; then
            cp "$from/$name" "$dest/$name" 2>/dev/null && chmod 644 "$dest/$name" 2>/dev/null || true
        fi
    done
}

# Version resolution. Produces specific_version and url.
resolve_version() {
    need curl
    if [ -z "$requested_version" ]; then
        # The first thing this installer does over the network, so it is where a
        # machine with no network, no DNS or an expired CA bundle shows up. Keep
        # curl's exit status instead of letting the pipeline swallow it: it is the
        # only thing that says which of those it was.
        local latest status=0
        # --stderr - puts curl's own complaint in $latest instead of on the
        # terminal. With -f a failed request writes no body, so on failure
        # $latest is that complaint and nothing else, and it is printed below
        # only if the fallback fails too. Printed here it would sit above an
        # install that then succeeded.
        latest=$(curl -fsSL --stderr - ${CURL_PROTO[@]+"${CURL_PROTO[@]}"} -H "Accept: application/vnd.github+json" "${RELEASE_API}/releases/latest") || status=$?
        specific_version=""
        if [ "$status" = "0" ]; then
            specific_version=$(printf '%s' "$latest" \
                | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)
        fi
        if [ -z "$specific_version" ]; then
            # The API is rate limited to 60 requests an hour per IP address, and
            # that allowance is shared by everyone behind the same address: an
            # office network, a shared CI runner, any NAT. When it runs out the
            # API answers 403, and curl reports a 403 with the same exit 22 it
            # uses for a 404, so this used to tell the user there was no such
            # release and to go and check their version number, which was
            # correct all along. The release page is not rate limited and
            # redirects to the newest tag, so ask it before giving up.
            local redirect=""
            redirect=$(curl -sS ${CURL_PROTO[@]+"${CURL_PROTO[@]}"} -o /dev/null \
                -w '%{redirect_url}' "${RELEASE_BASE}/latest" 2>/dev/null) || redirect=""
            specific_version=$(printf '%s' "$redirect" \
                | sed -n 's|.*/tag/v\{0,1\}\([^/]*\)$|\1|p' | head -n 1)
        fi
        if [ -z "$specific_version" ]; then
            if [ "$status" != "0" ]; then
                [ -z "$latest" ] || printf '%s\n' "$latest" >&2
                net_fail "$status" "${RELEASE_API}/releases/latest" \
                    "could not reach the release server to find the latest ${APP} version"
            fi
            fail "the release server answered but published no version number at ${RELEASE_API}/releases/latest. If that URL opens in a browser, this is a bug: report it at https://github.com/${OWNER}/${REPO}/issues"
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
            print_message info "${MUTED}Upgrading ${NC}${APP}${MUTED} from ${NC}$installed_version${MUTED} to ${NC}$specific_version"
        fi
    fi
}

# The install directory has to exist and be ours before anything is downloaded.
# Checked here because the only other check was the mkdir after the archive had
# already been fetched, verified and unpacked: a read-only home directory, which
# is normal on a locked down or quota-exhausted account, spent a 60 MiB download
# and then stopped on "mkdir: cannot create directory ... Read-only file system",
# which names neither the product nor a way forward.
ensure_install_dir() {
    if [ -d "$INSTALL_DIR" ]; then
        [ -w "$INSTALL_DIR" ] && return 0
    elif mkdir -p "$INSTALL_DIR" 2>/dev/null; then
        return 0
    fi
    print_message error "Error: ${INSTALL_DIR} cannot be created or written to." >&2
    {
        printf '  Nothing has been downloaded, so there is nothing to clean up.\n'
        if [ -n "$HOME_DIR" ] && [ ! -w "$HOME_DIR" ]; then
            printf '  %s is not writable by this account.\n' "$HOME_DIR"
        fi
        printf '  Install somewhere you can write instead:\n'
        printf '    curl -fsSL %s | bash -s -- --prefix /path/you/can/write/bin\n' "$INSTALLER_URL"
        printf '  If the home directory should be writable, this is usually a quota or a\n'
        printf '  read-only mount; whoever runs this machine can say which.\n'
    } >&2
    exit 1
}

download_and_install() {
    if [ "$os" = "linux" ]; then need tar; else need unzip; fi
    ensure_install_dir
    print_message info "\n${MUTED}Installing ${NC}${APP} ${MUTED}version ${NC}${specific_version}"
    TMP_DIR=$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/${APP}_install.XXXXXXXXXX") \
        || fail "could not create a temporary directory in ${TMPDIR:-/tmp}. It is usually full, read only, or missing. Check with: df -h ${TMPDIR:-/tmp} && ls -ld ${TMPDIR:-/tmp} ; or send the download elsewhere with: TMPDIR=/path/you/can/write ./install.sh"
    chmod 700 "$TMP_DIR"
    if [ ! -d "$TMP_DIR" ] || [ -L "$TMP_DIR" ] || [ ! -O "$TMP_DIR" ]; then
        fail "the temporary directory ${TMP_DIR} is not a private directory owned by this user, so the download cannot be trusted between its checksum check and the install. Nothing was installed. Use a directory you own: TMPDIR=\"\$HOME/tmp\" ./install.sh"
    fi
    local tmp_dir="$TMP_DIR"

    local sums_status=0
    curl -fsSL ${CURL_PROTO[@]+"${CURL_PROTO[@]}"} -o "$tmp_dir/$CHECKSUMS" "$sums_url" || sums_status=$?
    if [ "$sums_status" != "0" ]; then
        net_fail "$sums_status" "$sums_url" \
            "could not download ${CHECKSUMS} for ${APP} v${specific_version}"
    fi
    local expected
    expected=$(awk -v f="$filename" '$2 == f || $2 == "*" f {print tolower($1)}' "$tmp_dir/$CHECKSUMS" | head -n 1)
    if [[ -z "$expected" ]]; then
        # The release exists but carries no asset for the target chosen for this
        # machine, which is what a release that skipped a build looks like from
        # here. The checksum file lists what it did publish, so say so: that
        # turns "no entry for X" into a choice the person can actually make.
        print_message error "Error: ${APP} v${specific_version} was published, but without a build for this machine." >&2
        {
            printf '  This machine needs: %s\n' "$filename"
            printf '  That release publishes:\n'
            awk '{ sub(/^\*/, "", $2); if ($2 != "") printf "    %s\n", $2 }' "$tmp_dir/$CHECKSUMS"
            printf '  Your platform was detected as %s.\n' "$target"
            if [ "$specific_version" != "${requested_version#v}" ] || [ -z "$requested_version" ]; then
                printf '  This is the latest release. An earlier one may have the build you need:\n'
                printf '    %s\n' "$RELEASE_BASE"
                printf '    ./install.sh --version <an earlier version>\n'
            else
                printf '  You asked for this version specifically. Leaving --version off installs the\n'
                printf '  latest release, which may have it:\n'
                printf '    curl -fsSL %s | bash\n' "$INSTALLER_URL"
            fi
            printf '  If one of the builds listed above does suit this machine, install it by hand:\n'
            printf '  download it from %s/tag/v%s, unpack it, then\n' "$RELEASE_BASE" "$specific_version"
            printf '    ./install.sh --binary /path/to/%s\n' "$BIN_NAME"
            printf '  A missing build for a platform that should be supported is a release bug:\n'
            printf '  please report it at https://github.com/%s/%s/issues and name %s.\n' "$OWNER" "$REPO" "$target"
        } >&2
        exit 1
    fi

    local dl_status=0
    if [ -t 2 ]; then
        curl -fL -# ${CURL_PROTO[@]+"${CURL_PROTO[@]}"} -o "$tmp_dir/$filename" "$url" || dl_status=$?
    else
        curl -fsSL ${CURL_PROTO[@]+"${CURL_PROTO[@]}"} -o "$tmp_dir/$filename" "$url" || dl_status=$?
    fi
    if [ "$dl_status" != "0" ]; then
        net_fail "$dl_status" "$url" "could not download ${filename} for ${APP} v${specific_version}"
    fi

    local actual
    actual=$(sha256_of "$tmp_dir/$filename")
    if [[ "$actual" != "$expected" ]]; then
        # Say what this means, because "checksum mismatch" is jargon and the one
        # thing a person must not do here is shrug and run the binary anyway.
        print_message error "Error: the ${APP} archive that arrived is not the file the release says it is." >&2
        {
            printf '  file:     %s\n' "$filename"
            printf '  expected: %s\n' "$expected"
            printf '  received: %s\n' "$actual"
            printf '  Nothing was installed and the download has been deleted.\n'
            printf '\n  This means the bytes that arrived are not the bytes that were published.\n'
            printf '  Almost always that is a download cut short, or a proxy, captive portal or\n'
            printf '  company filter that replaced the file with something of its own. Rarely, it\n'
            printf '  means the file was tampered with on the way here.\n'
            printf '  Do not run a %s binary that failed this check, and do not install one from\n' "$APP"
            printf '  anywhere but %s\n' "$RELEASE_BASE"
            printf '\n  Try again, on a different network if you can:\n'
            printf '    curl -fsSL %s | bash\n' "$INSTALLER_URL"
            printf '  If it fails the same way on a network you trust, that is worth reporting.\n'
            printf '  Open an issue at https://github.com/%s/%s/issues and paste both hashes above.\n' "$OWNER" "$REPO"
        } >&2
        exit 1
    fi
    print_message info "${MUTED}Checksum verified${NC}"

    if [ "$os" = "linux" ]; then
        tar -xzf "$tmp_dir/$filename" -C "$tmp_dir"
    else
        unzip -q "$tmp_dir/$filename" -d "$tmp_dir"
    fi
    if [ ! -f "$tmp_dir/$BIN_NAME" ]; then
        fail "${filename} unpacked, but it does not contain ${BIN_NAME}. That is a packaging mistake in release v${specific_version}, not something you can fix here: please report it at https://github.com/${OWNER}/${REPO}/issues and name the version."
    fi

    mkdir -p "$INSTALL_DIR"
    chmod 755 "$tmp_dir/$BIN_NAME"
    # Stage next to the target and rename over it so the path never disappears.
    mv "$tmp_dir/$BIN_NAME" "${INSTALL_DIR}/${BIN_NAME}.new"
    mv -f "${INSTALL_DIR}/${BIN_NAME}.new" "${INSTALL_DIR}/${BIN_NAME}"
    install_licences "$tmp_dir"
}

install_from_binary() {
    if [ ! -f "$binary_path" ]; then
        if [ -d "$binary_path" ]; then
            fail "--binary wants the ${APP} file itself, but ${binary_path} is a directory. If you unpacked the release there, use: --binary ${binary_path%/}/${BIN_NAME}"
        fi
        fail "--binary ${binary_path}: no such file. Check the path, and remember the archive has to be unpacked first: tar -xzf ${APP}-<target>.tar.gz (or unzip it) and point --binary at the ${BIN_NAME} inside."
    fi
    # detect_platform does not run on this path, so the Windows suffix is set
    # here. Without it the file is written without .exe and does not run.
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*) BIN_NAME="$APP.exe" ;;
    esac
    print_message info "\n${MUTED}Installing ${NC}${APP} ${MUTED}from ${NC}${binary_path}"
    mkdir -p "$INSTALL_DIR"
    cp "$binary_path" "${INSTALL_DIR}/${BIN_NAME}.new"
    chmod 755 "${INSTALL_DIR}/${BIN_NAME}.new"
    mv -f "${INSTALL_DIR}/${BIN_NAME}.new" "${INSTALL_DIR}/${BIN_NAME}"
}

# macOS marks files downloaded by a browser with com.apple.quarantine, and
# Gatekeeper refuses to run a quarantined binary that is not notarised: these
# builds are ad-hoc signed only. curl and unzip do not set the attribute, so for
# a normal install this does nothing. It matters for --binary pointed at a file
# that came out of a browser download, which is what someone does after taking
# the archive from the release page by hand.
clear_quarantine() {
    [ "$(uname -s)" = "Darwin" ] || return 0
    command -v xattr >/dev/null 2>&1 || return 0
    local bin=$1
    [ -e "$bin" ] || return 0
    if xattr "$bin" 2>/dev/null | grep -q com.apple.quarantine; then
        if xattr -d com.apple.quarantine "$bin" 2>/dev/null; then
            print_message info "${MUTED}Removed the macOS quarantine attribute${NC}"
        else
            print_message warning "Could not remove com.apple.quarantine from ${bin}. Run: xattr -d com.apple.quarantine ${bin}"
        fi
    fi
    return 0
}

# Set to the startup file that carries the PATH entry, and only then: the next
# steps promise new terminals find the command on their own, and that promise is
# true only when a file on disk says so.
path_written=""
add_to_path() {
    local config_file=$1
    local command=$2
    if grep -Fxq "$command" "$config_file" 2>/dev/null; then
        print_message info "${MUTED}PATH entry already present in ${NC}$config_file"
        path_written="$config_file"
    elif [[ -w $config_file ]]; then
        echo -e "\n# ${APP}" >> "$config_file"
        echo "$command" >> "$config_file"
        print_message info "${MUTED}Added ${NC}${INSTALL_DIR}${MUTED} to PATH in ${NC}$config_file"
        path_written="$config_file"
    else
        print_message warning "Add the directory to your PATH in $config_file (or similar):"
        print_message info "  $command"
    fi
}

path_note() {
    local current_shell
    current_shell=$(basename "${SHELL:-sh}")
    XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME_DIR/.config}
    case $current_shell in
        fish)
            config_files="$HOME_DIR/.config/fish/config.fish"
            primary_config="$HOME_DIR/.config/fish/config.fish"
            command="fish_add_path $INSTALL_DIR"
            ;;
        zsh)
            config_files="${ZDOTDIR:-$HOME_DIR}/.zshrc ${ZDOTDIR:-$HOME_DIR}/.zshenv $XDG_CONFIG_HOME/zsh/.zshrc $XDG_CONFIG_HOME/zsh/.zshenv"
            primary_config="${ZDOTDIR:-$HOME_DIR}/.zshrc"
            command="export PATH=$INSTALL_DIR:\$PATH"
            ;;
        bash)
            config_files="$HOME_DIR/.bashrc $HOME_DIR/.bash_profile $HOME_DIR/.profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
            primary_config="$HOME_DIR/.bashrc"
            command="export PATH=$INSTALL_DIR:\$PATH"
            ;;
        ash|sh)
            config_files="$HOME_DIR/.ashrc $HOME_DIR/.profile /etc/profile"
            primary_config="$HOME_DIR/.profile"
            command="export PATH=$INSTALL_DIR:\$PATH"
            ;;
        *)
            config_files="$HOME_DIR/.bashrc $HOME_DIR/.bash_profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
            primary_config="$HOME_DIR/.bashrc"
            command="export PATH=$INSTALL_DIR:\$PATH"
            ;;
    esac

    if [[ ":$PATH:" == *":$INSTALL_DIR:"* ]]; then
        print_message info "${MUTED}${INSTALL_DIR} is already on your PATH${NC}"
        return
    fi
    # Shown again in the next steps: this terminal does not read the startup file.
    path_hint="$command"

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
        # Already reachable by its bare name through the symlink: nothing to do.
        if [ -n "$linked_path" ]; then return; fi
        # A fresh macOS account runs zsh and has no ~/.zshrc, and a minimal
        # container image may have no startup file either. Create the usual one
        # for this shell rather than leaving the binary unreachable for good.
        if mkdir -p "$(dirname "$primary_config")" 2>/dev/null && touch "$primary_config" 2>/dev/null; then
            print_message info "${MUTED}Created ${NC}$primary_config"
            config_file=$primary_config
        else
            print_message info "\nNo shell startup file found. Add ${INSTALL_DIR} to your PATH for ${current_shell}:"
            print_message info "  $command"
            return
        fi
    fi
    add_to_path "$config_file" "$command"

    # One more file, because the first one is read by only half the shells that
    # matter. An interactive shell reads ~/.bashrc, which is what the list above
    # finds first and what a new terminal window uses. A login shell that is not
    # interactive -- `ssh host rafikicode ...`, cron, a CI step -- reads
    # ~/.bash_profile or ~/.profile instead, and on Debian and Ubuntu the
    # ~/.bashrc they ship opens with "If not running interactively, don't do
    # anything" and returns before it ever reaches the line just appended.
    #
    # So an unprivileged install writes to ~/.bashrc, prints "New terminals find
    # rafikicode on their own", and is telling the truth about new terminals and
    # not about ssh. Writing the same line to the login file as well costs one
    # append and makes the sentence true in both. add_to_path is idempotent, so a
    # second install adds nothing.
    case "$config_file" in
        *.bashrc|*.zshrc|*.ashrc)
            local login_file=""
            for file in "$HOME_DIR/.bash_profile" "$HOME_DIR/.zprofile" "$HOME_DIR/.profile"; do
                case "$current_shell" in
                    bash) [[ "$file" == *.zprofile ]] && continue ;;
                    zsh)  [[ "$file" == *.bash_profile ]] && continue ;;
                esac
                if [[ -f $file ]]; then login_file=$file; break; fi
            done
            if [ -n "$login_file" ] && [ "$login_file" != "$config_file" ]; then
                add_to_path "$login_file" "$command"
            fi
            ;;
    esac
}

# Make the command usable in the terminal that ran the installer.
#
# `curl ... | bash` runs in a child process, so a PATH line appended to a shell
# startup file cannot reach the shell the user is sitting in. Until they open a
# new terminal or re-export PATH by hand, `rafikicode login` answers "command
# not found" straight after a successful install, which is the first thing every
# new user meets.
#
# A symlink from a directory that is already on PATH is the only thing that
# takes effect in the shell that is already open. Only directories that are
# themselves already on PATH and writable are used, so this never widens where
# the shell looks for commands; and a file that is not one of our own symlinks
# is never replaced.
linked_path=""
link_into_path() {
    if [ "$no_modify_path" = "true" ]; then return 0; fi
    local target="${INSTALL_DIR}/${BIN_NAME}" dir link
    for dir in /usr/local/bin "$HOME_DIR/.local/bin"; do
        case ":$PATH:" in
            *":$dir:"*) ;;
            *) continue ;;
        esac
        [ -d "$dir" ] && [ -w "$dir" ] || continue
        link="${dir}/${BIN_NAME}"
        if [ -e "$link" ] && [ ! -L "$link" ]; then continue; fi
        if ln -sfn "$target" "$link" 2>/dev/null; then
            linked_path="$link"
            print_message info "${MUTED}Linked ${NC}${link}${MUTED} so ${NC}${APP}${MUTED} runs in this terminal${NC}"
            return 0
        fi
    done
    return 0
}

# Post-install smoke test. check_installed only runs --version when an older
# version is already there, so on a fresh install a binary for the wrong
# architecture, one built against a newer C library, or one macOS has
# quarantined is written to disk and reported as a success; the user meets the
# failure later, as an opaque error from their first real command. Run it here,
# while the install is still the thing in front of them, and say what to look at.
verify_runs() {
    local bin="${INSTALL_DIR}/${BIN_NAME}" out status=0
    out=$("$bin" --version 2>&1) || status=$?
    if [ "$status" = "0" ] && [ -n "$out" ]; then
        return 0
    fi
    print_message error "Error: ${APP} was installed to ${bin} but does not run." >&2
    {
        printf '  %s --version exited with status %s\n' "$bin" "$status"
        if [ -n "$out" ]; then printf '  it said: %s\n' "$out"; fi

        # A missing shared library is not a guess, it is in the loader's own
        # words, so name it and the package that carries it instead of listing
        # causes. The musl build is linked against libstdc++ and libgcc, and
        # Alpine installs neither by default: a correct install of the correct
        # archive for the machine ends here, and the generic advice below sends
        # the reader to check a glibc version that is not the problem.
        case "$out" in
            *"libstdc++"*|*"libgcc_s"*|*"Error relocating"*)
                printf '  The build needs the C++ runtime libraries, which this system does not have.\n'
                printf '  Install them and nothing else has to change:\n'
                if [ -f /etc/alpine-release ] || command -v apk >/dev/null 2>&1; then
                    printf '    apk add libstdc++ libgcc\n'
                elif command -v apt-get >/dev/null 2>&1; then
                    printf '    apt-get install -y libstdc++6\n'
                else
                    printf '    install your distribution'"'"'s libstdc++ and libgcc packages\n'
                fi
                printf '  Then check it with: %s --version\n' "$bin"
                printf '  The binary is already in place, so there is nothing to install again.\n'
                exit 1
                ;;
        esac

        printf '  Usual causes:\n'
        printf '    - a build for another machine (installed %s, this is %s/%s)\n' \
            "${target:-${binary_path:-unknown}}" "$(uname -s)" "$(uname -m)"
        printf '    - a C library older than the build needs; check with: ldd --version\n'
        printf '    - on macOS, quarantine; clear it with: xattr -d com.apple.quarantine %s\n' "$bin"
        printf '  The binary was left in place so you can look at it. Remove it with: rm %s\n' "$bin"
        printf '  If none of that explains it, report it at https://github.com/%s/%s/issues\n' "$OWNER" "$REPO"
    } >&2
    exit 1
}

# A temporary directory a file can be written to and then run from.
#
# The terminal interface is drawn by a native library that travels inside the
# binary: starting it unpacks that library into the temporary directory and loads
# it from there. A temporary directory mounted noexec, which is usual on shared
# and cPanel style hosting, accepts the write and then refuses to run the file,
# and the first run fails with a message about mapping a shared object that says
# nothing a user can act on. --version does not touch that library, so verify_runs
# passes on exactly the machines where this is about to go wrong. Find it out
# here instead.
#
# Writable is not the same as executable, so this writes a small script, makes it
# executable and runs it. The binary falls back to a directory of its own when
# the temporary one cannot run a file, so create and test the same directories it
# would, in the same order, and only warn when none of them works either.
can_execute_in() {
    local dir=$1 probe status=0
    mkdir -p "$dir" 2>/dev/null || return 1
    probe="${dir}/.${APP}-exec-probe.$$"
    printf '#!/bin/sh\nexit 0\n' > "$probe" 2>/dev/null || return 1
    chmod 0700 "$probe" 2>/dev/null || { rm -f "$probe"; return 1; }
    "$probe" >/dev/null 2>&1 || status=$?
    rm -f "$probe"
    [ "$status" = "0" ]
}

exec_tmp_candidates() {
    printf '%s\n' "${XDG_CACHE_HOME:-$HOME_DIR/.cache}/${APP}/tmp"
    if [ -n "${XDG_CONFIG_HOME:-}" ]; then
        printf '%s\n' "${XDG_CONFIG_HOME}/${APP}/tmp"
    else
        printf '%s\n' "$HOME_DIR/.${APP}/tmp"
    fi
}

check_exec_tmp() {
    local tmp="${TMPDIR:-/tmp}" candidate
    if can_execute_in "$tmp"; then return 0; fi
    while IFS= read -r candidate; do
        if can_execute_in "$candidate"; then
            print_message info "${MUTED}${tmp}${NC}${MUTED} does not allow running a file, so ${NC}${APP}${MUTED} will use ${NC}${candidate}${MUTED} instead.${NC}"
            return 0
        fi
    done < <(exec_tmp_candidates)
    print_message warning "Warning: nothing on this account can hold a file and then run it." >&2
    {
        printf '  Tried: %s\n' "$tmp"
        exec_tmp_candidates | while IFS= read -r candidate; do printf '  Tried: %s\n' "$candidate"; done
        printf '  These directories are mounted "noexec", which accepts a file and then will not run it.\n'
        printf '  %s is installed and signing in will work, but the terminal interface cannot start.\n' "$APP"
        printf '  If you know a directory on this machine that programs may run from, use it:\n'
        printf '    TMPDIR=/that/directory %s\n' "$APP"
        printf '  Otherwise send whoever runs this server this line:\n'
        printf '    "%s needs a directory I can write a file to and then execute. Please give me one\n' "$APP"
        printf '     that is not mounted noexec, or allow execution under my home directory."\n'
    } >&2
    return 0
}


# Roughly what the install needs, in kilobytes, checked before anything is
# downloaded. The binary is about 58 MB extracted and the archive is downloaded
# beside it, so the temporary directory carries both at once. A disk that fills
# up during the download produces a truncated archive and then a checksum
# mismatch, which reads like tampering and is not: this is why the check happens
# first rather than after.
NEED_KB_TMP=170000
NEED_KB_INSTALL=70000

# The nearest ancestor of a path that exists, for df and for a writability test
# on a directory the installer has not created yet.
nearest_existing() {
    local d=$1
    while [ -n "$d" ] && [ "$d" != "/" ] && [ ! -d "$d" ]; do
        d=$(dirname "$d")
    done
    printf '%s\n' "${d:-/}"
}

free_kb() {
    df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'
}

kb_to_mb() {
    printf '%s' "$(( ${1:-0} / 1024 ))"
}

# A writable install directory, checked before the download rather than at the
# mkdir inside download_and_install, which used to fail after the archive had
# been fetched and verified, with nothing but whatever mkdir says.
check_install_dir() {
    local parent
    if [ -d "$INSTALL_DIR" ] && [ -w "$INSTALL_DIR" ]; then return 0; fi
    parent=$(nearest_existing "$INSTALL_DIR")
    if [ ! -d "$INSTALL_DIR" ] && [ -w "$parent" ]; then return 0; fi
    print_message error "Error: ${APP} cannot be installed into ${INSTALL_DIR}: that directory is not writable by you." >&2
    {
        printf '  You are %s and the nearest existing directory, %s, is owned by %s.\n' \
            "$(id -un 2>/dev/null || echo "this user")" "$parent" \
            "$(ls -ld "$parent" 2>/dev/null | awk '{print $3}' || echo "someone else")"
        printf '  Install somewhere you own instead. This needs no administrator access:\n'
        printf '    ./install.sh --prefix "$HOME/.%s/bin"\n' "$APP"
        printf '  or, if you are running the one line installer:\n'
        printf '    curl -fsSL %s | RAFIKICODE_INSTALL_DIR="$HOME/.%s/bin" bash\n' "$INSTALLER_URL" "$APP"
        case "$INSTALL_DIR" in
            /usr/local/*|/usr/*|/opt/*)
                printf '  %s is a system directory. Writing there needs root, and this installer\n' "$INSTALL_DIR"
                printf '  will not ask for it: a per user install under your home directory works the\n'
                printf '  same and is easier to remove.\n'
                ;;
        esac
    } >&2
    exit 1
}

# Disk space, before the download. Checked in both places it is spent: the
# temporary directory that holds the archive and the unpacked binary, and the
# install directory the binary ends up in.
check_disk_space_tmp() {
    local tmp="${TMPDIR:-/tmp}" tmp_dir_existing free
    tmp_dir_existing=$(nearest_existing "$tmp")
    free=$(free_kb "$tmp_dir_existing")
    if [ -n "$free" ] && [ "$free" -lt "$NEED_KB_TMP" ] 2>/dev/null; then
        print_message error "Error: not enough free disk space to unpack ${APP}." >&2
        {
            printf '  %s has %s MB free; unpacking the release needs about %s MB there.\n' \
                "$tmp_dir_existing" "$(kb_to_mb "$free")" "$(kb_to_mb "$NEED_KB_TMP")"
            printf '  %s is about 58 MB once extracted, and the archive is downloaded beside it.\n' "$APP"
            printf '  Either free some space, or send the download somewhere that has room:\n'
            printf '    TMPDIR=/path/with/space ./install.sh\n'
            printf '  See what is using the space with: df -h %s\n' "$tmp_dir_existing"
        } >&2
        exit 1
    fi
    return 0
}

check_disk_space_install() {
    local install_existing free
    install_existing=$(nearest_existing "$INSTALL_DIR")
    free=$(free_kb "$install_existing")
    if [ -n "$free" ] && [ "$free" -lt "$NEED_KB_INSTALL" ] 2>/dev/null; then
        print_message error "Error: not enough free disk space to install ${APP}." >&2
        {
            printf '  %s has %s MB free; %s needs about %s MB.\n' \
                "$install_existing" "$(kb_to_mb "$free")" "$APP" "$(kb_to_mb "$NEED_KB_INSTALL")"
            printf '  Free some space there, or install somewhere with room:\n'
            printf '    ./install.sh --prefix /path/with/space/bin\n'
            printf '  See what is using the space with: df -h %s\n' "$install_existing"
        } >&2
        exit 1
    fi
    return 0
}

# One pass that reports everything missing, before a byte is downloaded.
#
# The tools used to be checked where they were first used: curl in
# resolve_version, tar or unzip in download_and_install, the checksum tool after
# the download. On a minimal image that is three runs of the installer to learn
# three things, each one ending in a different one line error. Check them
# together and say all of it at once.
preflight() {
    missing_tools=""
    command -v curl >/dev/null 2>&1 || note_missing curl
    if [ "${os:-}" = "linux" ]; then
        command -v tar >/dev/null 2>&1 || note_missing tar
    else
        command -v unzip >/dev/null 2>&1 || note_missing unzip
    fi
    if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
        note_missing sha256sum
    fi
    report_missing_tools
    # A dry run writes nothing and downloads nothing, so neither of these would
    # be spent. Reporting them as failures there would be a lie about this run.
    if [ "$dry_run" != "true" ]; then
        check_install_dir
        check_disk_space_tmp
        check_disk_space_install
    fi
}

# The --binary path downloads nothing and unpacks nothing, so it needs neither a
# downloader nor an archive tool. It still has to be able to write the binary.
preflight_local() {
    check_install_dir
    check_disk_space_install
}

# What a failed download actually was, from curl's exit status.
#
# "download failed: <url>" is the same sentence for a machine with no network, a
# DNS server that does not answer, a CA bundle too old to verify the release
# server, a proxy the user has not told curl about, and a version that was never
# published. Those have five different answers and only one of them is "try
# again". curl's status distinguishes them, so use it.
net_fail() {
    local status=$1 url=$2 summary=$3
    print_message error "Error: ${summary}." >&2
    {
        printf '  curl %s exited with status %s.\n' "$url" "$status"
        case "$status" in
            6)
                printf '  That status means the host name did not resolve: DNS is not answering.\n'
                printf '  Check it with:  getent hosts github.com || nslookup github.com\n'
                printf '  If that fails too, this machine has no working DNS. On a server you\n'
                printf '  administer, check /etc/resolv.conf. Behind a company network you may need\n'
                printf '  their DNS servers, or their proxy:\n'
                printf '    export https_proxy=http://proxy.example.com:8080\n'
                ;;
            5)
                printf '  That status means the proxy itself could not be resolved. http_proxy or\n'
                printf '  https_proxy is set to a host that does not exist here:\n'
                printf '    http_proxy=%s\n' "${http_proxy:-unset}"
                printf '    https_proxy=%s\n' "${https_proxy:-unset}"
                printf '  Correct or unset them, then run the installer again.\n'
                ;;
            7)
                printf '  That status means the address resolved but refused the connection: there is\n'
                printf '  no route out, or a firewall is blocking port 443.\n'
                printf '  If this network needs a proxy, tell curl about it and run the installer again:\n'
                printf '    export https_proxy=http://proxy.example.com:8080\n'
                printf '  Check with: curl -sSI https://github.com\n'
                ;;
            28)
                printf '  That status means the connection timed out. The network may be very slow, or\n'
                printf '  a firewall may be dropping the connection without refusing it.\n'
                printf '  Try again, and if it times out every time, this is a network to ask about.\n'
                ;;
            22)
                printf '  That status means the server answered with an HTTP error, usually 404 or\n'
                printf '  403, and curl does not distinguish them in its exit status.\n'
                printf '  If 404: there is no such file, because there is no such release. Check the\n'
                printf '  version you asked for against the published list:\n'
                printf '    %s\n' "$RELEASE_BASE"
                printf '  Leaving --version off installs the latest release.\n'
                printf '  If 403: the GitHub API allows 60 requests an hour per IP address, shared\n'
                printf '  by everyone behind it, so an office network or a shared CI runner can use\n'
                printf '  it up. Your version number is probably fine. See for yourself with:\n'
                printf '    curl -s https://api.github.com/rate_limit\n'
                printf '  Naming the version skips the API altogether, so this works now:\n'
                printf '    curl -fsSL %s | bash -s -- --version <version from the list above>\n' "$INSTALLER_URL"
                ;;
            35|51|58|59|60|77|83)
                printf '  That status is a TLS failure. The usual cause is a certificate store too old\n'
                printf '  to verify the release server, which is what happens on an image that has\n'
                printf '  never been updated.\n'
                if detect_pkg_manager; then
                    printf '  Install or refresh it with:\n'
                    printf '    %s\n' "$(pkg_install_cmd ca-certificates)"
                fi
                printf '  The other cause is a network that inspects TLS, which replaces the\n'
                printf '  certificate with its own. If that is this network, its administrator has to\n'
                printf '  give you their root certificate; do not disable the check to get past it.\n'
                ;;
            *)
                printf '  Check that this machine can reach the release server:\n'
                printf '    curl -sSI %s\n' "$url"
                printf '  curl prints the reason for its exit status in its own manual: man curl.\n'
                ;;
        esac
        printf '  Nothing was installed.\n'
        print_offline_route
    } >&2
    exit 1
}

if [ -n "$binary_path" ]; then
    if [ "$dry_run" = "true" ]; then
        echo "dry run: would install ${binary_path} to ${INSTALL_DIR}/${APP}"
        exit 0
    fi
    preflight_local
    install_from_binary
else
    detect_platform
    # Everything the download needs, reported in one pass before a byte moves.
    preflight
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

clear_quarantine "${INSTALL_DIR}/${BIN_NAME}"
verify_runs
print_message info "${MUTED}Installed ${NC}${APP}${MUTED} at ${NC}${INSTALL_DIR}/${BIN_NAME}"
check_exec_tmp
link_into_path
path_note

# What to tell the user to type. Whatever happened above, this is a command that
# works in the terminal they already have open: the bare name once it resolves,
# the absolute path when it does not. Printing `rafikicode login` to someone for
# whom it cannot yet resolve is what made the install look broken.
run_cmd="$APP"
if [ -z "$linked_path" ] && [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    run_cmd="${INSTALL_DIR}/${BIN_NAME}"
fi

# Finish by signing in, instead of printing a command for someone to type.
#
# `login` is an OAuth device flow: it prints a short code and a link and then
# polls, so it needs no browser on this machine. The person can approve from a
# laptop or a phone. That is what makes running it here safe over ssh, inside a
# jailshell and in a container, where opening a browser would not be.
#
# Two things decide whether to start it. `curl ... | bash` binds stdin to the
# script itself, so the flow has to read the terminal directly through /dev/tty;
# and where there is no terminal there is nobody to enter a code, so a Dockerfile
# or a provisioning script would wait for one forever. It therefore runs only
# with a usable terminal, only outside CI, and never when a key is already set.
can_sign_in() {
    if [ "$no_login" = "true" ]; then return 1; fi
    if [ -n "${RAFIKICODE_API_KEY:-}" ]; then return 1; fi
    if [ -n "${CI:-}" ]; then return 1; fi
    if [ ! -e /dev/tty ]; then return 1; fi
    (exec 3<>/dev/tty) 2>/dev/null || return 1
    return 0
}

if can_sign_in; then
    print_message info "\n${MUTED}Signing you in. Open the link below on any device and enter the code.${NC}"
    # The install has already succeeded, so a sign in that is declined or fails
    # must not fail the installer. Fall through to the written instructions.
    if "$run_cmd" login </dev/tty; then
        print_message info "\n${MUTED}Signed in. Run ${NC}${run_cmd}${MUTED} to start, or ${NC}${run_cmd} doctor${MUTED} to check the setup.${NC}"
        exit 0
    fi
    print_message warning "Sign in did not finish. You can do it whenever you like:"
fi

print_message info "\nNext steps:"
step=1
# Three cases, three true messages. Linked: the bare name already works here and
# everywhere, so there is nothing to say. Not linked but a startup file now
# carries the entry: new terminals are set, this one needs the export. Not linked
# and nothing written (--no-modify-path, no startup file found, or one we cannot
# write): no terminal finds it until the user puts the line somewhere themselves.
if [ -n "${path_hint:-}" ] && [ -z "$linked_path" ]; then
    if [ -n "${path_written:-}" ]; then
        print_message info "  ${step}. New terminals find ${APP} on their own. To use this one:"
        print_message info "       $path_hint"
    else
        print_message info "  ${step}. Nothing was added to your shell startup files. To use ${APP} in this terminal:"
        print_message info "       $path_hint"
        print_message info "     ${MUTED}Put the same line in your shell startup file so new terminals find it too.${NC}"
    fi
    step=$((step + 1))
fi
print_message info "  ${step}. Sign in to your Rafiki AI account:"
print_message info "       ${run_cmd} login"
print_message info "     ${MUTED}On a server with no browser, use a key from https://console.rafikiai.io/keys (tick the Rafiki Code option):${NC}"
print_message info "       export RAFIKICODE_API_KEY=sk-..."
step=$((step + 1))
# The one command that answers "did that work?". It checks the config files, the
# key, the gateway and, since this installer is the thing most likely to get it
# wrong, whether the name resolves to the binary that was just written.
print_message info "  ${step}. Check the whole setup, once signed in:"
print_message info "       ${run_cmd} doctor"
