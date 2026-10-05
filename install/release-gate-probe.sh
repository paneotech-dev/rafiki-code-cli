#!/bin/sh
# Runs inside one release gate container, or directly on a fresh macOS runner.
# Installs one published build the way a user does, then answers five questions
# about it, one line each:
#
#   GATE_RESULT <facet> <pass|fail> <detail>
#
# and, when something is worth telling without being a verdict (the binary
# wrote to standard error while printing its version, for example):
#
#   GATE_NOTE <facet> <text>
#
#   install  the documented install command ran to completion
#   version  --version prints the version being released
#   licence  the licence and the notice arrived with the binary
#   signin   the staging test credential is accepted and names an account
#   task     one hello world task ran against staging and answered
#
# Every facet is reported, and a facet that could not be reached is a fail, not
# a skip: this is what decides whether a build is published. The one exception
# is GATE_LIVE=0, which release-gate.sh sets only when it was given --no-live
# for a pre-release without the staging key: signin and task are then reported
# as skipped, and the gate accepts that verdict for those two facets only.
#
# Plain POSIX sh: it has to run under Alpine's ash before bash exists there.
#
# Input, all through the environment:
#   GATE_TARGET     the build to install, for example linux-x64-baseline
#   GATE_VERSION    the version being released
#   GATE_MIRROR     http://127.0.0.1:<port> serving install.sh, api/ and dl/
#   GATE_CHANNEL    installer (default) or npm
#   GATE_NPM_TARBALL  the packed npm package, for the npm channel
#   RAFIKICODE_API_KEY  the staging test credential
#   RAFIKICODE_GATEWAY_URL, RAFIKICODE_CONSOLE_URL  staging endpoints, when
#                   they are not the product defaults
#   GATE_PROMPT, GATE_EXPECT  the task and the text its answer must contain
#   GATE_TASK_TIMEOUT  seconds the task may take (default 180)
#   GATE_LIVE       0 to skip the two facets that call staging (signin, task)

TARGET=${GATE_TARGET:?GATE_TARGET is required}
VERSION=${GATE_VERSION:?GATE_VERSION is required}
MIRROR=${GATE_MIRROR:?GATE_MIRROR is required}
CHANNEL=${GATE_CHANNEL:-installer}
PROMPT=${GATE_PROMPT:-Reply with exactly these two words and nothing else: hello world}
EXPECT=${GATE_EXPECT:-hello world}
TASK_TIMEOUT=${GATE_TASK_TIMEOUT:-180}
LIVE=${GATE_LIVE:-1}

ESC=$(printf '\033')
decolour() { sed -e "s/${ESC}\\[[0-9;?]*[a-zA-Z]//g" | tr -d '\r'; }
say() {
    detail=$(printf '%s' "$3" | tr '\n\t' '  ' | decolour | cut -c1-400)
    printf 'GATE_RESULT %s %s %s\n' "$1" "$2" "$detail"
}
note() {
    text=$(printf '%s' "$2" | tr '\n\t' '  ' | decolour | cut -c1-400)
    printf 'GATE_NOTE %s %s\n' "$1" "$text"
}
rest_fail() {
    reason=$1; shift
    for f in "$@"; do say "$f" fail "$reason"; done
}
# A scratch file, in the temporary folder when mktemp works and in the home
# folder when it does not.
scratch() { mktemp 2>/dev/null || echo "${HOME}/.gate-$1"; }

echo "=== gate probe: ${TARGET} ${VERSION} via ${CHANNEL} ==="
echo "whoami: $(id -un 2>/dev/null || id -u)   home: ${HOME-<unset>}   arch: $(uname -m) ($(uname -s))"
# What the machine looked like, for whoever reads this log after a failure.
echo "folder: $(pwd 2>/dev/null)   TMPDIR: ${TMPDIR-<unset>}   bash: $(bash -c 'echo $BASH_VERSION' 2>/dev/null || echo none)"
df -Pk "${TMPDIR:-/tmp}" "${HOME:-/}" 2>/dev/null | sed 's/^/df: /'

# The key must never appear in the log. The installer is run without it, so
# that it behaves as it does for someone installing before they have a key.
KEY=${RAFIKICODE_API_KEY:-}
unset RAFIKICODE_API_KEY

# -------------------------------------------------------------------- install --

