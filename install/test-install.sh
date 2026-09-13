#!/usr/bin/env bash
# Exercises install/install.sh against a local mock release server. Builds a
# fake release (a shell script standing in for the binary), serves it with
# python3's http.server, and checks: dry run, install, version pin, an already
# installed short circuit, and a checksum mismatch that must fail without
# touching the installed binary.
set -euo pipefail

PORT="${PORT:-4150}"
HERE=$(cd "$(dirname "$0")" && pwd)
INSTALLER="$HERE/install.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/rafikicode-install-test.XXXXXX")
trap 'kill "${SERVER_PID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

if command -v ss >/dev/null 2>&1 && ss -tln | awk '{print $4}' | grep -q ":${PORT}\$"; then
    echo "port ${PORT} is in use, set PORT to a free one" >&2
    exit 1
fi

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
[[ "$arch" == "x86_64" ]] && arch=x64
[[ "$arch" == "aarch64" ]] && arch=arm64
target="$os-$arch"
if [ "$os" = "linux" ] && [ "$arch" = "x64" ] && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then
    target="$target-baseline"
fi
if [ "$os" = "linux" ] && ldd --version 2>&1 | grep -qi musl; then
    target="$target-musl"
fi
ext=".tar.gz"
[ "$os" = "linux" ] || ext=".zip"

make_release() {
    local version=$1
    local dir="$WORK/site/dl/download/v${version}"
    mkdir -p "$dir" "$WORK/build-${version}"
    cat > "$WORK/build-${version}/rafikicode" <<EOF
#!/bin/sh
if [ "\$1" = "--version" ]; then echo "${version}"; exit 0; fi
echo "rafikicode fake ${version}"
EOF
    chmod 755 "$WORK/build-${version}/rafikicode"
    local archive="$dir/rafikicode-${target}${ext}"
    if [ "$ext" = ".tar.gz" ]; then
        tar -czf "$archive" -C "$WORK/build-${version}" rafikicode
    else
        (cd "$WORK/build-${version}" && zip -q "$archive" rafikicode)
    fi
    (cd "$dir" && if command -v sha256sum >/dev/null 2>&1; then sha256sum "rafikicode-${target}${ext}"; else shasum -a 256 "rafikicode-${target}${ext}"; fi > SHA256SUMS)
}

make_release 1.2.3
make_release 1.2.2
mkdir -p "$WORK/site/api/releases"
echo '{"tag_name": "v1.2.3", "name": "v1.2.3"}' > "$WORK/site/api/releases/latest"

(cd "$WORK/site" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >"$WORK/server.log" 2>&1) &
SERVER_PID=$!
for _ in $(seq 1 50); do
    curl -fsS "http://127.0.0.1:${PORT}/api/releases/latest" >/dev/null 2>&1 && break
    sleep 0.1
done

export RAFIKICODE_RELEASE_API="http://127.0.0.1:${PORT}/api"
export RAFIKICODE_RELEASE_BASE="http://127.0.0.1:${PORT}/dl"
# The mock release server is plain http on loopback: the explicit test switch.
export RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK=1
export RAFIKICODE_INSTALL_DIR="$WORK/prefix/bin"
export HOME="$WORK/home"
mkdir -p "$HOME"

# Assertions below record their own result; a failing assertion must not end
# the script, so errexit is switched off from here on.
set +e
pass=0
fail=0
check() {
    if [ "$1" = "0" ]; then pass=$((pass + 1)); echo "ok   $2"; else fail=$((fail + 1)); echo "FAIL $2"; fi
}

out=$(bash "$INSTALLER" --dry-run --no-modify-path 2>&1)
[[ "$out" == *"dry run: rafikicode 1.2.3 for ${target}"* ]] && [ ! -e "$RAFIKICODE_INSTALL_DIR/rafikicode" ]; check $? "dry run resolves latest and installs nothing"

out=$(bash "$INSTALLER" --no-modify-path 2>&1)
[ -x "$RAFIKICODE_INSTALL_DIR/rafikicode" ] && [ "$("$RAFIKICODE_INSTALL_DIR/rafikicode" --version)" = "1.2.3" ] && [[ "$out" == *"Checksum verified"* ]]; check $? "installs latest with checksum verified"

out=$(bash "$INSTALLER" --no-modify-path 2>&1)
[[ "$out" == *"already installed"* ]]; check $? "already installed short circuit"

out=$(bash "$INSTALLER" --no-modify-path --version v1.2.2 2>&1)
[ "$("$RAFIKICODE_INSTALL_DIR/rafikicode" --version)" = "1.2.2" ]; check $? "version pin installs 1.2.2"

out=$(bash "$INSTALLER" --no-modify-path --version 9.9.9 2>&1) && rc=0 || rc=$?
[ "$rc" != "0" ] && [[ "$out" == *"could not download SHA256SUMS"* ]]; check $? "unknown version fails clearly"

# Corrupt the archive so the published checksum no longer matches.
echo "tampered" >> "$WORK/site/dl/download/v1.2.3/rafikicode-${target}${ext}"
before=$(sha256sum "$RAFIKICODE_INSTALL_DIR/rafikicode" 2>/dev/null || shasum -a 256 "$RAFIKICODE_INSTALL_DIR/rafikicode")
out=$(bash "$INSTALLER" --no-modify-path --version 1.2.3 2>&1) && rc=0 || rc=$?
after=$(sha256sum "$RAFIKICODE_INSTALL_DIR/rafikicode" 2>/dev/null || shasum -a 256 "$RAFIKICODE_INSTALL_DIR/rafikicode")
[ "$rc" != "0" ] && [[ "$out" == *"checksum mismatch"* ]] && [ "$before" = "$after" ] && [ ! -e "$RAFIKICODE_INSTALL_DIR/rafikicode.new" ]; check $? "checksum mismatch fails and leaves the installed binary untouched"

out=$(bash "$INSTALLER" --no-modify-path --binary "$WORK/build-1.2.3/rafikicode" 2>&1)
[ "$("$RAFIKICODE_INSTALL_DIR/rafikicode" --version)" = "1.2.3" ]; check $? "local binary install"

out=$(bash "$INSTALLER" --no-modify-path --prefix "$WORK/other/bin" --version 1.2.2 2>&1)
[ "$("$WORK/other/bin/rafikicode" --version)" = "1.2.2" ] && [[ "$out" == *"Add $WORK/other/bin to your PATH"* ]]; check $? "prefix option and PATH note"

echo "install tests: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ]
