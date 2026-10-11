#!/usr/bin/env bash
# Exercises install/release-channels.sh, the part of the release workflow that
# decides which channels a run publishes, and the shape of
# .github/workflows/release.yml that depends on it. No network, no secrets.
#
# What is under test: a full release needs the staging key and nothing else;
# each missing package manager token is a warning naming it and turns that
# channel off, never the release; a pre-release needs no secret and publishes
# no package manager; the release notes section says which channels were
# published and which were skipped, and replacing it is idempotent; and in the
# workflow, the GitHub release never reads the three tokens while each channel
# job runs only when its token is set.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/release-channels.sh"
WORKFLOW="$HERE/../.github/workflows/release.yml"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/rafikicode-channels-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
unset GITHUB_ACTIONS GITHUB_OUTPUT GITHUB_STEP_SUMMARY RAFIKICODE_STAGING_API_KEY NPM_TOKEN HOMEBREW_TAP_TOKEN WINGET_TOKEN

set +e
pass=0
fail=0
check() {
    if [ "$1" = "0" ]; then pass=$((pass + 1)); echo "ok   $2"; else fail=$((fail + 1)); echo "FAIL $2"; fi
}

# run_preflight <prerelease> [NAME=value...]: sets $out, $rc, and the files
# $WORK/output and $WORK/summary.
run_preflight() {
    local prerelease=$1; shift
    : > "$WORK/output"; : > "$WORK/summary"
    out=$(env "$@" PRERELEASE="$prerelease" GITHUB_OUTPUT="$WORK/output" GITHUB_STEP_SUMMARY="$WORK/summary" bash "$SCRIPT" preflight 2>&1); rc=$?
}

# ---------------------------------------------------------------- preflight --

run_preflight false RAFIKICODE_STAGING_API_KEY=k NPM_TOKEN=n HOMEBREW_TAP_TOKEN=h WINGET_TOKEN=w
[ "$rc" = "0" ] && grep -qx "live_gate=true" "$WORK/output" && grep -qx "npm=true" "$WORK/output" \
    && grep -qx "homebrew=true" "$WORK/output" && grep -qx "winget=true" "$WORK/output" && [[ "$out" != *"::warning"* ]]
check $? "a full release with every secret publishes every channel, without a warning"

run_preflight false RAFIKICODE_STAGING_API_KEY=k
[ "$rc" = "0" ] && grep -qx "npm=false" "$WORK/output" && grep -qx "homebrew=false" "$WORK/output" && grep -qx "winget=false" "$WORK/output" \
    && grep -qx "live_gate=true" "$WORK/output"
check $? "a full release needs only the staging key: without the three tokens it still runs"

[[ "$out" == *"::warning title=npm skipped::The repository secret NPM_TOKEN is not set"* ]] \
    && [[ "$out" == *"::warning title=Homebrew skipped::The repository secret HOMEBREW_TAP_TOKEN is not set"* ]] \
    && [[ "$out" == *"::warning title=winget skipped::The repository secret WINGET_TOKEN is not set"* ]] \
    && [[ "$out" != *"::error"* ]]
check $? "each missing token is a warning that names the secret, not an error"

grep -q "Package managers skipped: npm (NPM_TOKEN not set), Homebrew (HOMEBREW_TAP_TOKEN not set), winget (WINGET_TOKEN not set)" "$WORK/summary" \
    && grep -q "GitHub release, install.sh, install.ps1 and get.rafikiai.io: published by this run" "$WORK/summary"
check $? "the run summary names the channels published and skipped"

run_preflight false RAFIKICODE_STAGING_API_KEY=k HOMEBREW_TAP_TOKEN=h
[ "$rc" = "0" ] && grep -qx "npm=false" "$WORK/output" && grep -qx "homebrew=true" "$WORK/output" && grep -qx "winget=false" "$WORK/output" \
    && [[ "$out" != *"HOMEBREW_TAP_TOKEN is not set"* ]] && grep -q "published after the GitHub release: Homebrew\." "$WORK/summary"
check $? "each token turns on its own channel only"

run_preflight false NPM_TOKEN=n HOMEBREW_TAP_TOKEN=h WINGET_TOKEN=w
[ "$rc" = "1" ] && [[ "$out" == *"::error title=release::The repository secret RAFIKICODE_STAGING_API_KEY is not set"* ]] \
    && grep -q "Release not started" "$WORK/summary" && ! grep -q "npm=" "$WORK/output"
