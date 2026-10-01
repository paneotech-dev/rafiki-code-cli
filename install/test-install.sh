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
plainout=$(printf '%s\n' "$out" | plain)
[ "$rc" != "0" ] && [ "$before" = "$after" ] && [ ! -e "$RAFIKICODE_INSTALL_DIR/rafikicode.new" ] \
    && [[ "$plainout" == *"is not the file the release says it is"* ]] \
    && [[ "$plainout" == *"Nothing was installed and the download has been deleted"* ]] \
    && [[ "$plainout" == *"Do not run a rafikicode binary that failed this check"* ]] \
    && [[ "$plainout" == *"expected: "* ]] && [[ "$plainout" == *"received: "* ]]; check $? "checksum mismatch fails, says what it means, and leaves the installed binary untouched"

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

# --- Missing prerequisites ---------------------------------------------------
#
# Every one of these used to end in a single line that named a condition: "'curl'
# is required but not installed". The point of the cases below is that the output
# now contains a command the person can paste, chosen for the package manager the
# machine actually has.
#
# A missing tool is simulated with a PATH that holds only what the case wants the
# installer to find: a directory of symlinks to the real tools, minus the one
# under test. A missing (or particular) package manager is simulated the same way,
# which keeps these cases independent of whatever distribution the suite runs on.
SANDBOX_TOOLS="sed awk head tr grep mktemp mkdir chmod mv cp rm ln touch cat ls
    dirname basename df id uname sleep tar unzip curl sha256sum"
# The sandbox PATH holds only the tools a case wants the installer to find, so
# bash is not on it either: run the interpreter by its absolute path.
BASH_BIN=$(command -v bash)
# $1 = directory to build, $2 = space separated tools to leave out, $3 = fake
# executables to create (a package manager, or an id that reports a normal user).
mkbin() {
    local dir=$1 omit=" ${2:-} " fakes=${3:-} tool real
    rm -rf "$dir"
    mkdir -p "$dir"
    for tool in $SANDBOX_TOOLS; do
        case "$omit" in *" $tool "*) continue ;; esac
        real=$(command -v "$tool" 2>/dev/null) || continue
        ln -sf "$real" "$dir/$tool"
    done
    for tool in $fakes; do
        case "$tool" in
            id-as-user) stub_id "$dir" 1000 tester ;;
            id-as-root) stub_id "$dir" 0 root ;;
            df-as-full) stub_df_full "$dir" ;;
            # A package manager that only has to exist to be detected: the
            # installer probes for the binary and never runs it.
            *) write_stub "$dir/$tool" '#!/bin/sh\nexit 0\n' ;;
        esac
    done
}

