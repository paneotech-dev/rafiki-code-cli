#!/bin/sh
# Runs inside one install matrix container. Drives install/install.sh the way a
# user does, then reports five facts about the result, one line each:
#
#   MATRIX_RESULT <facet> <pass|fail|skip> <detail>
#
#   installer  the installer ran to completion
#   onpath     a new interactive terminal finds the command by name
#   loginpath  a non-interactive login shell finds it, which is ssh, cron and CI
#   version    --version prints the version that was installed
#   doctor     doctor runs its checks without crashing
#   tui        the terminal interface starts and stays up
#
# Plain POSIX sh on purpose: this has to run under Alpine's ash as well as bash,
# because whether bash exists at all is one of the things being measured.
#
# The facets are deliberately separate. A binary for the wrong C library still
# passes "installer" and fails "version"; a noexec temporary directory passes
# every facet except "tui". Collapsing them is how "it worked on the build box"
# came to be recorded as "it works".

INSTALLER=${MATRIX_INSTALLER:-/matrix/install.sh}
VERSION=${MATRIX_VERSION:-}
MIRROR=${MATRIX_MIRROR:-}
LOGDIR=${MATRIX_LOGDIR:-/matrix-out}
TUI_WAIT=${MATRIX_TUI_WAIT:-12}

mkdir -p "$LOGDIR" 2>/dev/null || LOGDIR=$(mktemp -d 2>/dev/null || echo /tmp)

# A literal escape, built rather than written: \033 is a GNU sed extension and
# this also has to run under BusyBox sed on Alpine, where it is not one.
ESC=$(printf '\033')
decolour() { sed -e "s/${ESC}\\[[0-9;?]*[a-zA-Z]//g" -e "s/${ESC}[]()>=][0-9;?]*//g" | tr -d '\007\r'; }

say() {
    # Detail is one line: strip newlines and the escape sequences the installer
    # and the TUI both emit, so the driver's table never gets corrupted.
    detail=$(printf '%s' "$3" | tr '\n\t' '  ' | decolour | cut -c1-200)
    printf 'MATRIX_RESULT %s %s %s\n' "$1" "$2" "$detail"
}

# ---------------------------------------------------------------- environment --

echo "=== probe environment ==="
echo "whoami:  $(id -un 2>/dev/null || id -u)"
echo "home:    ${HOME-<unset>}"
echo "umask:   $(umask)"
echo "shell:   ${SHELL-<unset>}"
echo "tty:     $([ -t 1 ] && echo yes || echo no) (stdin: $([ -t 0 ] && echo yes || echo no))"
echo "arch:    $(uname -m) ($(uname -s))"
echo "libc:    $(ldd --version 2>&1 | head -1)"
echo "tmpdir:  ${TMPDIR-<unset>}"
echo "tmp opts: $(awk '$2=="/tmp"{print $3" "$4}' /proc/mounts 2>/dev/null | head -1)"
echo "tmp free: $(df -Pk /tmp 2>/dev/null | awk 'NR==2{print $4" KiB"}')"
for t in bash curl tar unzip gzip sha256sum timeout; do
    printf '  %-10s %s\n' "$t" "$(command -v "$t" 2>/dev/null || echo MISSING)"
done
echo

# ------------------------------------------------------------------ installer --

# The documented command is `curl -fsSL https://get.rafikiai.io | bash`, so the
# installer is a bash script. Where there is no bash there is no install, and
# that is a result, not a reason to skip the cell.
if ! command -v bash >/dev/null 2>&1; then
    say installer fail "bash is not installed; install.sh is a bash script and cannot run"
    for f in onpath loginpath version doctor tui; do say "$f" skip "installer could not run"; done
    exit 0
fi

set -- --no-login
[ -n "$VERSION" ] && set -- "$@" --version "$VERSION"
if [ -n "$MIRROR" ]; then
    # Loopback http is accepted only behind this switch, and only for a local
    # mirror of the real release assets.
    set -- "$@" --allow-http-loopback
    RAFIKICODE_RELEASE_API="$MIRROR/api"
    RAFIKICODE_RELEASE_BASE="$MIRROR/dl"
    export RAFIKICODE_RELEASE_API RAFIKICODE_RELEASE_BASE
