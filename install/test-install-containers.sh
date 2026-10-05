#!/usr/bin/env bash
# install/install.sh on the machines people actually have, each with one thing
# taken away, against a fake release served from this host.
#
# install/test-install.sh proves each fallback with a sandboxed PATH on this
# machine. This proves the same fallbacks on real distributions, where the
# missing piece is really missing: a Debian with no curl, an Alpine with no
# bash, a Fedora with no tar, a read only /tmp, a home folder mounted noexec, no
# HOME at all, a proxy, a rate limited API.
#
# Every container is throwaway (docker run --rm, named cli-install-<cell>-<pid>)
# and reaches the fake release through the host network. Images that need a
# package added are built once as rafikicode-install-<name> and reused.
#
# Usage: install/test-install-containers.sh [--only <cell id substring>] [--list]
# Without docker it says so and exits 0.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
INSTALLER="$HERE/install.sh"
PORT="${PORT:-4170}"
only=""
list=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --only) only=$2; shift 2 ;;
        --list) list=true; shift ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    echo "skip: docker is not available"
    exit 0
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/rafikicode-install-containers.XXXXXX")
pids=()
cleanup() {
    local pid
    for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
    rm -rf "${WORK:?}"
}
trap cleanup EXIT

# --- The fake release: one shell script, under every Linux asset name --------
mkdir -p "$WORK/site/dl/download/v1.2.3" "$WORK/site/api/releases" "$WORK/site/gw/health" "$WORK/build"
printf '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.3; exit 0; fi\necho "rafikicode fake"\n' > "$WORK/build/rafikicode"
chmod 755 "$WORK/build/rafikicode"
for name in linux-x64 linux-x64-baseline linux-x64-musl linux-x64-baseline-musl linux-arm64 linux-arm64-musl; do
    tar -czf "$WORK/site/dl/download/v1.2.3/rafikicode-${name}.tar.gz" -C "$WORK/build" rafikicode