# Write a stub executable, replacing whatever is at that path.
#
# The rm is not tidiness, it is the whole point: the loop above fills $dir with
# symlinks to the real tools, and a redirection onto a symlink writes THROUGH it
# to the target. Without the rm, stubbing df or id here silently overwrites
# /usr/bin/df or /usr/bin/id on the machine running the suite. The refusal to
# write outside $WORK is the second belt for the same mistake.
write_stub() {
    local path=$1 body=$2
    case "$path" in
        "$WORK"/*) ;;
        *) echo "refusing to write a stub outside the test directory: $path" >&2; exit 1 ;;
    esac
    rm -f "$path"
    printf "$body" > "$path"
    chmod 755 "$path"
}

stub_id() {
    write_stub "$1/id" "#!/bin/sh\nif [ \"\$1\" = \"-u\" ]; then echo $2; else echo $3; fi\n"
}

stub_df_full() {
    write_stub "$1/df" '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "tmpfs 1024000 1000000 20480 98%% /"\n'
}

# curl missing, on a machine with apt-get. The whole point of the change: an
# apt-get line to paste, not the name of a condition.
mkbin "$WORK/bin-nocurl-apt" "curl" "apt-get sudo id-as-root"
out=$(env PATH="$WORK/bin-nocurl-apt" HOME="$WORK/home" \
    "$BASH_BIN" "$INSTALLER" --no-modify-path 2>&1 | plain) && rc=0 || rc=$?
[ "$rc" != "0" ] \
    && [[ "$out" == *"curl is missing"* ]] \
    && [[ "$out" == *"curl downloads the release"* ]] \
    && [[ "$out" == *"This machine has apt-get"* ]] \
    && [[ "$out" == *"apt-get update && apt-get install -y curl"* ]] \
    && [[ "$out" == *"Then run this installer again"* ]]; check $? "missing curl prints the apt-get command for this machine"

# Two tools missing at once are reported together, in one install command. This
# is the preflight: on a minimal image this used to be two runs and two errors.
mkbin "$WORK/bin-nocurltar-dnf" "curl tar" "dnf sudo id-as-root"
out=$(env PATH="$WORK/bin-nocurltar-dnf" HOME="$WORK/home" \
    "$BASH_BIN" "$INSTALLER" --no-modify-path 2>&1 | plain) && rc=0 || rc=$?
[ "$rc" != "0" ] \
    && [[ "$out" == *"curl and tar are missing"* ]] \
    && [[ "$out" == *"dnf install -y curl tar"* ]]; check $? "two missing tools are reported in one pass with one command"

# The checksum tool is a package whose name is not the name of the command.
mkbin "$WORK/bin-nosum-apk" "sha256sum shasum" "apk sudo id-as-root"
out=$(env PATH="$WORK/bin-nosum-apk" HOME="$WORK/home" \
    "$BASH_BIN" "$INSTALLER" --no-modify-path 2>&1 | plain) && rc=0 || rc=$?
[ "$rc" != "0" ] \
    && [[ "$out" == *"sha256sum is missing"* ]] \
    && [[ "$out" == *"apk add coreutils"* ]]; check $? "a missing checksum tool names the coreutils package, not the command"

# Each manager gets its own syntax. pacman and zypper take different flags, and
# brew must never be given sudo.
mkbin "$WORK/bin-pacman" "curl" "pacman sudo id-as-user"
out=$(env PATH="$WORK/bin-pacman" HOME="$WORK/home" "$BASH_BIN" "$INSTALLER" 2>&1 | plain) || true
[[ "$out" == *"sudo pacman -Sy --noconfirm curl"* ]]; check $? "pacman gets its own flags, with sudo for a normal user"

mkbin "$WORK/bin-brew" "curl" "brew id-as-user"
out=$(env PATH="$WORK/bin-brew" HOME="$WORK/home" "$BASH_BIN" "$INSTALLER" 2>&1 | plain) || true
[[ "$out" == *"brew install curl"* ]] && [[ "$out" != *"sudo brew"* ]]; check $? "brew is never prefixed with sudo"

# Root needs no sudo, and saying it would be wrong.
mkbin "$WORK/bin-root-zypper" "curl" "zypper sudo id-as-root"
out=$(env PATH="$WORK/bin-root-zypper" HOME="$WORK/home" "$BASH_BIN" "$INSTALLER" 2>&1 | plain) || true
[[ "$out" == *"zypper install -y curl"* ]] && [[ "$out" != *"sudo zypper"* ]]; check $? "no sudo is suggested when already root"

# A normal user on a host with a package manager but no sudo: the shared hosting
# case. Guessing that they can install it themselves is the wrong answer; the
# right one is the sentence to send the host.
mkbin "$WORK/bin-nosudo" "curl sudo" "apt-get id-as-user"
out=$(env PATH="$WORK/bin-nosudo" HOME="$WORK/home" "$BASH_BIN" "$INSTALLER" 2>&1 | plain) || true
[[ "$out" == *"but no sudo"* ]] \
    && [[ "$out" == *"shared and cPanel style hosting"* ]] \
    && [[ "$out" == *"Otherwise send whoever runs this server this line"* ]] \
    && [[ "$out" == *'"Please install curl on this account.'* ]]; check $? "no sudo gives the sentence to send the host, not a command that will fail"

# No package manager at all: say what was looked for, and give the route that
# needs none of it.
mkbin "$WORK/bin-nomgr" "curl sudo" "id-as-root"
out=$(env PATH="$WORK/bin-nomgr" HOME="$WORK/home" "$BASH_BIN" "$INSTALLER" 2>&1 | plain) || true
[[ "$out" == *"No package manager was found here"* ]] \
    && [[ "$out" == *"apt-get, dnf, yum, pacman"* ]] \
    && [[ "$out" == *"Otherwise send whoever runs this server this line"* ]] \
    && [[ "$out" == *"--binary /path/to/rafikicode"* ]]; check $? "no package manager names what was looked for and the offline route"

# --- Platform, space and permissions ----------------------------------------

# An architecture with no published build. A fake uname keeps this independent of
# the machine the suite runs on.
mkbin "$WORK/bin-riscv" "uname" "sudo"
write_stub "$WORK/bin-riscv/uname" '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo riscv64 ;; *) echo Linux ;; esac\n'

out=$(env PATH="$WORK/bin-riscv" HOME="$WORK/home" "$BASH_BIN" "$INSTALLER" 2>&1 | plain) && rc=0 || rc=$?
[ "$rc" != "0" ] \
    && [[ "$out" == *"no build for this machine: linux/riscv64"* ]] \
    && [[ "$out" == *"uname -s said Linux, uname -m said riscv64"* ]] \
    && [[ "$out" == *"Published builds: linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64 windows-arm64"* ]] \
    && [[ "$out" == *"report it at"* ]]; check $? "an unpublished architecture says what was detected and what is published"

# Windows reported by a spelling the asset selection deliberately does not match.
# There is no PowerShell installer in this release, so the message must not
# promise one; it names the two routes that do work.
mkbin "$WORK/bin-win" "uname" "sudo"
write_stub "$WORK/bin-win/uname" '#!/bin/sh\ncase "$1" in -s) echo Windows_NT ;; -m) echo x86_64 ;; *) echo Windows_NT ;; esac\n'

out=$(env PATH="$WORK/bin-win" HOME="$WORK/home" "$BASH_BIN" "$INSTALLER" 2>&1 | plain) && rc=0 || rc=$?
[ "$rc" != "0" ] \
    && [[ "$out" == *"This looks like Windows"* ]] \
    && [[ "$out" == *"WSL, the Windows Subsystem for Linux"* ]] \
    && [[ "$out" == *"Git Bash or MSYS2"* ]] \
    && [[ "$out" == *"native PowerShell installer"* ]] \
    && [[ "$out" == *"install.ps1"* ]]; check $? "Windows is told every route that works, including the PowerShell installer this release ships"

# Disk space, checked before the download rather than after: a truncated archive
# fails the checksum, which reads like tampering and is not.
mkbin "$WORK/bin-full" "" "df-as-full"
out=$(env PATH="$WORK/bin-full:$safe_path" HOME="$WORK/home" TMPDIR="$WORK/home" \
    "$BASH_BIN" "$INSTALLER" --no-modify-path 2>&1 | plain) && rc=0 || rc=$?
[ "$rc" != "0" ] \
    && [[ "$out" == *"not enough free disk space"* ]] \
    && [[ "$out" == *"about 58 MB once extracted"* ]] \
    && [[ "$out" == *"TMPDIR=/path/with/space"* ]] \
    && [[ "$out" != *"Checksum verified"* ]]; check $? "a full disk is reported before anything is downloaded"

# An install directory the user cannot write. Root bypasses file permissions, so
# this one drops to an unprivileged user; it is skipped where that is not
# possible rather than passing for the wrong reason.
if [ "$(id -u)" != "0" ] || command -v setpriv >/dev/null 2>&1; then
    roprefix="$WORK/readonly"
    mkdir -p "$roprefix"
    chmod 0555 "$roprefix"
    chmod 0755 "$WORK"
    if [ "$(id -u)" = "0" ]; then
        runas="setpriv --reuid=65534 --regid=65534 --clear-groups"
    else
        runas=""
    fi
    out=$($runas env PATH="$safe_path" HOME="$WORK/home" \
        "$BASH_BIN" "$INSTALLER" --no-modify-path --prefix "$roprefix/bin" 2>&1 | plain) && rc=0 || rc=$?
    [ "$rc" != "0" ] \
        && [[ "$out" == *"is not writable by you"* ]] \
        && [[ "$out" == *'--prefix "$HOME/.rafikicode/bin"'* ]] \
        && [[ "$out" != *"Checksum verified"* ]]; check $? "an unwritable install directory is refused before the download, with a prefix to use instead"
else
    echo "skip an unwritable install directory (needs setpriv or a non-root user)"
fi

# --- Download failures, told apart --------------------------------------------
#
# "download failed: <url>" was the same sentence for no network, no DNS, an
# expired CA bundle, a proxy nobody told curl about, and a version that was never
# published. curl's exit status separates them.
out=$(env RAFIKICODE_RELEASE_API="https://no-such-host.invalid/api" \
    RAFIKICODE_RELEASE_BASE="https://no-such-host.invalid/dl" \
    HOME="$WORK/home" "$BASH_BIN" "$INSTALLER" --no-modify-path 2>&1 | plain) && rc=0 || rc=$?
[ "$rc" != "0" ] \
    && [[ "$out" == *"could not reach the release server"* ]] \
    && [[ "$out" == *"host name did not resolve"* ]] \
    && [[ "$out" == *"getent hosts"* ]]; check $? "a name that does not resolve is reported as DNS, with the command to confirm it"

out=$(env RAFIKICODE_RELEASE_API="https://127.0.0.1:1/api" \
    RAFIKICODE_RELEASE_BASE="https://127.0.0.1:1/dl" \
    HOME="$WORK/home" "$BASH_BIN" "$INSTALLER" --no-modify-path 2>&1 | plain) && rc=0 || rc=$?
[ "$rc" != "0" ] \
    && [[ "$out" == *"refused the connection"* ]] \
    && [[ "$out" == *"export https_proxy="* ]]; check $? "a refused connection mentions the firewall and how to name a proxy"

# A version that was never published is an HTTP error, not a network fault, and
# the answer is the list of releases.
out=$("$BASH_BIN" "$INSTALLER" --no-modify-path --version 9.9.9 2>&1 | plain) && rc=0 || rc=$?
[ "$rc" != "0" ] \
    && [[ "$out" == *"no such file, because there is no such"* ]] \
    && [[ "$out" == *"Leaving --version off installs the latest release"* ]]; check $? "an unpublished version is told apart from a network failure"

# --binary pointed at a directory, which is what happens when someone unpacks the
# archive and passes the folder.
out=$("$BASH_BIN" "$INSTALLER" --no-modify-path --binary "$WORK/build-1.2.3" 2>&1 | plain) && rc=0 || rc=$?
[ "$rc" != "0" ] \
    && [[ "$out" == *"is a directory"* ]] \
    && [[ "$out" == *"--binary $WORK/build-1.2.3/rafikicode"* ]]; check $? "--binary given a directory names the file inside it"

# A release that published no asset for this machine: the checksum file is there
# and simply has no line for this target. The answer is the list of builds it did
# publish, not the name of the missing one.
nobuild="$WORK/site/dl/download/v1.5.0"
mkdir -p "$nobuild"
printf 'aaaa  rafikicode-linux-arm64.tar.gz\nbbbb  rafikicode-darwin-arm64.zip\n' > "$nobuild/SHA256SUMS"
out=$(bash "$INSTALLER" --no-modify-path --version 1.5.0 2>&1 | plain) && rc=0 || rc=$?
[ "$rc" != "0" ] \
    && [[ "$out" == *"was published, but without a build for this machine"* ]] \
    && [[ "$out" == *"That release publishes:"* ]] \
    && [[ "$out" == *"    rafikicode-linux-arm64.tar.gz"* ]] \
    && [[ "$out" == *"    rafikicode-darwin-arm64.zip"* ]] \
    && [[ "$out" == *"--binary /path/to/rafikicode"* ]]; check $? "a release with no build for this machine lists the builds it does have"

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

# --- A rate limited API must not be reported as a missing release -------------
#
# GitHub allows 60 unauthenticated API requests an hour per IP, shared by
# everyone behind that address, and answers 403 when it runs out. curl reports a
# 403 with the same exit 22 it uses for a 404, so the installer used to tell the
# user there was no such release and send them to check a version number that
# was correct. These drive a real 403 and a real 302 from a local server rather
# than a stub, because the bug was in how the two statuses are told apart.
cat > "$WORK/ratelimit-server.py" <<'PYEOF'
import http.server, sys, functools

SITE, PORT = sys.argv[1], int(sys.argv[2])

class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/"):
            body = (b'{"message": "API rate limit exceeded for 203.0.113.9. '
                    b'(But here is the good news: Authenticated requests get a '
                    b'higher rate limit.)"}')
            self.send_response(403)
            self.send_header("Content-Type", "application/json")
            self.send_header("X-RateLimit-Limit", "60")
            self.send_header("X-RateLimit-Remaining", "0")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/dl/latest":
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{PORT}/dl/tag/v1.2.3")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, *a):
        pass

http.server.HTTPServer(
    ("127.0.0.1", PORT),
    functools.partial(H, directory=SITE),
).serve_forever()
PYEOF

RL_PORT=$((PORT + 1))
python3 "$WORK/ratelimit-server.py" "$WORK/site" "$RL_PORT" >"$WORK/ratelimit.log" 2>&1 &
RL_PID=$!
for _ in $(seq 1 50); do
    curl -sS -o /dev/null "http://127.0.0.1:${RL_PORT}/dl/latest" 2>/dev/null && break
    sleep 0.1
done

# Earlier cases in this file deliberately corrupt the fixture archive to prove
# the checksum check bites, and nothing restores it, so rebuild the release
# before asking for a successful install.
make_release 1.2.3

# The API is exhausted, the release page still answers: the install must succeed.
rlhome="$WORK/home-ratelimited"
mkdir -p "$rlhome"
out=$(env RAFIKICODE_RELEASE_API="http://127.0.0.1:${RL_PORT}/api" \
    RAFIKICODE_RELEASE_BASE="http://127.0.0.1:${RL_PORT}/dl" \
    RAFIKICODE_INSTALL_DIR="$WORK/prefix-ratelimited/bin" \
    HOME="$rlhome" "$BASH_BIN" "$INSTALLER" --no-login --no-modify-path 2>&1 | plain) && rc=0 || rc=$?
[ "$rc" = "0" ] \
    && [[ "$out" != *"there is no such"* ]] \
    && [[ "$out" != *"curl: ("* ]] \
    && [ -x "$WORK/prefix-ratelimited/bin/rafikicode" ] \
    && [ "$("$WORK/prefix-ratelimited/bin/rafikicode" --version)" = "1.2.3" ]; check $? "a rate limited API falls back to the release page instead of claiming the release is missing"

# Both routes gone: the message must raise the rate limit rather than only 404.
out=$(env RAFIKICODE_RELEASE_API="http://127.0.0.1:${RL_PORT}/api" \
    RAFIKICODE_RELEASE_BASE="http://127.0.0.1:${PORT}/dl" \
    HOME="$rlhome" "$BASH_BIN" "$INSTALLER" --no-login --no-modify-path 2>&1 | plain) && rc=0 || rc=$?
[ "$rc" != "0" ] \
    && [[ "$out" == *"60 requests an hour per IP address"* ]] \
    && [[ "$out" == *"Your version number is probably fine"* ]] \
    && [[ "$out" == *"curl -s https://api.github.com/rate_limit"* ]] \
    && [[ "$out" == *"returned error: 403"* ]] \
    && [[ "$out" == *"bash -s -- --version"* ]]; check $? "an exhausted API names the rate limit and says the version is probably fine"

kill "$RL_PID" 2>/dev/null
wait "$RL_PID" 2>/dev/null

echo "install tests: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ]