BIN=""
status=0
case "$CHANNEL" in
    installer)
        if ! command -v bash >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
            say install fail "bash and curl are needed for the documented install command and one is missing"
            rest_fail "nothing was installed" version licence signin task
            exit 0
        fi
        # The documented one line install, pointed at the mirror of the assets
        # about to be published. No --version: the installer resolves the
        # latest release itself, as it does for a user.
        echo "=== curl -fsSL ${MIRROR}/install.sh | bash -s -- --target ${TARGET} --no-login --allow-http-loopback ==="
        # POSIX sh has no pipefail, and the last command of this pipeline only
        # strips colours, so the installer's own status goes through a file.
        statusfile=$(scratch install-status)
        installlog=$(scratch install-log)
        {
            curl -fsSL "${MIRROR}/install.sh" \
                | RAFIKICODE_RELEASE_API="${MIRROR}/api" RAFIKICODE_RELEASE_BASE="${MIRROR}/dl" \
                  bash -s -- --target "$TARGET" --no-login --allow-http-loopback
            echo $? > "$statusfile"
        } 2>&1 | decolour | tee "$installlog"
        status=$(cat "$statusfile" 2>/dev/null || echo 1)
        rm -f "$statusfile"
        BIN="${HOME}/.rafikicode/bin/rafikicode"
        ;;
    npm)
        if ! command -v npm >/dev/null 2>&1; then
            say install fail "npm is not installed in this image"
            rest_fail "nothing was installed" version licence signin task
            exit 0
        fi
        echo "=== npm install -g ${GATE_NPM_TARBALL:-<no tarball>} ==="
        installlog=$(scratch install-log)
        RAFIKICODE_RELEASE_BASE="${MIRROR}/dl" RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK=1 \
            RAFIKICODE_INSTALL_TARGET="$TARGET" \
            npm install -g "${GATE_NPM_TARBALL:?GATE_NPM_TARBALL is required for the npm channel}" > "$installlog" 2>&1
        status=$?
        cat "$installlog"
        BIN="$(npm prefix -g 2>/dev/null)/bin/rafikicode"
        ;;
    *)
        say install fail "unknown channel ${CHANNEL}"
        rest_fail "nothing was installed" version licence signin task
        exit 0
        ;;
esac

# What the install said was wrong, in its own words: its first "Error:" line,
# or its last line when it named none. The verdict carries it, because the
# verdict is what reaches the workflow annotations and the log does not.
install_reason() {
    reason=$(grep -a -i -m 1 -e '^error:' -e '^npm err' "$installlog" 2>/dev/null)
    [ -n "$reason" ] || reason=$(grep -a -v '^[[:space:]]*$' "$installlog" 2>/dev/null | tail -1)
    # What the binary itself said, when the installer quotes it.
    quoted=$(grep -a -m 1 '^  it said:' "$installlog" 2>/dev/null | sed 's/^ *//')
    # The home folder is a long temporary path here; the reason reads better without it.
    printf '%s%s' "${reason:-it printed nothing}" "${quoted:+ ($quoted)}" | sed "s|${HOME:-/nonexistent}|~|g"
}
# The installer's closing check, when it found the install not ready: the build
# is installed all the same, so this is a note and the facets below decide.
if grep -a -q 'Installed, but not ready' "${installlog:-/nonexistent}" 2>/dev/null; then
    note install "$(grep -a 'Installed, but not ready' "$installlog" | head -1)"
fi
if [ "$status" != "0" ] || [ ! -x "$BIN" ]; then
    elsewhere=""
    if [ "$status" = "0" ]; then
        # Exit 0 with nothing at the expected path: say where it went instead.
        elsewhere=$(grep -a -m 1 -e 'is installed into' -e 'Installed .* at ' "$installlog" 2>/dev/null)
    fi
    say install fail "the install command exited ${status} and ~/.rafikicode/bin/rafikicode is $([ -x "$BIN" ] && echo present || echo missing): ${elsewhere:-$(install_reason)}"
    rest_fail "nothing was installed" version licence signin task
    rm -f "$installlog"
    exit 0
fi
rm -f "$installlog"
say install pass "$BIN"

# The npm launcher downloads on first use when scripts were skipped; keep the
# mirror settings for it. They are release locations, not credentials.
if [ "$CHANNEL" = "npm" ]; then
    RAFIKICODE_RELEASE_BASE="${MIRROR}/dl"; RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK=1
    export RAFIKICODE_RELEASE_BASE RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK
fi
# The build under test must not go looking for another one.
RAFIKICODE_DISABLE_AUTOUPDATE=1; export RAFIKICODE_DISABLE_AUTOUPDATE

# -------------------------------------------------------------------- version --

# Standard output is the answer and must be the version alone, on one line:
# installers, update checks and scripts compare it. Standard error is kept
# apart and reported as a note, so a line the binary says about this machine (a
# folder it had to replace, for example) neither passes for the version nor
# hides it.
errfile=$(scratch version-stderr)
out=$("$BIN" --version 2>"$errfile"); status=$?
said=$(decolour < "$errfile" 2>/dev/null | grep -v '^[[:space:]]*$')
rm -f "$errfile"
got=$(printf '%s' "$out" | decolour | head -1)
count=$(printf '%s\n' "$out" | decolour | grep -c -v '^[[:space:]]*$')
if [ -n "$said" ]; then
    echo "=== --version wrote to standard error ==="
    printf '%s\n' "$said"
    note version "--version wrote to standard error: $(printf '%s' "$said" | head -3)"
