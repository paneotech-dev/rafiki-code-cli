#!/usr/bin/env bash
# Checks what install/install.sh does when it is not run by bash.
#
# `curl -fsSL <url> | sh` is a common habit, and install.sh is a bash script: it
# uses [[ ]], arrays and local. Run under sh it used to die on its own `set` line
# with "set: Illegal option -o pipefail", a message that names a line number and
# tells the person nothing. This suite pins the two things that replaced it: the
# script re-runs itself under bash when it can, and says exactly what to type when
# it cannot.
#
# Two invocations behave differently and both matter:
#   sh ./install.sh   - the script is a file, so it can be re-run with bash
#   ... | sh          - the script arrived on stdin, so nothing can be salvaged
# No network and no mock server: --help exits before either is needed, which is
# all these cases require.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
INSTALLER="$HERE/install.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/rafikicode-shell-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
check() {
    if [ "$1" = "0" ]; then pass=$((pass + 1)); echo "ok   $2"; else fail=$((fail + 1)); echo "FAIL $2"; fi
}
skip() { echo "skip $1"; }

# The prologue is the part that has to parse under every shell: everything from
# the top of the file down to the `set -euo pipefail` that ends the guard. Check
# it on its own, because the rest of the file is bash on purpose and would fail a
# POSIX parse for reasons that are not bugs.
sed -n '1,/^set -euo pipefail$/p' "$INSTALLER" > "$WORK/prologue.sh"
for posix_sh in dash "busybox sh"; do
    bin=${posix_sh%% *}
    command -v "$bin" >/dev/null 2>&1 || { skip "parse the prologue with $posix_sh (not installed)"; continue; }
    $posix_sh -n "$WORK/prologue.sh" 2>"$WORK/parse.err"
    [ "$?" = "0" ] && [ ! -s "$WORK/parse.err" ]; check $? "the prologue parses as POSIX under $posix_sh"
done

# bash is unaffected: the guard is invisible to it.
out=$(bash "$INSTALLER" --help 2>&1) && rc=0 || rc=$?
[ "$rc" = "0" ] && [[ "$out" == *"Rafiki Code installer"* ]]; check $? "bash runs the installer as before"

for posix_sh in dash "busybox sh" "busybox ash"; do
    bin=${posix_sh%% *}
    command -v "$bin" >/dev/null 2>&1 || { skip "$posix_sh (not installed)"; continue; }

    # As a file: the script is still on disk, so it re-runs itself with bash and
    # the user never sees a problem at all.
    out=$($posix_sh "$INSTALLER" --help 2>&1) && rc=0 || rc=$?
    [ "$rc" = "0" ] \
        && [[ "$out" == *"Rafiki Code installer"* ]] \
        && [[ "$out" != *"Illegal option"* ]] \
        && [[ "$out" != *"syntax error"* ]]; check $? "$posix_sh ./install.sh re-runs itself under bash and works"

    # Piped: there is no file to re-run, so it must say what to type instead. The
    # old failure mode is asserted against explicitly, in both its spellings.
    out=$(cat "$INSTALLER" | $posix_sh 2>&1) && rc=0 || rc=$?
    [ "$rc" != "0" ] \
        && [[ "$out" == *"needs bash, and this is sh"* ]] \
        && [[ "$out" == *"curl -fsSL https://get.rafikiai.io | bash"* ]] \
        && [[ "$out" != *"Illegal option"* ]] \
        && [[ "$out" != *"syntax error"* ]] \
        && [[ "$out" != *"unexpected"* ]]; check $? "install.sh | $posix_sh says to use bash instead of failing on line 6"
done

# Piped into sh on a machine with no bash at all. Telling someone to use bash
# when they have not got it would be the same dead end in a new costume, so this
# has to name the package manager and the package.
nobash="$WORK/nobash"
mkdir -p "$nobash"
for tool in sed awk head grep cat id; do
    real=$(command -v "$tool" 2>/dev/null) && ln -sf "$real" "$nobash/$tool"
done
# A package manager that only has to exist to be found: it is probed for, never
# run. Written directly, never over a symlink, so nothing outside $WORK is touched.
printf '#!/bin/sh\nexit 0\n' > "$nobash/apt-get"
chmod 755 "$nobash/apt-get"
if command -v dash >/dev/null 2>&1; then
    out=$(cat "$INSTALLER" | env -i PATH="$nobash" HOME="$WORK" "$(command -v dash)" 2>&1) && rc=0 || rc=$?
    [ "$rc" != "0" ] \
        && [[ "$out" == *"bash is not installed here either"* ]] \
        && [[ "$out" == *"apt-get install -y bash"* ]]; check $? "with no bash, sh is told how to install bash for this machine"
else
    skip "no bash available case (dash not installed)"
fi

echo "shell tests: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ]
