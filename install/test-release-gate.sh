#!/usr/bin/env bash
# Exercises install/release-gate.sh without Docker and without a network: a
# fake release (a shell script standing in for the binary) is gated on this
# machine with --host. What is under test is the gate's own judgement: that a
# good build passes all five facets, that each kind of bad build fails the
# facet it should and blocks, and that a missing credential stops the gate with
# the secret's name instead of letting it pass. --no-live, for a pre-release
# without the staging key, skips signin and task and nothing else, records
# them as skipped, and is refused wherever it is not asked for explicitly.
#
# The fake binary accepts one key and answers the way the real commands do, so
# the sign-in and task facets are driven without a gateway. The real binary
# against mock staging endpoints is a separate, manual run (docs/install.md).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
GATE="$HERE/release-gate.sh"
PORT="${PORT:-4171}"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/rafikicode-gate-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
export PORT
KEY="rk_gate_test_not_a_real_key"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
[[ "$arch" == "x86_64" ]] && arch=x64
[[ "$arch" == "aarch64" ]] && arch=arm64
target="$os-$arch"
ext=".tar.gz"
[ "$os" = "linux" ] || ext=".zip"

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

# make_release <name> <version printed> <answer of run> <whoami mode> <licence files: yes|no>
make_release() {
    local name=$1 printed=$2 answer=$3 whoami=$4 licences=$5
    local build="$WORK/$name/build" assets="$WORK/$name/assets"
    mkdir -p "$build" "$assets"
    cat > "$build/rafikicode" <<FAKE
#!/bin/sh
echo "\$1" >> "$WORK/$name/calls.log"
case "\$1" in
    --version) echo "${printed}"; exit 0 ;;
    licenses)
        if [ "${licences}" = "yes" ]; then echo "MIT License"; echo "Permission is hereby granted, free of charge"; exit 0; fi
        echo "unknown command: licenses" >&2; exit 1 ;;
    whoami)
        [ "\${RAFIKICODE_API_KEY:-}" = "${KEY}" ] || { echo "Not signed in." >&2; exit 2; }
        if [ "${whoami}" = "unreachable" ]; then
            echo "Could not load the account from the Rafiki AI console (fetch failed)."
            echo "Account: a server key from the environment"
            exit 0
        fi
        echo "Account: staging gate test account"; exit 0 ;;
    run)
        [ "\${RAFIKICODE_API_KEY:-}" = "${KEY}" ] || { echo "Not signed in." >&2; exit 2; }
        echo "${answer}"; exit 0 ;;