fi

echo "=== installer: bash $INSTALLER $* ==="
# MATRIX_INSTALL_TMPDIR models a host where the installer has somewhere roomy to
# unpack but the binary still starts with the system temporary directory, which
# is what a noexec /tmp on shared hosting actually looks like. It is exported for
# the installer only, never for the binary.
install_status=0
if [ -n "${MATRIX_INSTALL_TMPDIR:-}" ]; then
    mkdir -p "$MATRIX_INSTALL_TMPDIR" 2>/dev/null
    TMPDIR="$MATRIX_INSTALL_TMPDIR" bash "$INSTALLER" "$@" >"$LOGDIR/install.log" 2>&1 || install_status=$?
else
    bash "$INSTALLER" "$@" >"$LOGDIR/install.log" 2>&1 || install_status=$?
fi
decolour < "$LOGDIR/install.log"
echo "=== installer exit: $install_status ==="

if [ "$install_status" = "0" ]; then
    say installer pass "exit 0"
else
    # The last error line is what the user would actually read.
    last=$(decolour < "$LOGDIR/install.log" | grep -iE '^(error|warning)|not installed|does not run|failed' | tail -1)
    say installer fail "exit $install_status: ${last:-see install.log}"
fi

# --------------------------------------------------------------------- onpath --

# "Does a new shell find it" is the question behind `rafikicode: command not
# found` after a successful install, so ask a fresh login shell rather than
# looking at this one, whose PATH the installer cannot have changed.
# Two shells, because they read different files and the installer's promise is
# about only one of them. An interactive shell reads ~/.bashrc, which is where
# the PATH line is written; a login shell that is not interactive reads
# ~/.profile, and on Debian and Ubuntu ~/.bashrc returns early before the line
# is reached. The second is how ssh, cron and CI run a command, so a pass on the
# first and a fail on the second is a real difference, not a quibble.
interactive=$(bash -ic 'command -v rafikicode' 2>/dev/null | tr -d '\r' | tail -1)
login=$(bash -lc 'command -v rafikicode' 2>/dev/null | tr -d '\r' | tail -1)
installed="${RAFIKICODE_INSTALL_DIR:-${HOME:-/nonexistent}/.rafikicode/bin}/rafikicode"

if [ -n "$interactive" ]; then
    say onpath pass "$interactive"
elif [ -x "$installed" ]; then
    say onpath fail "installed at $installed but a new interactive terminal does not find it by name"
else
    say onpath fail "no rafikicode on PATH and nothing at $installed"
fi

if [ -n "$login" ]; then
    say loginpath pass "$login"
elif [ -x "$installed" ]; then
    say loginpath fail "installed at $installed but a login shell (ssh, cron, CI) does not find it by name"
else
    say loginpath fail "no rafikicode on PATH and nothing at $installed"
fi

BIN="${interactive:-${login:-$installed}}"
if [ ! -x "$BIN" ]; then
    for f in version doctor tui; do say "$f" skip "no binary to run"; done
    exit 0
fi

# -------------------------------------------------------------------- version --

out=$("$BIN" --version 2>&1); status=$?
if [ "$status" = "0" ] && [ -n "$out" ]; then
    got=$(printf '%s' "$out" | tr -d '\r' | head -1)
    if [ -z "$VERSION" ] || [ "$got" = "$VERSION" ]; then
        say version pass "$got"
    else
        say version fail "printed $got, installed $VERSION"
    fi
else
    say version fail "exit $status: $out"
fi

# --------------------------------------------------------------------- doctor --

# doctor exits non-zero when a check fails, and with no credential one always
# does, so the exit code cannot be the test. What is being measured is that it
# ran its checks instead of crashing.
out=$("$BIN" doctor 2>&1); status=$?
clean=$(printf '%s' "$out" | decolour)
if [ "$status" -ge 126 ] || [ -z "$clean" ]; then
    say doctor fail "exit $status: ${clean:-no output}"