fi
if [ "$status" = "0" ] && [ "$got" = "$VERSION" ] && [ "$count" = "1" ]; then
    say version pass "$got"
elif [ "$status" = "0" ] && [ "$got" = "$VERSION" ]; then
    say version fail "standard output has ${count} lines where the version alone belongs: $(printf '%s' "$out" | decolour | sed -n '2p')"
else
    say version fail "exit ${status}, printed '${got}' on standard output, releasing ${VERSION}${said:+; standard error: $(printf '%s' "$said" | head -1)}"
fi

# -------------------------------------------------------------------- licence --

out=$("$BIN" licenses 2>&1); status=$?
problem=""
if [ "$status" != "0" ]; then
    problem="rafikicode licenses exited ${status}: $(printf '%s' "$out" | decolour | grep -v '^[[:space:]]*$' | tail -1)"
elif ! printf '%s' "$out" | grep -q "Permission is hereby granted"; then
    problem="rafikicode licenses did not print the licence text"
fi
if [ -z "$problem" ]; then
    case "$CHANNEL" in
        installer) files="${HOME}/.rafikicode/licenses" ;;
        npm) files="$(npm root -g 2>/dev/null)/rafikicode" ;;
    esac
    for name in LICENSE NOTICE; do
        [ -s "${files}/${name}" ] || problem="${files}/${name} was not installed"
    done
fi
if [ -z "$problem" ]; then say licence pass "printed by the binary, and LICENSE and NOTICE are in ${files}"; else say licence fail "$problem"; fi

# --------------------------------------------------------------------- signin --

if [ "$LIVE" = "0" ]; then
    say signin skipped "no staging key, pre-release: whoami against staging was not run"
    say task skipped "no staging key, pre-release: no task was sent to staging"
    exit 0
fi
if [ -z "$KEY" ]; then
    say signin fail "no staging test credential: the secret RAFIKICODE_STAGING_API_KEY is not set"
    say task fail "no staging test credential: the secret RAFIKICODE_STAGING_API_KEY is not set"
    exit 0
fi
RAFIKICODE_API_KEY=$KEY; export RAFIKICODE_API_KEY

out=$("$BIN" whoami 2>&1); status=$?
clean=$(printf '%s' "$out" | decolour)
if [ "$status" != "0" ]; then
    say signin fail "whoami exited ${status}: $(printf '%s' "$clean" | tail -1)"
elif printf '%s' "$clean" | grep -q "Could not load the account"; then
    say signin fail "the credential was not checked: $(printf '%s' "$clean" | grep 'Could not load the account' | head -1)"
elif printf '%s' "$clean" | grep -q "^Account:"; then
    say signin pass "$(printf '%s' "$clean" | grep '^Account:' | head -1)"
else
    say signin fail "whoami named no account: $(printf '%s' "$clean" | tail -1)"
fi

# ----------------------------------------------------------------------- task --

# One headless task in an empty directory. stdin is closed so that run does not
# wait for input, and a watchdog ends a task that never answers: neither
# timeout(1) nor a way to bound a command exists on every platform this runs on.
workdir=$(mktemp -d 2>/dev/null || echo "${HOME}/gate-task")
mkdir -p "$workdir"
(
    cd "$workdir" || exit 1
    "$BIN" run "$PROMPT" < /dev/null > "$workdir/out.txt" 2> "$workdir/err.txt" &
    pid=$!
    ( sleep "$TASK_TIMEOUT"; kill "$pid" 2>/dev/null ) &
    watchdog=$!
    wait "$pid"; status=$?
    kill "$watchdog" 2>/dev/null
    exit "$status"
)
status=$?
answer=$(decolour < "$workdir/out.txt" 2>/dev/null)
errors=$(decolour < "$workdir/err.txt" 2>/dev/null)
echo "=== task exit ${status}; answer follows ==="
printf '%s\n' "$answer" | tail -20
echo "=== task stderr (last lines) ==="
printf '%s\n' "$errors" | tail -20
if [ "$status" = "0" ] && printf '%s' "$answer" | grep -qi -- "$EXPECT"; then
    say task pass "answered with '${EXPECT}'"
elif [ "$status" = "0" ]; then
    say task fail "exit 0 but the answer does not contain '${EXPECT}': $(printf '%s' "$answer" | grep -v '^[[:space:]]*$' | tail -1)"
else
    say task fail "exit ${status}: $(printf '%s\n%s' "$errors" "$answer" | grep -v '^[[:space:]]*$' | tail -1)"
fi
rm -rf "$workdir"
