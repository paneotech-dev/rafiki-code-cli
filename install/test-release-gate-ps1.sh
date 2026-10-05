#!/usr/bin/env bash
# Checks the parts of install/release-gate.ps1 that can run off Windows, under
# PowerShell 7 on Linux: that the script parses, and that a gate which cannot
# start says why where it can be read without the job log, as a workflow
# annotation (::error) and in the job's step summary, on a runner only. The
# install, version and licence facets start powershell.exe and a Windows
# binary, so they are exercised by the release workflow's Windows jobs and by
# nothing here.
#
# Needs pwsh on PATH, or docker with the image named in PWSH_IMAGE (default
# mcr.microsoft.com/powershell:lts-ubuntu-22.04) already pulled. Without
# either it says so and exits 0.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=${PWSH_IMAGE:-mcr.microsoft.com/powershell:lts-ubuntu-22.04}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/rafikicode-gate-ps1.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
unset GITHUB_ACTIONS GITHUB_STEP_SUMMARY RAFIKICODE_STAGING_API_KEY

if command -v pwsh >/dev/null 2>&1; then
    runner=local
elif command -v docker >/dev/null 2>&1 && docker image inspect "$IMAGE" >/dev/null 2>&1; then
    runner=docker
else
    echo "skip: neither pwsh nor the $IMAGE image is available"
    exit 0
fi

mkdir -p "$WORK/assets-empty" "$WORK/assets-sums"
: > "$WORK/assets-sums/SHA256SUMS"
chmod -R a+rwX "$WORK"

# run_ps <on runner: yes|no> <key or ""> <arguments of release-gate.ps1...>
# Paths inside the arguments are relative to the work directory.
run_ps() {
    local on=$1 key=$2; shift 2
    local -a env=()
    : > "$WORK/summary.md"; chmod a+rw "$WORK/summary.md"
    if [ "$runner" = "docker" ]; then
        [ "$on" = "yes" ] && env+=(-e GITHUB_ACTIONS=true -e GITHUB_STEP_SUMMARY=/work/summary.md)
        [ -n "$key" ] && env+=(-e "RAFIKICODE_STAGING_API_KEY=$key")
        docker run --rm ${env[@]+"${env[@]}"} -v "$HERE:/gate:ro" -v "$WORK:/work" -w /work "$IMAGE" \
            pwsh -NoProfile -File /gate/release-gate.ps1 "$@" 2>&1
    else
        [ "$on" = "yes" ] && env+=(GITHUB_ACTIONS=true "GITHUB_STEP_SUMMARY=$WORK/summary.md")
        [ -n "$key" ] && env+=("RAFIKICODE_STAGING_API_KEY=$key")
        (cd "$WORK" && env ${env[@]+"${env[@]}"} pwsh -NoProfile -File "$HERE/release-gate.ps1" "$@" 2>&1)
    fi
}

set +e
pass=0
fail=0
check() {
    if [ "$1" = "0" ]; then pass=$((pass + 1)); echo "ok   $2"; else fail=$((fail + 1)); echo "FAIL $2"; fi
}

cat > "$WORK/parse.ps1" <<'PS'
$tokens = $null; $errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$tokens, [ref]$errors)
$errors | ForEach-Object { "$_" }
exit $errors.Count
PS
if [ "$runner" = "docker" ]; then
    out=$(docker run --rm -v "$HERE:/gate:ro" -v "$WORK:/work:ro" "$IMAGE" pwsh -NoProfile -File /work/parse.ps1 /gate/release-gate.ps1 2>&1); rc=$?
else
    out=$(pwsh -NoProfile -File "$WORK/parse.ps1" "$HERE/release-gate.ps1" 2>&1); rc=$?
fi
[ "$rc" = "0" ]; check $? "release-gate.ps1 parses (${out:-no errors})"

out=$(run_ps yes "" -Target solaris-sparc -Version 1.4.0 -Assets assets-empty); rc=$?
[ "$rc" = "2" ] && [[ "$out" == *"::error title=release gate solaris-sparc (installer)%3A not run::solaris-sparc is not a Windows build this product publishes"* ]] \
    && grep -q "release gate solaris-sparc (installer): not run" "$WORK/summary.md"; check $? "a target that is not a Windows build: exit 2, an annotation and a summary line"

out=$(run_ps yes "" -Target windows-x64 -Version 1.4.0 -Assets assets-empty); rc=$?
[ "$rc" = "2" ] && [[ "$out" == *"::error title=release gate windows-x64 (installer)%3A not run::RAFIKICODE_STAGING_API_KEY is not set"* ]] \
    && grep -q "RAFIKICODE_STAGING_API_KEY is not set" "$WORK/summary.md"; check $? "a missing credential is annotated by name"

out=$(run_ps yes "" -Target windows-x64 -Version 1.4.0 -Assets assets-empty -NoLive); rc=$?
[ "$rc" = "2" ] && [[ "$out" == *"%3A not run::-NoLive is for a pre-release only"* ]]; check $? "-NoLive for a full release is refused, with an annotation"

out=$(run_ps yes "rk_gate_test_not_a_real_key" -Target windows-x64 -Version 1.4.0-rc.1 -Assets assets-empty -NoLive); rc=$?
[ "$rc" = "2" ] && [[ "$out" == *"%3A not run::-NoLive was given while RAFIKICODE_STAGING_API_KEY is set"* ]] \
    && [[ "$out" != *"rk_gate_test_not_a_real_key"* ]]; check $? "-NoLive with a key set is refused, and the key is not printed"

out=$(run_ps yes "" -Target windows-arm64 -Version 1.4.0-rc.1 -Assets assets-empty -NoLive); rc=$?
[ "$rc" = "2" ] && [[ "$out" == *"::error title=release gate windows-arm64 (installer)%3A not run::no SHA256SUMS in assets-empty"* ]]; check $? "assets without SHA256SUMS: the reason is an annotation"

out=$(run_ps yes "" -Target windows-x64 -Version 1.4.0-rc.1 -Assets assets-sums -NoLive); rc=$?
[ "$rc" = "2" ] && [[ "$out" == *"%3A not run::no rafikicode-windows-x64.zip in assets-sums: the build for windows-x64 was not produced"* ]]; check $? "a release with no archive for the target: the reason is an annotation"

out=$(run_ps no "" -Target windows-x64 -Version 1.4.0-rc.1 -Assets assets-sums -NoLive); rc=$?
[ "$rc" = "2" ] && [[ "$out" == *"was not produced"* ]] && [[ "$out" != *"::error"* ]] && [ ! -s "$WORK/summary.md" ]; check $? "off a runner there is no annotation and no summary"

echo "release gate (PowerShell) tests: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ]