elif printf '%s' "$clean" | grep -qiE 'Unexpected error|Failed to initialize|failed to map segment'; then
    say doctor fail "crashed: $(printf '%s' "$clean" | grep -iE 'Unexpected error|Failed to initialize|failed to map segment' | head -1)"
elif printf '%s' "$clean" | grep -qE 'gateway|config'; then
    say doctor pass "ran its checks (exit $status)"
else
    say doctor fail "exit $status, no check output: $(printf '%s' "$clean" | head -1)"
fi

# ------------------------------------------------------------------------ tui --

# The facet that matters and the one nothing else reaches. --version and doctor
# never load the native render library; the terminal interface unpacks it into
# the temporary directory and dlopens it from there, so this is the only facet a
# noexec temporary directory fails.
#
# Two things are needed to get that far: a terminal, and a credential, because
# without one the command stops at the sign in notice before any rendering. The
# key is deliberately not a real one -- the renderer starts before it is used.
if [ ! -t 1 ]; then
    say tui skip "no terminal on stdout; the interface is not started without one"
    exit 0
fi
if ! command -v timeout >/dev/null 2>&1; then
    say tui skip "timeout is not installed, cannot bound the run"
    exit 0
fi

# stdout is left on the terminal, because redirecting it to a file is itself
# enough to stop the interface starting, and then every cell would pass this
# facet for the wrong reason. stderr goes to a file instead: that is where the
# render library failure is reported, and capturing it costs nothing.
echo "=== tui: ${TUI_WAIT}s with a terminal and a credential ==="
tui_started=$(date +%s)
# --foreground matters more than it looks. Without it GNU timeout runs the
# command in a new process group, which is then not the terminal's foreground
# group, so a full screen interface cannot take control of the terminal and
# simply never draws -- on a perfectly healthy machine. That turns every cell of
# this column into a fail, or, if the test were only "did it stay up", into a
# pass with nothing on the screen. BusyBox timeout has no such flag and needs
# none, because it does not change the process group.
fg=""
if timeout --foreground 1 true 2>/dev/null; then fg="--foreground"; fi
RAFIKICODE_API_KEY="${MATRIX_FAKE_KEY:-rk_install_matrix_not_a_real_key}" \
    timeout $fg -s INT -k 5 "$TUI_WAIT" "$BIN" 2>"$LOGDIR/tui.err"
tui_status=$?
tui_elapsed=$(( $(date +%s) - tui_started ))
clean=$(decolour < "$LOGDIR/tui.err")
printf '\n=== tui exit %s after %ss; stderr follows ===\n%s\n' "$tui_status" "$tui_elapsed" "$clean"

# Most specific cause first: the wrapper line "Unexpected error" is printed
# above the line that actually says what went wrong, and reporting the wrapper
# would hide it.
crash=""
for pattern in 'failed to map segment' 'Error loading shared library' 'Error relocating' 'Illegal instruction' 'Failed to initialize' 'Unexpected error'; do
    crash=$(printf '%s' "$clean" | grep -i "$pattern" | head -1)
    [ -n "$crash" ] && break
done
if [ -n "$crash" ]; then
    say tui fail "$crash"
elif [ "$tui_elapsed" -ge "$TUI_WAIT" ]; then
    # Still drawing when the clock ran out. Time is the test rather than the exit
    # status: a terminal interface may well choose to ignore the interrupt, and
    # then the status says only who gave up first.
    say tui pass "started and stayed up for ${tui_elapsed}s"
elif [ "$tui_status" = "132" ] || [ "$tui_status" = "4" ]; then
    say tui fail "illegal instruction after ${tui_elapsed}s: the binary needs CPU instructions this machine does not have"
else
    say tui fail "exited after ${tui_elapsed}s with $tui_status: $(printf '%s' "$clean" | grep -v '^[[:space:]]*$' | head -1)"
fi
