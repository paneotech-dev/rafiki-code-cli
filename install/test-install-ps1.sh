#!/usr/bin/env bash
# Checks install/install.ps1 the way people run it, under PowerShell 7 on
# Linux: as a file, and as text piped into Invoke-Expression, which is the
# documented `irm ... | iex`. Through iex the script runs inside the caller's
# own session, where an `exit` would end that session (and close a Windows
# window before the error can be read), and where strict mode, the error
# preference and the helper functions would stay behind.
#
# What is checked:
#   - a failure run as a file prints the error and exits 1;
#   - a failure through iex prints the error, returns to the caller with
#     $LASTEXITCODE 1, and leaves no function, preference or variable behind;
#   - a successful install through iex ends with the next steps (login,
#     doctor, the RafikiCode folder) and creates that folder;
#   - "already installed" through iex returns instead of exiting.
#
# Needs pwsh on PATH, or docker with the image named in PWSH_IMAGE (default
# mcr.microsoft.com/powershell:lts-ubuntu-22.04) already pulled. Without
# either it says so and exits 0. The release is a local HTTP mirror served
# by python3; the "binary" is a shell script that prints its version.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=${PWSH_IMAGE:-mcr.microsoft.com/powershell:lts-ubuntu-22.04}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/rafikicode-install-ps1.XXXXXX")
server=""
cleanup() {
    if [ -n "$server" ]; then kill "$server" 2>/dev/null || true; fi
    rm -rf "$WORK"
}
trap cleanup EXIT

if command -v pwsh >/dev/null 2>&1; then
    runner=local
elif command -v docker >/dev/null 2>&1 && docker image inspect "$IMAGE" >/dev/null 2>&1; then
    runner=docker
else
    echo "skip: neither pwsh nor the $IMAGE image is available"
    exit 0
fi

mkdir -p "$WORK/mirror/download/v9.9.9" "$WORK/mirror/gw/health" "$WORK/home"
echo '"I am alive!"' > "$WORK/mirror/gw/health/liveliness"
# A release whose archive never matches its checksum, to drive the retries.
mkdir -p "$WORK/mirror/download/v9.9.7"
cp "$HERE/install.ps1" "$WORK/install.ps1"
python3 - "$WORK/mirror/download/v9.9.9" <<'PY'
import hashlib, sys, zipfile
target = sys.argv[1]
archive = f"{target}/rafikicode-windows-x64.zip"
with zipfile.ZipFile(archive, "w") as z:
    info = zipfile.ZipInfo("rafikicode.exe")
    info.external_attr = 0o100755 << 16
    info.create_system = 3
    z.writestr(info, "#!/bin/sh\necho 9.9.9\n")
digest = hashlib.sha256(open(archive, "rb").read()).hexdigest()
open(f"{target}/SHA256SUMS", "w").write(f"{digest}  rafikicode-windows-x64.zip\n")
bad = target.replace("v9.9.9", "v9.9.7")
open(f"{bad}/rafikicode-windows-x64.zip", "wb").write(open(archive, "rb").read())
open(f"{bad}/SHA256SUMS", "w").write("0" * 64 + "  rafikicode-windows-x64.zip\n")
PY

port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$WORK/mirror" >"$WORK/server.log" 2>&1 &
server=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
    if python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:$port/download/v9.9.9/SHA256SUMS')" 2>/dev/null; then break; fi
    sleep 0.3
done

cat > "$WORK/fails-in-caller.ps1" <<'EOF'
$env:VERSION = '9.9.8'
Get-Content (Join-Path $PSScriptRoot 'install.ps1') -Raw | iex
"caller continued, LASTEXITCODE=$LASTEXITCODE"
"Fail function left behind: $([bool](Get-Command Fail -ErrorAction SilentlyContinue))"
"ErrorActionPreference: $ErrorActionPreference"
"asFile left behind: $([bool](Get-Variable asFile -ErrorAction SilentlyContinue) -or [bool](Get-Variable RafikicodeInstallAsFile -ErrorAction SilentlyContinue))"
EOF
cat > "$WORK/installs-in-caller.ps1" <<'EOF'
$env:VERSION = '9.9.9'
Get-Content (Join-Path $PSScriptRoot 'install.ps1') -Raw | iex
"first, LASTEXITCODE=$LASTEXITCODE"
"workspace folder: $(Test-Path (Join-Path $env:USERPROFILE 'RafikiCode'))"
Get-Content (Join-Path $PSScriptRoot 'install.ps1') -Raw | iex
"second, LASTEXITCODE=$LASTEXITCODE"
EOF