done
(cd "$WORK/site/dl/download/v1.2.3" && sha256sum ./*.tar.gz | sed 's| \./| |' > SHA256SUMS)
echo '{"tag_name": "v1.2.3"}' > "$WORK/site/api/releases/latest"
echo '"I am alive!"' > "$WORK/site/gw/health/liveliness"

# One server for the release, and one that refuses the API and the release
# page so only the direct latest address works; a logging proxy beside them.
cat > "$WORK/server.py" <<'PYEOF'
import functools, http.server, sys, urllib.request
SITE, PORT, MODE, LOG = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        open(LOG, "a").write(self.path + "\n")
        if MODE == "proxy":
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(self.path, timeout=30) as r:
                    body = r.read()
                    self.send_response(r.status); self.send_header("Content-Length", str(len(body))); self.end_headers()
                    self.wfile.write(body)
            except urllib.error.HTTPError as e:
                self.send_response(e.code); self.send_header("Content-Length", "0"); self.end_headers()
            return
        if MODE == "ratelimited":
            if self.path.startswith("/api/"):
                self.send_response(403); self.send_header("Content-Length", "0"); self.end_headers(); return
            if self.path == "/dl/latest":
                self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers(); return
            if self.path.startswith("/dl/latest/download/"):
                self.path = "/dl/download/v1.2.3/" + self.path.rsplit("/", 1)[1]
        super().do_GET()
    def log_message(self, *a):
        pass
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(H, directory=SITE)).serve_forever()
PYEOF
python3 "$WORK/server.py" "$WORK/site" "$PORT" plain "$WORK/plain.log" & pids+=($!)
python3 "$WORK/server.py" "$WORK/site" "$((PORT + 1))" ratelimited "$WORK/ratelimited.log" & pids+=($!)
python3 "$WORK/server.py" "$WORK/site" "$((PORT + 2))" proxy "$WORK/proxy.log" & pids+=($!)
for _ in $(seq 1 50); do
    curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/api/releases/latest" 2>/dev/null && break
    sleep 0.1
done

# --- Images ------------------------------------------------------------------
# image NAME BASE SETUP: a derived image with SETUP run once, cached by name.
image() {
    local name=$1 base=$2 setup=$3 tag="rafikicode-install-$1"
    if ! docker image inspect "$tag" >/dev/null 2>&1; then
        printf 'FROM %s\nRUN %s\n' "$base" "$setup" | docker build -q -t "$tag" - >/dev/null
    fi
    printf '%s\n' "$tag"
}

APT='apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends'

pass=0
fail=0
check() {
    if [ "$1" = "0" ]; then pass=$((pass + 1)); echo "ok   $2"; else fail=$((fail + 1)); echo "FAIL $2"; printf '%s\n' "$out" | tail -n 15 | sed 's/^/    | /'; fi
}

# cell ID IMAGE DOCKER_ARGS SCRIPT: runs SCRIPT with sh in a throwaway
# container that has the installer at /i/install.sh, and keeps its output.
cell() {
    local id=$1 img=$2 args=$3 script=$4
    if [ -n "$only" ] && [[ "$id" != *"$only"* ]]; then return 1; fi
    if [ "$list" = "true" ]; then echo "$id"; return 1; fi
    # shellcheck disable=SC2086
    out=$(docker run --rm --name "cli-install-${id}-$$" --network host \
        -v "$INSTALLER:/i/install.sh:ro" \
        -e RAFIKICODE_RELEASE_API="http://127.0.0.1:${PORT}/api" \
        -e RAFIKICODE_RELEASE_BASE="http://127.0.0.1:${PORT}/dl" \
        -e RAFIKICODE_GATEWAY_URL="http://127.0.0.1:${PORT}/gw/v1" \
        -e RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK=1 \
        -e RAFIKICODE_INSTALL_RETRY_DELAY=0 \
        $args "$img" sh -c "$script" 2>&1 | sed $'s/\033\\[[0-9;]*m//g') && rc=0 || rc=$?
    return 0
}

INSTALL='bash /i/install.sh --no-login'

if [ "$list" != "true" ]; then
    debian_curl=$(image debian-curl debian:12-slim "$APT curl ca-certificates")
    debian_wget=$(image debian-wget debian:12-slim "$APT wget ca-certificates")
    debian_python=$(image debian-python3 debian:12-slim "$APT python3 ca-certificates")
    ubuntu_curl=$(image ubuntu-curl ubuntu:24.04 "$APT curl ca-certificates")
    alpine_bash=$(image alpine-bash alpine:3.20 "apk add --no-cache bash curl")
    fedora=$(image fedora-su fedora:40 "dnf install -y -q util-linux shadow-utils && dnf clean all")
else
    debian_curl=x debian_wget=x debian_python=x ubuntu_curl=x alpine_bash=x fedora=x
fi

# Plain installs on four distributions.
for pair in "debian:$debian_curl" "ubuntu:$ubuntu_curl" "alpine:$alpine_bash" "fedora:$fedora"; do
    id="plain-${pair%%:*}"
    if cell "$id" "${pair#*:}" "" "$INSTALL && ~/.rafikicode/bin/rafikicode --version"; then
        [ "$rc" = 0 ] && [[ "$out" == *"Ready."* ]] && [[ "$out" == *$'\n1.2.3'* ]]; check $? "$id: installs, the closing check is green"
    fi
done

# Alpine as it ships: no bash. The installer says how to run it, nothing else.
if cell alpine-stock alpine:3.20 "" "sh /i/install.sh"; then
    [ "$rc" != 0 ] && [[ "$out" == *"apk add bash"* ]]; check $? "alpine-stock: no bash, the installer names apk add bash"
fi

# No curl: wget; no curl and no wget: python3.
if cell no-curl-wget "$debian_wget" "" "$INSTALL"; then
    [ "$rc" = 0 ] && [[ "$out" == *"downloads use wget"* ]] && [[ "$out" == *"Ready."* ]]; check $? "no-curl-wget: downloads with wget"
fi
if cell no-curl-python "$debian_python" "" "$INSTALL"; then
    [ "$rc" = 0 ] && [[ "$out" == *"downloads use python3"* ]] && [[ "$out" == *"Ready."* ]]; check $? "no-curl-python: downloads with python3"
fi
# Nothing at all that can download: one sentence and the apt-get line.
if cell no-downloader debian:12-slim "" "$INSTALL"; then
    [ "$rc" != 0 ] && [[ "$out" == *"apt-get install"* ]] && [[ "$out" == *"curl"* ]]; check $? "no-downloader: names the package and the command"
fi

# No tar: python3 unpacks it.
if cell no-tar "$debian_python" "" "rm -f /usr/bin/tar /bin/tar && $INSTALL"; then
    [ "$rc" = 0 ] && [[ "$out" == *"archive was unpacked with python3"* ]]; check $? "no-tar: python3 unpacks the archive"
fi

# /tmp read only: the download goes to ~/.rafikicode/tmp.
if cell ro-tmp "$debian_curl" "--tmpfs /tmp:ro" "$INSTALL"; then
    [ "$rc" = 0 ] && [[ "$out" == *"/tmp cannot be written, so the download goes to /root/.rafikicode/tmp instead"* ]]; check $? "ro-tmp: a read only /tmp falls back to ~/.rafikicode/tmp"
fi

# A home folder mounted noexec, as a normal user: nothing under it can run a
# program, so the installer stops before downloading, with the one fix.
if cell noexec-home "$debian_curl" "--tmpfs /home/u:noexec,uid=1000,gid=1000 -e HOME=/home/u -u 1000:1000" "$INSTALL"; then
    [ "$rc" != 0 ] && [[ "$out" == *"does not allow running a program (noexec)"* ]] \
        && [[ "$out" == *"--prefix /path/you/own/bin"* ]] && [[ "$out" != *"Checksum verified"* ]]; check $? "noexec-home: stops before the download, naming --prefix"
fi
# The same, with a folder that can run programs: installed there.
if cell noexec-home-prefix "$debian_curl" "--tmpfs /home/u:noexec,uid=1000,gid=1000 --tmpfs /opt/u:exec,uid=1000,gid=1000 -e HOME=/home/u -u 1000:1000" "$INSTALL --prefix /opt/u/bin && /opt/u/bin/rafikicode --version"; then
    [ "$rc" = 0 ] && [[ "$out" == *$'\n1.2.3'* ]]; check $? "noexec-home-prefix: a prefix that can run programs works"
fi

# No HOME at all: the password database names it.
if cell no-home "$debian_curl" "" "unset HOME; $INSTALL && /root/.rafikicode/bin/rafikicode --version"; then
    [ "$rc" = 0 ] && [[ "$out" == *"HOME was not set; using this account's home folder, /root."* ]]; check $? "no-home: HOME from the password database"
fi

# A proxy given only as HTTP_PROXY, with wget, which would not read it alone.
: > "$WORK/proxy.log"
if cell proxy-wget "$debian_wget" "-e HTTP_PROXY=http://127.0.0.1:$((PORT + 2))" "$INSTALL"; then
    [ "$rc" = 0 ] && grep -q "/dl/download/v1.2.3/SHA256SUMS" "$WORK/proxy.log"; check $? "proxy-wget: every download goes through HTTP_PROXY"
fi

# The API rate limited and the release page refused: the direct address.
if cell ratelimited "$debian_curl" "-e RAFIKICODE_RELEASE_API=http://127.0.0.1:$((PORT + 1))/api -e RAFIKICODE_RELEASE_BASE=http://127.0.0.1:$((PORT + 1))/dl" "$INSTALL"; then
    [ "$rc" = 0 ] && [[ "$out" == *"downloaded directly"* ]] && [[ "$out" == *"Ready."* ]]; check $? "ratelimited: the direct latest address installs it"
fi

# --- As a normal user, the way people run it: su - user -c 'cat install.sh | bash'
ENVS="RAFIKICODE_RELEASE_API=http://127.0.0.1:${PORT}/api RAFIKICODE_RELEASE_BASE=http://127.0.0.1:${PORT}/dl RAFIKICODE_GATEWAY_URL=http://127.0.0.1:${PORT}/gw/v1 RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK=1 RAFIKICODE_INSTALL_RETRY_DELAY=0"
mkuser='(useradd -m tester 2>/dev/null || adduser -D tester 2>/dev/null)'
as_user() { printf "%s && su - tester -c \"%s cat /i/install.sh | %s bash -s -- --no-login\"" "$mkuser" "${2:-}" "$ENVS"; }
fresh_login='su - tester -c "command -v rafikicode; rafikicode --version; echo TMPDIR=\${TMPDIR:-unset}"'

for pair in "debian:$debian_curl" "ubuntu:$ubuntu_curl" "alpine:$alpine_bash" "fedora:$fedora"; do
    id="user-${pair%%:*}"
    if cell "$id" "${pair#*:}" "" "$(as_user) && echo '--- fresh login ---' && $fresh_login"; then
        after=${out##*--- fresh login ---}
        [ "$rc" = 0 ] && [[ "$out" == *"Ready."* ]] && [[ "$after" == *"/home/tester/.rafikicode/bin/rafikicode"* ]] \
            && [[ "$after" == *$'\n1.2.3'* ]]; check $? "$id: a normal user installs, and a fresh login shell finds it"
    fi
done

# Alpine, root: /etc/profile is never written.
if cell root-etc-profile "$alpine_bash" "" "cp /etc/profile /tmp/profile.before && cat /i/install.sh | $ENVS bash -s -- --no-login >/dev/null 2>&1; cmp /etc/profile /tmp/profile.before && echo UNCHANGED"; then
    [[ "$out" == *UNCHANGED* ]]; check $? "root-etc-profile: /etc/profile is left alone"
fi

# An older copy in /usr/local/bin: a fresh login shell runs the new one.
if cell user-older-copy "$alpine_bash" "" "printf '#!/bin/sh\necho 0.0.1\n' > /usr/local/bin/rafikicode && chmod 755 /usr/local/bin/rafikicode && $(as_user) && echo '--- fresh login ---' && $fresh_login"; then
    after=${out##*--- fresh login ---}
    [ "$rc" = 0 ] && [[ "$out" == *"Another rafikicode at /usr/local/bin/rafikicode"* ]] && [[ "$after" == *$'\n1.2.3'* ]]; check $? "user-older-copy: the new install wins in a fresh login shell"
fi

# Read only /tmp, normal user: the startup file carries TMPDIR, and a fresh
# login shell has it.
if cell user-ro-tmp "$debian_curl" "--tmpfs /tmp:ro" "$(as_user) && echo '--- fresh login ---' && $fresh_login"; then
    after=${out##*--- fresh login ---}
    [ "$rc" = 0 ] && [[ "$out" == *"/tmp cannot be written, so the download goes to"* ]] \
        && [[ "$after" == *"TMPDIR=/home/tester/.rafikicode/tmp"* ]]; check $? "user-ro-tmp: TMPDIR is in the startup file, a fresh login shell has it"
fi

# Alpine with BusyBox wget only (no curl, no python3, no perl).
alpine_bbwget=$(image alpine-bash-only alpine:3.20 "apk add --no-cache bash")
if cell user-busybox-wget "$alpine_bbwget" "" "$(as_user)"; then
    [ "$rc" = 0 ] && [[ "$out" == *"downloads use wget"* ]] && [[ "$out" != *"firewall"* ]] && [[ "$out" == *"Ready."* ]]; check $? "user-busybox-wget: BusyBox wget installs it"
fi

# A real binary built from this branch, when one is given: under a read only
# /tmp with no TMPDIR, --version and the folder check work.
if [ -n "${RAFIKICODE_CONTAINER_BINARY:-}" ] && [ -x "$RAFIKICODE_CONTAINER_BINARY" ]; then
    if cell real-ro-tmp debian:12-slim "--tmpfs /tmp:ro -v $RAFIKICODE_CONTAINER_BINARY:/opt/rk/rafikicode:ro" "$mkuser && su - tester -c 'echo TMPDIR=\${TMPDIR:-unset}; /opt/rk/rafikicode --version && /opt/rk/rafikicode doctor --folders'"; then
        [ "$rc" = 0 ] && [[ "$out" == *"TMPDIR=unset"* ]] && [[ "$out" == *"The temporary folder /tmp cannot be written, so rafikicode uses /home/tester/.rafikicode/tmp instead."* ]] \
            && [[ "$out" == *"fixed: /tmp cannot be written"* ]]; check $? "real-ro-tmp: the built binary runs under a read only /tmp with no TMPDIR"
    fi
fi

[ "$list" = "true" ] && exit 0
echo
echo "container install tests: ${pass} passed, ${fail} failed"
[ "$fail" = 0 ]