check $? "a full release without the staging key stops, naming it, even with every other token"

run_preflight false RAFIKICODE_STAGING_API_KEY=
[ "$rc" = "1" ]
check $? "an empty staging key is a missing staging key"

run_preflight true
[ "$rc" = "0" ] && grep -qx "live_gate=false" "$WORK/output" && grep -qx "npm=false" "$WORK/output" \
    && grep -qx "homebrew=false" "$WORK/output" && grep -qx "winget=false" "$WORK/output" \
    && [[ "$out" == *"Pre-release without the staging key"* ]] && [[ "$out" != *"NPM_TOKEN"* ]]
check $? "a pre-release needs no secret, skips only the live checks and asks for no token"

run_preflight true RAFIKICODE_STAGING_API_KEY=k NPM_TOKEN=n HOMEBREW_TAP_TOKEN=h WINGET_TOKEN=w
[ "$rc" = "0" ] && grep -qx "live_gate=true" "$WORK/output" && grep -qx "npm=false" "$WORK/output" && grep -qx "winget=false" "$WORK/output"
check $? "a pre-release goes to no package manager, even with every token"

run_preflight maybe RAFIKICODE_STAGING_API_KEY=k
[ "$rc" = "1" ]
check $? "a PRERELEASE that is neither true nor false is refused"

out=$(RAFIKICODE_STAGING_API_KEY=secret-value NPM_TOKEN=npm-secret PRERELEASE=false GITHUB_OUTPUT="$WORK/output" GITHUB_STEP_SUMMARY="$WORK/summary" bash "$SCRIPT" preflight 2>&1)
! printf '%s' "$out" | grep -q "secret-value\|npm-secret" && ! grep -q "secret-value\|npm-secret" "$WORK/output" "$WORK/summary"
check $? "no secret value is printed or written"

# ------------------------------------------------------------------ section --

section() { env "$@" bash "$SCRIPT" section; }

text=$(section NPM_ENABLED=false HOMEBREW_ENABLED=false WINGET_ENABLED=false)
[[ "$text" == *'- npm (`rafikicode`): skipped. The repository secret `NPM_TOKEN` is not set'* ]] \
    && [[ "$text" == *'- Homebrew (`paneotech-dev/tap/rafikicode`): skipped. The repository secret `HOMEBREW_TAP_TOKEN` is not set'* ]] \
    && [[ "$text" == *'- winget (`PaneoTech.RafikiCode`): skipped. The repository secret `WINGET_TOKEN` is not set'* ]] \
    && [[ "$text" == *"The GitHub release, the installer scripts and get.rafikiai.io serve this version."* ]]
check $? "the notes name every skipped channel and its secret"

text=$(section NPM_ENABLED=true HOMEBREW_ENABLED=true WINGET_ENABLED=true)
[ "$(printf '%s\n' "$text" | grep -c "being published by the release run")" = "3" ]
check $? "before the channel jobs end, the notes say they are being published"

text=$(section NPM_ENABLED=true HOMEBREW_ENABLED=true WINGET_ENABLED=true NPM_RESULT=success HOMEBREW_RESULT=success HOMEBREW_VERIFY_RESULT=success WINGET_RESULT=success)
[[ "$text" == *'- npm (`rafikicode`): published.'* ]] && [[ "$text" == *"brew install\` of it was checked on macOS"* ]] \
    && [[ "$text" == *"winget"*"submitted. The pull request on"* ]] && [[ "$text" != *"skipped"* ]]
check $? "published channels read as published"

text=$(section NPM_ENABLED=true HOMEBREW_ENABLED=true WINGET_ENABLED=false NPM_RESULT=failure HOMEBREW_RESULT=success HOMEBREW_VERIFY_RESULT=failure WINGET_RESULT=skipped)
[[ "$text" == *'npm (`rafikicode`): not published: the job ended `failure`'* ]] \
    && [[ "$text" == *'install check on macOS ended `failure`'* ]] && [[ "$text" == *'winget (`PaneoTech.RafikiCode`): skipped. The repository secret `WINGET_TOKEN`'* ]]
check $? "a failed channel reads as not published, a skipped one names its secret"

