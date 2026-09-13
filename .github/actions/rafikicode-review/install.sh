#!/usr/bin/env bash
# Installs a pinned rafikicode release for the review action. No remote script
# is run: the archive for this runner is downloaded straight from the release
# and must match a SHA256 pinned in the calling workflow before it is unpacked.
# Pinning the action itself by commit SHA pins this script too.
#
# Environment:
#   VERSION                  release to install, for example 0.1.0 (required)
#   SHA256                   the archive's sha256: one hash, or sha256sum lines
#                            naming each asset (required)
#   INSTALL_DIR              default $HOME/.rafikicode/bin
#   RAFIKICODE_RELEASE_BASE  download base, https only; plain http only for
#                            127.0.0.1 or [::1] with
#                            RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK=1 (local tests)
set -euo pipefail

APP=rafikicode
RELEASE_BASE="${RAFIKICODE_RELEASE_BASE:-https://github.com/paneotech-dev/rafiki-code-cli/releases}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.${APP}/bin}"

fail() {
    printf 'Error: %s\n' "$1" >&2
    exit 1
}

version="${VERSION:-}"
version="${version#v}"
[ -n "$version" ] || fail "the version input is required: pin a rafikicode release, for example 0.1.0."
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || fail "version '$version' is not a release number such as 0.1.0."
[ -n "${SHA256:-}" ] || fail "the sha256 input is required: copy the archive's line from SHA256SUMS of release v${version}."

# A plain host name, no user info; http only for the literal loopback
# addresses and only with the explicit test switch.
curl_proto=(--proto '=https' --proto-redir '=https')
url_path_re='(/[A-Za-z0-9._~%/+=-]*)?'
https_re="^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?${url_path_re}\$"
loopback_re="^http://(127\\.0\\.0\\.1|\\[::1\\])(:[0-9]{1,5})?${url_path_re}\$"
if [[ "$RELEASE_BASE" =~ $https_re ]]; then
    :
elif [[ "$RELEASE_BASE" =~ $loopback_re ]] && [ "${RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK:-}" = "1" ]; then
    curl_proto=()
else
    fail "RAFIKICODE_RELEASE_BASE must be an https URL (plain http only for 127.0.0.1 or [::1] with RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK=1, for local tests)."
fi

os="${RUNNER_OS:-$(uname -s)}"
arch="${RUNNER_ARCH:-$(uname -m)}"
case "$os" in
    Linux|linux) os=linux; ext=tar.gz ;;
    macOS|Darwin|darwin) os=darwin; ext=zip ;;
    *) fail "runner OS $os is not supported by this action; use a Linux or macOS runner." ;;
esac
case "$arch" in
    X64|x64|x86_64|amd64) arch=x64 ;;
    ARM64|arm64|aarch64) arch=arm64 ;;
    *) fail "runner architecture $arch is not supported." ;;
esac
asset="${APP}-${os}-${arch}.${ext}"

expected=""
if [[ "$SHA256" =~ ^[[:space:]]*([0-9a-fA-F]{64})[[:space:]]*$ ]]; then
    expected="${BASH_REMATCH[1]}"
else
    while read -r hash name; do
        name="${name#\*}"
        if [ "$name" = "$asset" ] && [[ "$hash" =~ ^[0-9a-fA-F]{64}$ ]]; then expected="$hash"; fi
    done <<< "$SHA256"
fi
[ -n "$expected" ] || fail "the sha256 input has no 64 character hash for ${asset}."
expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
url="${RELEASE_BASE}/download/v${version}/${asset}"
printf 'Downloading %s\n' "$url"
curl -fsSL ${curl_proto[@]+"${curl_proto[@]}"} -o "$tmp/$asset" "$url" || fail "could not download ${url}."

if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
else
    actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
fi
[ "$actual" = "$expected" ] || fail "checksum mismatch for ${asset}: expected ${expected}, got ${actual}. Nothing was installed."

mkdir -p "$tmp/unpacked"
if [ "$ext" = "tar.gz" ]; then
    tar -xzf "$tmp/$asset" -C "$tmp/unpacked"
else
    unzip -q "$tmp/$asset" -d "$tmp/unpacked"
fi
[ -f "$tmp/unpacked/$APP" ] || fail "${asset} does not contain ${APP}."
mkdir -p "$INSTALL_DIR"
install -m 0755 "$tmp/unpacked/$APP" "$INSTALL_DIR/$APP.new"
mv -f "$INSTALL_DIR/$APP.new" "$INSTALL_DIR/$APP"
printf 'Installed %s %s (sha256 %s) to %s\n' "$APP" "$version" "$actual" "$INSTALL_DIR/$APP"
