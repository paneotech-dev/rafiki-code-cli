#!/usr/bin/env bash
# Exercises install/install.sh against a local mock release server. Builds a
# fake release (a shell script standing in for the binary), serves it with
# python3's http.server, and checks: dry run, install, version pin, an already
# installed short circuit, a checksum mismatch that must fail without touching
# the installed binary, the symlink the installer places in a directory that is
# already on PATH, the wording of the next steps when no shell startup file was
# written, the doctor step that closes the next steps, and the post-install smoke
# test that must fail loudly when the installed binary cannot run.
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
# The installer colours its output, and the escapes land between the words of a
# single message, so assertions on whole lines read the plain text.
plain() { sed $'s/\033\[[0-9;]*m//g'; }
# The installer links into the first of /usr/local/bin and $HOME/.local/bin that
# is already on PATH and writable, and /usr/local/bin is both for root. The cases
# below run with a throwaway HOME and a PATH from which /usr/local/bin is
# removed, so the machine's own /usr/local/bin is never a candidate and nothing
# outside $WORK is written.
safe_path=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/usr/local/bin/*$' | paste -sd: -)

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

# The symlink into a directory already on PATH: the only part of the install
# that reaches the shell that ran it.

linkhome="$WORK/linkhome"
mkdir -p "$linkhome/.local/bin"
: > "$linkhome/.bashrc"
out=$(env HOME="$linkhome" SHELL=/bin/bash PATH="$linkhome/.local/bin:$safe_path" \
    RAFIKICODE_INSTALL_DIR="$linkhome/.rafikicode/bin" \
    bash "$INSTALLER" --version 1.2.2 2>&1 | plain)
[[ "$out" == *"Linked $linkhome/.local/bin/rafikicode so rafikicode runs in this terminal"* ]] \
    && [ -L "$linkhome/.local/bin/rafikicode" ] \
    && [ "$(readlink "$linkhome/.local/bin/rafikicode")" = "$linkhome/.rafikicode/bin/rafikicode" ] \
    && [ "$("$linkhome/.local/bin/rafikicode" --version)" = "1.2.2" ]; check $? "links into a writable PATH directory"

# Linked, so the next steps must not ask for a PATH export and must name the
# bare command, which now resolves.
[[ "$out" != *"To use this one"* ]] && [[ "$out" == *"       rafikicode login"* ]]; check $? "linked install shows the bare command and no PATH step"

# The one command that tells someone whether the install worked, which the
# installer never mentioned. It has to name the command that resolves here, the
# same one the sign in step names.
[[ "$out" == *"       rafikicode doctor"* ]] \
    && [[ "$out" == *"Check the whole setup"* ]]; check $? "the next steps end by pointing at doctor"

# A file that is not one of the installer's own links is left alone.
otherhome="$WORK/keephome"
mkdir -p "$otherhome/.local/bin"
echo "not ours" > "$otherhome/.local/bin/rafikicode"
out=$(env HOME="$otherhome" SHELL=/bin/bash PATH="$otherhome/.local/bin:$safe_path" \
    RAFIKICODE_INSTALL_DIR="$otherhome/.rafikicode/bin" \
    bash "$INSTALLER" --version 1.2.2 2>&1 | plain)
[[ "$out" != *"Linked "* ]] && [ "$(cat "$otherhome/.local/bin/rafikicode")" = "not ours" ]; check $? "never replaces a file that is not its own link"

# No writable directory on PATH: no link, the startup file is written for new
# terminals, and every command the next steps show is an absolute path.
nolinkhome="$WORK/nolinkhome"
mkdir -p "$nolinkhome"
: > "$nolinkhome/.bashrc"
out=$(env HOME="$nolinkhome" SHELL=/bin/bash PATH="$safe_path" \
    RAFIKICODE_INSTALL_DIR="$nolinkhome/.rafikicode/bin" \
    bash "$INSTALLER" --version 1.2.2 2>&1 | plain)
[[ "$out" != *"Linked "* ]] \
    && grep -Fq "export PATH=$nolinkhome/.rafikicode/bin:\$PATH" "$nolinkhome/.bashrc" \
    && [[ "$out" == *"       export PATH=$nolinkhome/.rafikicode/bin:\$PATH"* ]] \
    && [[ "$out" == *"       $nolinkhome/.rafikicode/bin/rafikicode login"* ]]; check $? "without a link, the startup file is written and the next steps use the full path"

# The doctor step carries the same command as the sign in step: the bare name
# only where it resolves, the absolute path everywhere else.
[[ "$out" == *"       $nolinkhome/.rafikicode/bin/rafikicode doctor"* ]]; check $? "the doctor step uses the full path when the bare name does not resolve"

# --no-modify-path makes no link even where one is possible, and writes nothing.
nomodhome="$WORK/nomodhome"
mkdir -p "$nomodhome/.local/bin"
: > "$nomodhome/.bashrc"
out=$(env HOME="$nomodhome" SHELL=/bin/bash PATH="$nomodhome/.local/bin:$safe_path" \
    RAFIKICODE_INSTALL_DIR="$nomodhome/.rafikicode/bin" \
    bash "$INSTALLER" --no-modify-path --version 1.2.2 2>&1 | plain)
[[ "$out" != *"Linked "* ]] \
    && [ ! -e "$nomodhome/.local/bin/rafikicode" ] \
    && [ ! -s "$nomodhome/.bashrc" ] \
    && [[ "$out" == *"       $nomodhome/.rafikicode/bin/rafikicode login"* ]]; check $? "--no-modify-path makes no link and touches no file"

# --no-modify-path writes no startup file, so the next steps must not claim that
# new terminals find the command on their own. No writable directory on PATH
# here either, so there is no link to make the claim true another way.
nomodwords="$WORK/nomodwords"
mkdir -p "$nomodwords"
: > "$nomodwords/.bashrc"
out=$(env HOME="$nomodwords" SHELL=/bin/bash PATH="$safe_path" \
    RAFIKICODE_INSTALL_DIR="$nomodwords/.rafikicode/bin" \
    bash "$INSTALLER" --no-modify-path --version 1.2.2 2>&1 | plain)
[[ "$out" != *"New terminals find rafikicode on their own"* ]] \
    && [[ "$out" == *"Nothing was added to your shell startup files"* ]] \
    && [[ "$out" == *"       export PATH=$nomodwords/.rafikicode/bin:\$PATH"* ]] \
    && [ ! -s "$nomodwords/.bashrc" ] \
    && [[ "$out" == *"       $nomodwords/.rafikicode/bin/rafikicode login"* ]]; check $? "--no-modify-path next steps promise nothing about new terminals"

# The same wording is earned once the entry really is in a startup file.
modwords="$WORK/modwords"
mkdir -p "$modwords"
: > "$modwords/.bashrc"
out=$(env HOME="$modwords" SHELL=/bin/bash PATH="$safe_path" \
    RAFIKICODE_INSTALL_DIR="$modwords/.rafikicode/bin" \
    bash "$INSTALLER" --version 1.2.2 2>&1 | plain)
[[ "$out" == *"New terminals find rafikicode on their own"* ]] \
    && grep -Fq "export PATH=$modwords/.rafikicode/bin:\$PATH" "$modwords/.bashrc"; check $? "next steps promise new terminals only once the startup file is written"

# The post-install smoke test: a binary that installs but cannot run must fail
# the install, with the exit status, what it said, and what to look at.
mkdir -p "$WORK/bad"
cat > "$WORK/bad/rafikicode" <<'EOF'
#!/bin/sh
echo "cannot execute binary file" >&2
exit 126
EOF
chmod 755 "$WORK/bad/rafikicode"
raw=$(bash "$INSTALLER" --no-modify-path --prefix "$WORK/badprefix/bin" --binary "$WORK/bad/rafikicode" 2>&1) && rc=0 || rc=$?
out=$(printf '%s\n' "$raw" | plain)
[ "$rc" != "0" ] \
    && [[ "$out" == *"was installed to $WORK/badprefix/bin/rafikicode but does not run"* ]] \
    && [[ "$out" == *"--version exited with status 126"* ]] \
    && [[ "$out" == *"it said: cannot execute binary file"* ]] \
    && [[ "$out" == *"xattr -d com.apple.quarantine"* ]] \
    && [[ "$out" != *"Next steps"* ]]; check $? "post-install version check fails loudly when the binary cannot run"

# --- Desktop platform selection -------------------------------------------
# detect_platform is the one part of the installer that running it on this
# machine can never exercise, so uname and sysctl are stubbed and only the
# resolved asset name is checked. --dry-run downloads nothing.
STUB="$WORK/stub"
mkdir -p "$STUB"
cat > "$STUB/uname" <<'EOF'
#!/bin/sh
case "$1" in
  -s) echo "${FAKE_OS:-Linux}" ;;
  -m) echo "${FAKE_ARCH:-x86_64}" ;;
  *)  echo "${FAKE_OS:-Linux}" ;;
esac
EOF
# macOS sysctl: a key that does not exist exits non-zero, which is what the
# installer's `|| echo 0` fallbacks expect.
cat > "$STUB/sysctl" <<'EOF'
#!/bin/sh
case "$*" in
  *proc_translated*) if [ -n "${FAKE_ROSETTA:-}" ]; then echo 1; else exit 1; fi ;;
  *avx2*) echo "${FAKE_AVX2:-0}" ;;
  *) exit 1 ;;
esac
EOF
chmod 755 "$STUB/uname" "$STUB/sysctl"

resolves_to() {
    # resolves_to <uname -s> <uname -m> [VAR=value ...]
    # env applies the trailing assignments: a bare "$@" in command position is
    # read as the command name, not as assignments.
    local want_os=$1 want_arch=$2
    shift 2
    env PATH="$STUB:$safe_path" FAKE_OS="$want_os" FAKE_ARCH="$want_arch" "$@" \
        bash "$INSTALLER" --dry-run --no-modify-path --no-login 2>&1 | plain
}

out=$(resolves_to Darwin arm64 FAKE_AVX2=0)
[[ "$out" == *"rafikicode-darwin-arm64.zip"* ]]; check $? "Apple Silicon picks darwin-arm64"

out=$(resolves_to Darwin x86_64 FAKE_AVX2=1)
[[ "$out" == *"rafikicode-darwin-x64.zip"* ]]; check $? "Intel Mac with AVX2 picks darwin-x64"

out=$(resolves_to Darwin x86_64 FAKE_AVX2=0)
[[ "$out" == *"rafikicode-darwin-x64-baseline.zip"* ]]; check $? "Intel Mac without AVX2 picks darwin-x64-baseline"

out=$(resolves_to Darwin x86_64 FAKE_ROSETTA=1)
[[ "$out" == *"rafikicode-darwin-arm64.zip"* ]]; check $? "Rosetta reports x86_64 but picks darwin-arm64"

out=$(resolves_to MINGW64_NT-10.0 x86_64)
[[ "$out" == *"rafikicode-windows-x64.zip"* ]] && [[ "$out" == *"rafikicode.exe"* ]]; check $? "Git Bash picks windows-x64 and installs rafikicode.exe"

# windows-arm64 is published with every release, so it has to be installable.
out=$(resolves_to MINGW64_NT-10.0 aarch64)
[[ "$out" == *"rafikicode-windows-arm64.zip"* ]]; check $? "Windows on ARM picks windows-arm64"

out=$(resolves_to Linux aarch64)
[[ "$out" == *"rafikicode-linux-arm64.tar.gz"* ]]; check $? "Linux arm64 picks linux-arm64"

# --- A HOME with no shell startup file ------------------------------------
# A fresh macOS account runs zsh and has no ~/.zshrc, and /usr/local/bin there
# is root owned, so the symlink cannot be made either. With nothing written and
# nothing linked the binary is unreachable by name from every new terminal.
freshzsh="$WORK/fresh-zsh"
mkdir -p "$freshzsh"
out=$(env HOME="$freshzsh" SHELL=/bin/zsh PATH="$safe_path" \
    RAFIKICODE_INSTALL_DIR="$freshzsh/.rafikicode/bin" \
    bash "$INSTALLER" --no-login --binary "$WORK/build-1.2.3/rafikicode" 2>&1 | plain)
[ ! -L "$freshzsh/.local/bin/rafikicode" ] \
    && [ -f "$freshzsh/.zshrc" ] \
    && grep -q "export PATH=$freshzsh/.rafikicode/bin:\$PATH" "$freshzsh/.zshrc"
check $? "a zsh HOME with no startup file gets ~/.zshrc created with the PATH line"

# Installing twice must not append the same line again.
out=$(env HOME="$freshzsh" SHELL=/bin/zsh PATH="$safe_path" \
    RAFIKICODE_INSTALL_DIR="$freshzsh/.rafikicode/bin" \
    bash "$INSTALLER" --no-login --binary "$WORK/build-1.2.3/rafikicode" 2>&1 | plain)
[ "$(grep -c "^export PATH=$freshzsh/.rafikicode/bin:\$PATH\$" "$freshzsh/.zshrc")" = "1" ]
check $? "a second install does not duplicate the PATH line"

# And the next steps must now promise new terminals, because a file was written.
[[ "$out" == *"New terminals find rafikicode on their own"* ]]
check $? "a created startup file is reported as new terminals being set"

freshbash="$WORK/fresh-bash"
mkdir -p "$freshbash"
out=$(env HOME="$freshbash" SHELL=/bin/bash PATH="$safe_path" \
    RAFIKICODE_INSTALL_DIR="$freshbash/.rafikicode/bin" \
    bash "$INSTALLER" --no-login --binary "$WORK/build-1.2.3/rafikicode" 2>&1 | plain)
[ -f "$freshbash/.bashrc" ]; check $? "a bash HOME with no startup file gets ~/.bashrc created"

# --no-modify-path must still write nothing, even with no startup file present.
freshnone="$WORK/fresh-untouched"
mkdir -p "$freshnone"
out=$(env HOME="$freshnone" SHELL=/bin/zsh PATH="$safe_path" \
    RAFIKICODE_INSTALL_DIR="$freshnone/.rafikicode/bin" \
    bash "$INSTALLER" --no-login --no-modify-path --binary "$WORK/build-1.2.3/rafikicode" 2>&1 | plain)
[ ! -e "$freshnone/.zshrc" ]; check $? "--no-modify-path creates no startup file"

echo "install tests: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ]