text=$(section NPM_ENABLED=false HOMEBREW_ENABLED=false WINGET_ENABLED=false)
! printf '%s' "$text" | grep -q $'\xe2\x80\x94\|\xe2\x80\x93'
check $? "the section has no long dash"

# ------------------------------------------------------------------- splice --

printf '## What changed\n\n* a fix by someone\n' > "$WORK/notes.md"
section NPM_ENABLED=false HOMEBREW_ENABLED=true WINGET_ENABLED=false > "$WORK/first.md"
bash "$SCRIPT" splice "$WORK/notes.md" "$WORK/first.md"
head -1 "$WORK/notes.md" | grep -qx "## What changed" && grep -q "being published by the release run" "$WORK/notes.md" \
    && [ "$(grep -c '^<!-- package-managers -->$' "$WORK/notes.md")" = "1" ]
check $? "the section is appended to the generated notes"

cp "$WORK/notes.md" "$WORK/once.md"
bash "$SCRIPT" splice "$WORK/notes.md" "$WORK/first.md"
cmp -s "$WORK/notes.md" "$WORK/once.md"
check $? "splicing the same section again changes nothing"

section NPM_ENABLED=false HOMEBREW_ENABLED=true WINGET_ENABLED=false HOMEBREW_RESULT=success HOMEBREW_VERIFY_RESULT=success > "$WORK/final.md"
bash "$SCRIPT" splice "$WORK/notes.md" "$WORK/final.md"
[ "$(grep -c '^### Package managers$' "$WORK/notes.md")" = "1" ] && ! grep -q "being published" "$WORK/notes.md" \
    && grep -q "checked on macOS" "$WORK/notes.md" && grep -q "a fix by someone" "$WORK/notes.md"
check $? "the final section replaces the first one and keeps the rest of the notes"

: > "$WORK/empty.md"
bash "$SCRIPT" splice "$WORK/empty.md" "$WORK/final.md"
cmp -s "$WORK/empty.md" "$WORK/final.md"
check $? "empty notes get the section alone"

# ----------------------------------------------------------------- workflow --

if command -v python3 >/dev/null 2>&1 && python3 -c "import yaml" 2>/dev/null; then
    python3 - "$WORKFLOW" <<'PY'
import sys, yaml
w = yaml.safe_load(open(sys.argv[1]))
jobs = w["jobs"]
problems = []
def text(job):
    return yaml.safe_dump(jobs[job])
for job in ("preflight", "build", "gate", "install-matrix", "publish"):
    for token in ("NPM_TOKEN", "HOMEBREW_TAP_TOKEN", "WINGET_TOKEN"):
        if job != "preflight" and token in text(job):
            problems.append(f"{job} reads {token}")
pre = [s for s in jobs["preflight"]["steps"] if s.get("id") == "secrets"][0]
if "release-channels.sh preflight" not in pre["run"]:
    problems.append("preflight does not run install/release-channels.sh preflight")
for out in ("npm", "homebrew", "winget", "live_gate"):
    if out not in jobs["preflight"]["outputs"]:
        problems.append(f"preflight has no output {out}")
for job, out in (("npm", "npm"), ("homebrew", "homebrew"), ("homebrew-verify", "homebrew"), ("winget", "winget")):
    cond = jobs[job].get("if", "")
    if f"needs.preflight.outputs.{out} == 'true'" not in cond or "prerelease != 'true'" not in cond:
        problems.append(f"{job} does not run only when its token is set: {cond!r}")
if "publish" in jobs["publish"].get("needs", []):
    problems.append("publish needs itself")
for job in ("npm", "homebrew", "homebrew-verify", "winget"):
    if job in jobs["publish"].get("needs", []):
        problems.append(f"publish waits for {job}")
pm = jobs.get("package-managers", {})
if not pm:
    problems.append("no package-managers job")
else:
    for need in ("publish", "npm", "homebrew", "homebrew-verify", "winget"):
        if need not in pm["needs"]:
            problems.append(f"package-managers does not wait for {need}")
    if "always()" not in pm.get("if", "") or "needs.publish.result == 'success'" not in pm.get("if", ""):
        problems.append("package-managers must run always, once publish succeeded")
print("\n".join(problems))
sys.exit(1 if problems else 0)
PY
    check $? "release.yml: the GitHub release never reads the three tokens, and each channel job runs only with its token"
else
    echo "skip: python3 with yaml is not available, the workflow shape is not checked"
fi

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" = "0" ]
