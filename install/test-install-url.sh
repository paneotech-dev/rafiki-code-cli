#!/usr/bin/env bash
# Checks the release override rules of install/install.sh without a network:
# curl is replaced by a shim that records its arguments and fails. A refused
# override must exit 1 before curl runs; an accepted one must reach curl with
# https pinned (--proto =https --proto-redir =https) unless the loopback test
# switch is used.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
INSTALLER="$HERE/install.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/rafikicode-install-url.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin" "$WORK/home"
cat > "$WORK/bin/curl" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$WORK/curl.log"
exit 22
EOF
chmod 755 "$WORK/bin/curl"

set +e
pass=0
fail=0
check() {
    if [ "$1" = "0" ]; then pass=$((pass + 1)); echo "ok   $2"; else fail=$((fail + 1)); echo "FAIL $2"; fi
}

# run <api> <base> [installer args...]: sets out, rc and calls (curl invocations).
run() {
    local api=$1 base=$2
    shift 2
    rm -f "$WORK/curl.log"
    out=$(env -i PATH="$WORK/bin:/usr/bin:/bin" HOME="$WORK/home" TMPDIR="$WORK" \
        RAFIKICODE_RELEASE_API="$api" RAFIKICODE_RELEASE_BASE="$base" \
        RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK="${ALLOW:-}" RAFIKICODE_INSTALL_DIR="$WORK/prefix" \
        bash "$INSTALLER" --no-modify-path "$@" 2>&1)
    rc=$?
    calls=0
    [ -f "$WORK/curl.log" ] && calls=$(wc -l < "$WORK/curl.log")
}

refused=(
    "http://127.0.0.1:4150/dl"
    "http://[::1]:4150/dl"
    "http://localhost:4150/dl"
    "http://localhost/dl"
    "http://127.0.0.1:x@evil.example/dl"
    "http://127.0.0.1@evil.example/dl"
    "http://user@127.0.0.1:4150/dl"
    "http://[::ffff:127.0.0.1]:4150/dl"
    "http://[::ffff:7f00:1]/dl"
    "http://127.1/dl"
    "http://2130706433/dl"
    "http://0x7f000001/dl"
    "http://127.0.0.1.nip.io/dl"
    "HTTP://127.0.0.1/dl"
    "http://127.0.0.1\\@evil.example/dl"
    "http://127.0.0.1:4150/dl?x=@evil.example"
    "https://github.com@evil.example/dl"
    "https://evil.example /dl"
    "ftp://127.0.0.1/dl"
    "file:///tmp/dl"
)

# Without the switch every http form is refused, loopback included.
for url in "${refused[@]}"; do
    ALLOW="" run "" "$url" --version 1.2.3
    [ "$rc" = "1" ] && [[ "$out" == *"must be an https URL"* ]] && [ "$calls" = "0" ]; check $? "refused without the switch: $url"
done

# With the switch only 127.0.0.1 and [::1] become acceptable; the rest stay refused.
for url in "${refused[@]:2}"; do
    ALLOW=1 run "$url" "" --version 1.2.3
    [ "$rc" = "1" ] && [[ "$out" == *"RAFIKICODE_RELEASE_API must be an https URL"* ]] && [ "$calls" = "0" ]; check $? "refused with the switch (API): $url"
done

ALLOW=1 run "" "http://127.0.0.1:4150/dl" --version 1.2.3 --dry-run
[ "$rc" = "0" ] && [[ "$out" == *"http://127.0.0.1:4150/dl/download/v1.2.3/"* ]] && [ "$calls" = "0" ]; check $? "accepted with the switch: 127.0.0.1"

ALLOW="" run "" "http://[::1]:4150/dl" --version 1.2.3 --dry-run --allow-http-loopback
[ "$rc" = "0" ] && [[ "$out" == *"http://[::1]:4150/dl/download/v1.2.3/"* ]]; check $? "accepted with --allow-http-loopback: [::1]"

# Accepted https: the download reaches curl with https pinned on redirects.
ALLOW="" run "" "https://releases.example.com/dl" --version 1.2.3
proto=$(grep -c -- "--proto =https --proto-redir =https" "$WORK/curl.log" 2>/dev/null)
[ "$rc" = "1" ] && [ "$calls" -ge 1 ] && [ "$proto" = "$calls" ]; check $? "https override: every curl call pins https ($calls calls)"

ALLOW="" run "" "" --version 1.2.3
proto=$(grep -c -- "--proto =https --proto-redir =https" "$WORK/curl.log" 2>/dev/null)
[ "$calls" -ge 1 ] && [ "$proto" = "$calls" ]; check $? "default release location: every curl call pins https"

ALLOW="" run "https://api.example.com/repos/x/y" ""
proto=$(grep -c -- "--proto =https --proto-redir =https" "$WORK/curl.log" 2>/dev/null)
[ "$rc" != "0" ] && [ "$calls" -ge 1 ] && [ "$proto" = "$calls" ]; check $? "latest version lookup pins https"

echo "install url tests: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ]