esac
echo "rafikicode fake"
FAKE
    chmod 755 "$build/rafikicode"
    if [ "$licences" = "yes" ]; then
        echo "licence text" > "$build/LICENSE"
        echo "notice text" > "$build/NOTICE"
    fi
    if [ "$ext" = ".tar.gz" ]; then
        tar -czf "$assets/rafikicode-${target}${ext}" -C "$build" .
    else
        (cd "$build" && zip -q "$assets/rafikicode-${target}${ext}" ./* )
    fi
    (cd "$assets" && sha256_file "rafikicode-${target}${ext}" > SHA256SUMS)
}

set +e
pass=0
fail=0
check() {
    if [ "$1" = "0" ]; then pass=$((pass + 1)); echo "ok   $2"; else fail=$((fail + 1)); echo "FAIL $2"; fi
}
gate() {
    local name=$1; shift
    RAFIKICODE_STAGING_API_KEY="$KEY" bash "$GATE" --host --target "$target" --version 1.4.0 \
        --assets "$WORK/$name/assets" --results "$WORK/$name/results.tsv" "$@" > "$WORK/$name/out.txt" 2>&1
}
verdict() { awk -F'\t' -v f="$2" '$3 == f {print $4}' "$WORK/$1/results.tsv" 2>/dev/null; }

make_release good 1.4.0 "hello world" ok yes
gate good; rc=$?
[ "$rc" = "0" ] && [ "$(awk -F'\t' '$4 == "pass"' "$WORK/good/results.tsv" | wc -l | tr -d ' ')" = "5" ] \
    && grep -q "passed all 5 facets" "$WORK/good/out.txt"; check $? "a good build passes install, version, licence, signin and task"

! grep -q "$KEY" "$WORK/good/out.txt" "$WORK/good/results.tsv"; check $? "the credential appears nowhere in the gate's output"

out=$(env -u RAFIKICODE_STAGING_API_KEY bash "$GATE" --host --target "$target" --version 1.4.0 --assets "$WORK/good/assets" 2>&1); rc=$?
[ "$rc" = "2" ] && [[ "$out" == *"RAFIKICODE_STAGING_API_KEY is not set"* ]] && [[ "$out" == *"the release is blocked"* ]] \
    && [[ "$out" != *"GATE_RESULT"* ]]; check $? "without the staging credential the gate stops, exit 2, naming the secret"

out=$(RAFIKICODE_STAGING_API_KEY="" bash "$GATE" --host --target "$target" --version 1.4.0 --assets "$WORK/good/assets" 2>&1); rc=$?
[ "$rc" = "2" ] && [[ "$out" == *"RAFIKICODE_STAGING_API_KEY is not set"* ]]; check $? "an empty credential is a missing credential"

make_release wronganswer 1.4.0 "I cannot help with that" ok yes
gate wronganswer; rc=$?
[ "$rc" = "1" ] && [ "$(verdict wronganswer task)" = "fail" ] && [ "$(verdict wronganswer signin)" = "pass" ] \
    && grep -q "This build blocks the release" "$WORK/wronganswer/out.txt"; check $? "a task that does not answer hello world fails the task facet and blocks"

make_release wrongversion 1.3.9 "hello world" ok yes
gate wrongversion; rc=$?
[ "$rc" = "1" ] && [ "$(verdict wrongversion version)" = "fail" ]; check $? "a binary that prints another version fails the version facet"

make_release nolicence 1.4.0 "hello world" ok no
gate nolicence; rc=$?
[ "$rc" = "1" ] && [ "$(verdict nolicence licence)" = "fail" ] && [ "$(verdict nolicence task)" = "pass" ]; check $? "a build without its licence fails the licence facet"

make_release unreachable 1.4.0 "hello world" unreachable yes
gate unreachable; rc=$?
[ "$rc" = "1" ] && [ "$(verdict unreachable signin)" = "fail" ]; check $? "a credential that was not checked against the console fails the signin facet"

RAFIKICODE_STAGING_API_KEY="rk_some_other_key" bash "$GATE" --host --target "$target" --version 1.4.0 \
    --assets "$WORK/good/assets" --results "$WORK/good/results-badkey.tsv" > "$WORK/good/out-badkey.txt" 2>&1; rc=$?
[ "$rc" = "1" ] && [ "$(awk -F'\t' '$3 == "signin" {print $4}' "$WORK/good/results-badkey.tsv")" = "fail" ] \
    && [ "$(awk -F'\t' '$3 == "task" {print $4}' "$WORK/good/results-badkey.tsv")" = "fail" ]; check $? "a rejected credential fails signin and task"

make_release altered 1.4.0 "hello world" ok yes
echo "changed after the checksums were written" >> "$WORK/altered/assets/rafikicode-${target}${ext}"
gate altered; rc=$?
[ "$rc" = "2" ] && grep -q "does not match SHA256SUMS" "$WORK/altered/out.txt"; check $? "an archive that is not the one SHA256SUMS names is refused before anything is installed"

mkdir -p "$WORK/empty/assets"; : > "$WORK/empty/assets/SHA256SUMS"
gate empty; rc=$?
[ "$rc" = "2" ] && grep -q "was not produced" "$WORK/empty/out.txt"; check $? "a release with no archive for the target is refused"

# --no-live: a pre-release without the staging key.
SKIPPED="skipped (no staging key, pre-release)"
gate_nolive() {
    local name=$1; shift
    env -u RAFIKICODE_STAGING_API_KEY bash "$GATE" --host --target "$target" --version 1.4.0-rc.1 \
        --assets "$WORK/$name/assets" --results "$WORK/$name/results.tsv" --no-live "$@" > "$WORK/$name/out.txt" 2>&1
}
make_release rc 1.4.0-rc.1 "hello world" ok yes
gate_nolive rc; rc=$?
[ "$rc" = "0" ] && [ "$(verdict rc install)" = "pass" ] && [ "$(verdict rc version)" = "pass" ] \
    && [ "$(verdict rc licence)" = "pass" ] && [ "$(verdict rc signin)" = "$SKIPPED" ] && [ "$(verdict rc task)" = "$SKIPPED" ] \
    && [ "$(wc -l < "$WORK/rc/results.tsv" | tr -d ' ')" = "5" ] \
    && grep -q "passed 3 of 5 facets; signin and task were ${SKIPPED}" "$WORK/rc/out.txt"; check $? "--no-live runs install, version and licence and records signin and task as skipped"
[ "$(awk -F'\t' '$4 == "pass" {print $3}' "$WORK/rc/results.tsv" | tr '\n' ' ')" = "install version licence " ]; check $? "--no-live never records signin or task as a pass"
grep -qx -- "--version" "$WORK/rc/calls.log" && grep -qx "licenses" "$WORK/rc/calls.log" \
    && ! grep -qx "whoami" "$WORK/rc/calls.log" && ! grep -qx "run" "$WORK/rc/calls.log"; check $? "--no-live starts the binary for version and licence and never for whoami or run"

make_release rcnolicence 1.4.0-rc.1 "hello world" ok no
gate_nolive rcnolicence; rc=$?
[ "$rc" = "1" ] && [ "$(verdict rcnolicence licence)" = "fail" ] && [ "$(verdict rcnolicence signin)" = "$SKIPPED" ] \
    && grep -q "This build blocks the release" "$WORK/rcnolicence/out.txt"; check $? "--no-live still fails and blocks a build that fails an offline facet"

make_release rcwrongversion 1.4.0 "hello world" ok yes
gate_nolive rcwrongversion; rc=$?
[ "$rc" = "1" ] && [ "$(verdict rcwrongversion version)" = "fail" ]; check $? "--no-live still fails a binary that prints another version"

mkdir -p "$WORK/rcempty/build" "$WORK/rcempty/assets"
echo "not a program" > "$WORK/rcempty/build/README"
if [ "$ext" = ".tar.gz" ]; then tar -czf "$WORK/rcempty/assets/rafikicode-${target}${ext}" -C "$WORK/rcempty/build" .
else (cd "$WORK/rcempty/build" && zip -q "$WORK/rcempty/assets/rafikicode-${target}${ext}" ./*); fi
(cd "$WORK/rcempty/assets" && sha256_file "rafikicode-${target}${ext}" > SHA256SUMS)
gate_nolive rcempty; rc=$?
[ "$rc" = "1" ] && [ "$(verdict rcempty install)" = "fail" ] && [ "$(verdict rcempty signin)" = "fail" ] \
    && [ "$(verdict rcempty task)" = "fail" ]; check $? "--no-live with nothing installed fails signin and task instead of skipping them"

out=$(env -u RAFIKICODE_STAGING_API_KEY bash "$GATE" --host --target "$target" --version 1.4.0 --assets "$WORK/good/assets" --no-live 2>&1); rc=$?
[ "$rc" = "2" ] && [[ "$out" == *"--no-live is for a pre-release only"* ]] && [[ "$out" != *"GATE_RESULT"* ]]; check $? "--no-live is refused for a full release"

out=$(RAFIKICODE_STAGING_API_KEY="$KEY" bash "$GATE" --host --target "$target" --version 1.4.0-rc.1 --assets "$WORK/rc/assets" --no-live 2>&1); rc=$?
[ "$rc" = "2" ] && [[ "$out" == *"while RAFIKICODE_STAGING_API_KEY is set"* ]]; check $? "--no-live is refused when a staging key is set"

out=$(env -u RAFIKICODE_STAGING_API_KEY bash "$GATE" --host --target "$target" --version 1.4.0-rc.1 --assets "$WORK/rc/assets" 2>&1); rc=$?
[ "$rc" = "2" ] && [[ "$out" == *"RAFIKICODE_STAGING_API_KEY is not set"* ]] && [[ "$out" != *"GATE_RESULT"* ]]; check $? "a pre-release without the key and without --no-live still stops the gate"

out=$(RAFIKICODE_STAGING_API_KEY="  " bash "$GATE" --host --target "$target" --version 1.4.0-rc.1 --assets "$WORK/rc/assets" 2>&1); rc=$?
[ "$rc" != "0" ] && [[ "$out" != *"skipped"* ]]; check $? "a mistyped key (blanks) without --no-live fails and skips nothing"

RAFIKICODE_STAGING_API_KEY="$KEY" bash "$GATE" --host --target "$target" --version 1.4.0-rc.1 \
    --assets "$WORK/rc/assets" --results "$WORK/rc/results-live.tsv" > "$WORK/rc/out-live.txt" 2>&1; rc=$?
[ "$rc" = "0" ] && [ "$(awk -F'\t' '$4 == "pass"' "$WORK/rc/results-live.tsv" | wc -l | tr -d ' ')" = "5" ]; check $? "a pre-release with the key runs all five facets"

out=$(RAFIKICODE_STAGING_API_KEY="$KEY" bash "$GATE" --host --target solaris-sparc --version 1.4.0 --assets "$WORK/good/assets" 2>&1); rc=$?
[ "$rc" = "2" ] && [[ "$out" == *"is not a build this product publishes"* ]]; check $? "a target that is not a published build is refused"

# install/package-release.sh: the archives carry the licence files beside the
# binary, and SHA256SUMS names every archive.
dist="$WORK/dist"
mkdir -p "$dist/rafikicode-linux-x64/bin"
printf '#!/bin/sh\necho packed\n' > "$dist/rafikicode-linux-x64/bin/rafikicode"
expected_archives="rafikicode-linux-x64.tar.gz "
# The macOS and Windows archives are made with zip, which a machine may not have.
if command -v zip >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1; then
    mkdir -p "$dist/rafikicode-darwin-arm64/bin"
    printf '#!/bin/sh\necho packed\n' > "$dist/rafikicode-darwin-arm64/bin/rafikicode"
    expected_archives="rafikicode-darwin-arm64.zip rafikicode-linux-x64.tar.gz "
fi
chmod 755 "$dist"/rafikicode-*/bin/rafikicode
out=$(bash "$HERE/package-release.sh" "$dist" 2>&1); rc=$?
listing=$(tar -tzf "$dist/rafikicode-linux-x64.tar.gz" 2>/dev/null | sed 's|^\./||' | grep -v '^$' | sort | tr '\n' ' ')
[ "$rc" = "0" ] && [ "$listing" = "LICENSE NOTICE rafikicode " ]; check $? "a packed Linux archive holds the binary, LICENSE and NOTICE at its root (${listing})"
if [ -d "$dist/rafikicode-darwin-arm64" ]; then
    listing=$(unzip -Z1 "$dist/rafikicode-darwin-arm64.zip" 2>/dev/null | sort | tr '\n' ' ')
    [ "$listing" = "LICENSE NOTICE rafikicode " ]; check $? "a packed zip archive holds the same three files (${listing})"
fi
[ "$(awk '{print $2}' "$dist/SHA256SUMS" | sort | tr '\n' ' ')" = "$expected_archives" ] \
    && (cd "$dist" && sha256_file -c SHA256SUMS >/dev/null 2>&1); check $? "SHA256SUMS names every archive and matches it"
cmp -s "$HERE/../LICENSE" <(tar -xzOf "$dist/rafikicode-linux-x64.tar.gz" ./LICENSE 2>/dev/null); check $? "the packed LICENSE is the repository's LICENSE"

# The gate installs into a throwaway home. Nothing of it may be left on the
# machine that ran it: an earlier version linked the fake binary into
# /usr/local/bin, pointing into a work directory that was then deleted.
leftover=""
for dir in /usr/local/bin "$HOME/.local/bin"; do
    if [ -L "$dir/rafikicode" ] && readlink "$dir/rafikicode" | grep -q "rafikicode-gate\."; then leftover="$dir/rafikicode"; fi
done
[ -z "$leftover" ]; check $? "the gate leaves no link on this machine's PATH (${leftover:-none found})"

echo "release gate tests: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ]