# ps <script and arguments...>: runs pwsh -File with the mirror and home set.
ps() {
    if [ "$runner" = local ]; then
        env USERPROFILE="$WORK/home" RAFIKICODE_RELEASE_BASE="http://127.0.0.1:$port" RAFIKICODE_RELEASE_API="http://127.0.0.1:9" \
            RAFIKICODE_GATEWAY_URL="http://127.0.0.1:$port/gw/v1" RAFIKICODE_INSTALL_RETRY_DELAY=0 \
            pwsh -NoProfile -File "$WORK/$1" "${@:2}"
    else
        docker run --rm --network host -v "$WORK:/w" -e USERPROFILE=/w/home \
            -e RAFIKICODE_RELEASE_BASE="http://127.0.0.1:$port" -e RAFIKICODE_RELEASE_API="http://127.0.0.1:9" \
            -e RAFIKICODE_GATEWAY_URL="http://127.0.0.1:$port/gw/v1" -e RAFIKICODE_INSTALL_RETRY_DELAY=0 \
            "$IMAGE" pwsh -NoProfile -File "/w/$1" "${@:2}"
    fi
}

set +e
pass=0
fail=0
check() {
    if [ "$1" = "0" ]; then pass=$((pass + 1)); echo "ok   $2"; else fail=$((fail + 1)); echo "FAIL $2"; fi
}

out=$(ps install.ps1 -Version 9.9.8 -NoModifyPath 2>&1)
rc=$?
[ "$rc" = 1 ] && [[ "$out" == *"Error: Could not download SHA256SUMS for v9.9.8"* ]]
check $? "run as a file, a failure prints the error and exits 1"

out=$(ps fails-in-caller.ps1 2>&1)
rc=$?
[ "$rc" = 0 ] && [[ "$out" == *"Error: Could not download SHA256SUMS for v9.9.8"* ]] \
    && [[ "$out" == *"caller continued, LASTEXITCODE=1"* ]]
check $? "through iex, a failure prints the error and returns to the caller with LASTEXITCODE 1"
[[ "$out" == *"Fail function left behind: False"* ]] && [[ "$out" == *"ErrorActionPreference: Continue"* ]] \
    && [[ "$out" == *"asFile left behind: False"* ]]
check $? "through iex, no function, preference or variable is left in the caller's session"

out=$(ps installs-in-caller.ps1 2>&1)
rc=$?
[ "$rc" = 0 ] && [[ "$out" == *"Verified: rafikicode 9.9.9"* ]] && [[ "$out" == *"first, LASTEXITCODE=0"* ]]
check $? "through iex, an install succeeds and returns to the caller"
[[ "$out" == *"       rafikicode login"* ]] && [[ "$out" == *"       rafikicode doctor"* ]] \
    && [[ "$out" == *'       cd $HOME\RafikiCode'* ]] && [[ "$out" == *"workspace folder: True"* ]]
check $? "the next steps name login, doctor and the RafikiCode folder, which exists"
[[ "$out" == *"Version 9.9.9 is already installed"* ]] && [[ "$out" == *"second, LASTEXITCODE=0"* ]] \
    && [[ "$out" == *"Next: rafikicode login, then rafikicode doctor"* ]]
check $? "already installed, through iex, returns to the caller and still names login"

[[ "$out" == *"Ready."* ]] && [[ "$out" == *"works in this window now"* ]]
check $? "through iex, the closing check is green and the program works in this window"

: > "$WORK/home/a-file"
if [ "$runner" = local ]; then afile="$WORK/home/a-file"; else afile=/w/home/a-file; fi
out=$(ps install.ps1 -Version 9.9.9 -Prefix "$afile/bin" 2>&1)
rc=$?
[ "$rc" = 0 ] && [[ "$out" == *"cannot be written, so rafikicode is installed into"* ]]
check $? "an install folder that cannot be written falls back to the usual one"

before=$(grep -c "GET /download/v9.9.7/rafikicode-windows-x64.zip" "$WORK/server.log" || true)
out=$(ps install.ps1 -Version 9.9.7 -NoModifyPath 2>&1)
rc=$?
after=$(grep -c "GET /download/v9.9.7/rafikicode-windows-x64.zip" "$WORK/server.log" || true)
[ "$rc" = 1 ] && [ $((after - before)) = 3 ] && [[ "$out" == *"after three downloads"* ]] \
    && [[ "$out" == *"send that file to info@paneo.tech"* ]] && [ -s "$WORK/home/.rafikicode/install.log" ]
check $? "a checksum that never matches is downloaded three times, then explained, with the report written"

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
