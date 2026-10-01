#!/usr/bin/env bash
# Runs install/install.sh and the real published binary inside Docker containers
# that look like the machines users actually have, and reports five facts per
# cell: did the installer finish, is the command on PATH, does --version work,
# does doctor work, does the terminal interface start.
#
# Why this exists. install/test-install.sh checks the installer's logic against a
# fake release: a shell script standing in for the binary, on this machine, as
# this user. Everything that has gone wrong for real users was outside that: a
# temporary directory mounted noexec, a C library mismatch, a CPU without AVX2.
# None of it is reachable without a real binary in a hostile environment, which
# is what each cell here is.
#
# A cell that cannot be tested on this host is reported untested and counted
# separately. It is never reported as passing. That distinction is the point:
# "it worked on the build box" was recorded as "it works", and that is how a
# release went out with twelve of its fourteen assets never started once.
#
# Usage:
#   install/test-matrix.sh                      # every cell, local mirror of real assets
#   install/test-matrix.sh --list               # what the cells are
#   install/test-matrix.sh --only noexec        # cells whose id matches
#   install/test-matrix.sh --release-version 0.1.7
#   install/test-matrix.sh --no-download        # fail instead of fetching assets
#   install/test-matrix.sh --results out.tsv    # also write the verdicts as TSV
#
# --results writes one tab separated row per cell and facet -- id, facet,
# pass|fail|untested, detail -- to a path that outlives the run. The table below
# is for a person; the file is for whatever has to gate on it, and it carries
# the same three verdicts: nothing is decided, merged or softened on the way out.
#
# Cost on an 8 core host: about 6 minutes and roughly 1.1 GiB of transient Docker
# writable layer for a full run, plus 250 MiB of cached release assets and about
# 60 MiB of thin derived images that persist between runs. Each cell unpacks a
# 185 MiB binary and is removed immediately afterwards, so peak extra disk is one
# cell's worth rather than the whole matrix.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
INSTALLER="$HERE/install.sh"
PROBE="$HERE/test-matrix-probe.sh"

RELEASE_VERSION="${RAFIKICODE_MATRIX_VERSION:-0.1.7}"
OWNER=paneotech-dev
REPO=rafiki-code-cli
RELEASE_URL="https://github.com/${OWNER}/${REPO}/releases/download/v${RELEASE_VERSION}"
# Assets are large, so they are cached outside the work directory and reused.
ASSETS="${RAFIKICODE_MATRIX_ASSETS:-${TMPDIR:-/tmp}/rafikicode-matrix-assets}"
PORT="${PORT:-4160}"
# Stop rather than fill the disk. A cell unpacks a 185 MiB binary.
MIN_FREE_MIB="${RAFIKICODE_MATRIX_MIN_FREE_MIB:-2048}"
TUI_WAIT="${RAFIKICODE_MATRIX_TUI_WAIT:-12}"
IMAGE_PREFIX=rafikicode-matrix

only=""
results_out=""
do_download=true
do_list=false
keep=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --only) only="${2:?--only needs a pattern}"; shift 2 ;;
        --release-version) RELEASE_VERSION="${2:?}"; RELEASE_URL="https://github.com/${OWNER}/${REPO}/releases/download/v${RELEASE_VERSION}"; shift 2 ;;
        --assets) ASSETS="${2:?}"; shift 2 ;;
        --results) results_out="${2:?--results needs a path}"; shift 2 ;;
        --no-download) do_download=false; shift ;;
        --list) do_list=true; shift ;;
        --keep) keep=true; shift ;;
        -h|--help) sed -n '2,35p' "$0"; exit 0 ;;
        *) echo "unknown option '$1'" >&2; exit 1 ;;
    esac
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/rafikicode-matrix.XXXXXX")
SERVER_PID=""
cleanup() {
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
    rm -rf "$WORK"
    if [ "$keep" = "false" ]; then
        # Containers run with --rm, so this only sweeps up after a crash.
        docker ps -aq --filter "label=${IMAGE_PREFIX}" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

note() { printf '%s\n' "$*" >&2; }
free_mib() { df -Pm "$1" | awk 'NR==2{print $4}'; }

disk_guard() {
    local where="$1" avail
    avail=$(free_mib /)
    if [ "$avail" -lt "$MIN_FREE_MIB" ]; then
        note ""
        note "STOPPING: / has ${avail} MiB free, below the ${MIN_FREE_MIB} MiB floor (${where})."
        note "Reclaim with: docker system prune -af && rm -rf ${ASSETS}"
        exit 3
    fi
}

# ------------------------------------------------------------------- the cells --
#
# id|image key|description|docker args|probe env
# Images: plain = the stock base image, +curl = base with curl and CA
# certificates and a real unprivileged user added.
#
# noexec-tmp carries the size it does because the installer unpacks a 185 MiB
# binary into the temporary directory. A real shared host has a noexec /tmp with
# room on it; a 64 MiB tmpfs would fail for want of space and look like the same
# bug for the wrong reason.
cells=(
  "debian-root|debian+curl|glibc, Debian 12, root||"
  "debian-nonroot|debian+curl|glibc, Debian 12, unprivileged user|--user tester|"
  "ubuntu-root|ubuntu+curl|glibc, Ubuntu 24.04, root||"
  "ubuntu-nonroot|ubuntu+curl|glibc, Ubuntu 24.04, unprivileged user|--user tester|"
  "alpine-stock|alpine+curl|musl, Alpine 3.20, stock shell (no bash)||"
  "alpine-bash-root|alpine+bash|musl, Alpine 3.20, root||"
  "alpine-bash-nonroot|alpine+bash|musl, Alpine 3.20, unprivileged user|--user tester|"
  "alpine-libstdcpp|alpine+bash|musl, Alpine 3.20, with libstdc++ installed||"
  "noexec-tmp|debian+curl|noexec /tmp, the shared hosting default|--tmpfs /tmp:noexec,size=512m|"
  "noexec-tmp-nonroot|debian+curl|noexec /tmp, unprivileged user|--user tester --tmpfs /tmp:noexec,size=512m|"
  "noexec-tmp-tmpdir|debian+curl|noexec /tmp, TMPDIR at a directory that can exec|--tmpfs /tmp:noexec,size=512m|TMPDIR=/var/tmp/rafikicode-exec"
  "no-curl|debian|no curl, stock debian:12-slim||"
  "no-tar|debian+curl|no tar, so the archive cannot be unpacked||"
  "tmp-tiny|debian+curl|/tmp too small for the archive|--tmpfs /tmp:size=8m|"
  "home-unset|debian+curl|HOME is not set at all||"
  "home-readonly|debian+curl|read-only home directory|--user tester --read-only --tmpfs /tmp:size=512m|"
  "umask-077|debian+curl|restrictive umask 077||"
  "no-tty|debian+curl|piped stdin and stdout, as CI invokes it||"
  "arm64-root|debian+curl+arm64|glibc, Debian 12 on linux/arm64, root|--platform linux/arm64|"
  "arm64-noexec|debian+curl+arm64|linux/arm64 with a noexec /tmp|--platform linux/arm64 --tmpfs /tmp:noexec,size=512m|"
)

cell_field() { printf '%s' "$1" | cut -d'|' -f"$2"; }

if [ "$do_list" = "true" ]; then
    printf '%-22s %-14s %s\n' ID IMAGE DESCRIPTION
    for c in "${cells[@]}"; do
        printf '%-22s %-14s %s\n' "$(cell_field "$c" 1)" "$(cell_field "$c" 2)" "$(cell_field "$c" 3)"
    done
    exit 0
fi

# ---------------------------------------------------------------- preflight --

command -v docker >/dev/null 2>&1 || { note "docker is required"; exit 1; }
docker info >/dev/null 2>&1 || { note "the docker daemon is not reachable"; exit 1; }
command -v python3 >/dev/null 2>&1 || { note "python3 is required to serve the release assets"; exit 1; }
[ -f "$INSTALLER" ] || { note "no installer at $INSTALLER"; exit 1; }
[ -f "$PROBE" ] || { note "no probe at $PROBE"; exit 1; }

note "disk before: $(df -h / | awk 'NR==2{print $4" free on / ("$5" used)"}')"
disk_guard "before starting"

# Real release assets, verified against the SHA256SUMS published with them.
# Testing a locally built binary would miss the packaging faults, which is the
# whole reason for using the published bytes.
mkdir -p "$ASSETS"
want_assets=(
  "rafikicode-linux-x64.tar.gz"
  "rafikicode-linux-x64-baseline.tar.gz"
  "rafikicode-linux-x64-musl.tar.gz"
  "rafikicode-linux-x64-baseline-musl.tar.gz"
  "rafikicode-linux-arm64.tar.gz"
  "rafikicode-linux-arm64-musl.tar.gz"
)
if [ ! -s "$ASSETS/SHA256SUMS" ]; then
    [ "$do_download" = "true" ] || { note "no $ASSETS/SHA256SUMS and --no-download was given"; exit 1; }
    note "fetching SHA256SUMS for v${RELEASE_VERSION}"
    curl -fsSL -o "$ASSETS/SHA256SUMS" "$RELEASE_URL/SHA256SUMS" || { note "could not fetch SHA256SUMS"; exit 1; }
fi
for a in "${want_assets[@]}"; do
    if [ ! -s "$ASSETS/$a" ]; then
        [ "$do_download" = "true" ] || { note "missing $ASSETS/$a and --no-download was given"; exit 1; }
        note "fetching $a"
        curl -fsSL -o "$ASSETS/$a" "$RELEASE_URL/$a" || { note "could not fetch $a"; exit 1; }
    fi
done
note "verifying the published checksums"
( cd "$ASSETS" && grep -E "$(printf '%s|' "${want_assets[@]}" | sed 's/|$//' | sed 's/\./\\./g')" SHA256SUMS | sha256sum -c - ) \
    || { note "a release asset does not match its published checksum"; exit 1; }
disk_guard "after fetching assets"

# ---------------------------------------------------- local mirror of the release --
#
# The installer's real download, checksum and unpack path runs against the real
# bytes, served from here instead of from GitHub so a full matrix does not pull
# 250 MiB per cell. The URL layout is GitHub's. Loopback http is accepted only
# behind --allow-http-loopback, so containers share the host network namespace to
# reach 127.0.0.1; nothing else about them is shared.
SITE="$WORK/site"
mkdir -p "$SITE/api/releases" "$SITE/dl/download/v${RELEASE_VERSION}"
printf '{"tag_name": "v%s", "name": "v%s"}\n' "$RELEASE_VERSION" "$RELEASE_VERSION" > "$SITE/api/releases/latest"
for a in "${want_assets[@]}" SHA256SUMS; do
    ln -sf "$ASSETS/$a" "$SITE/dl/download/v${RELEASE_VERSION}/$a"
done

if command -v ss >/dev/null 2>&1 && ss -tln | awk '{print $4}' | grep -q ":${PORT}\$"; then
    note "port ${PORT} is in use, set PORT to a free one"; exit 1
fi
# http.server's default handler is single threaded and raises out of handle()
# when a client disappears mid transfer, which is exactly what the cell with an
# 8 MiB /tmp does: curl hits ENOSPC and drops the connection. The first run of
# this matrix lost the server there and the six cells after it all failed on
# "could not download SHA256SUMS" -- harness faults filed against the product.
# Threaded, with the connection errors swallowed, and restartable.
cat > "$WORK/serve.py" <<'PYSERVE'
import http.server, socketserver, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True
    def handle_error(self, request, client_address): pass

with Server(("127.0.0.1", int(sys.argv[1])), Handler) as httpd:
    httpd.serve_forever()
PYSERVE

MIRROR="http://127.0.0.1:${PORT}"
MIRROR_PROBE="${MIRROR}/dl/download/v${RELEASE_VERSION}/${CHECKSUMS:-SHA256SUMS}"

mirror_up() { curl -fsS -m 10 -o /dev/null "$MIRROR_PROBE" 2>/dev/null; }

start_mirror() {
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
    ( cd "$SITE" && exec python3 "$WORK/serve.py" "$PORT" >>"$WORK/server.log" 2>&1 ) &
    SERVER_PID=$!
    local i
    for i in $(seq 1 60); do
        mirror_up && return 0
        sleep 0.2
    done
    return 1
}

start_mirror || { note "the local release mirror did not come up; see $WORK/server.log"; exit 1; }
note "serving the real v${RELEASE_VERSION} assets at $MIRROR"

# ------------------------------------------------------------- derived images --
#
# Stock debian:12-slim and ubuntu:24.04 ship neither curl nor CA certificates,
# and Alpine ships neither curl nor bash. Those absences are cells of their own;
# for every other cell they would be the only thing measured. Each derived image
# is a thin layer on its base and is cached between runs.
build_image() {
    local tag="$1" dockerfile="$2" platform="${3:-}"
    if docker image inspect "$tag" >/dev/null 2>&1; then return 0; fi
    note "building $tag${platform:+ for $platform}"
    printf '%s\n' "$dockerfile" | docker build -q ${platform:+--platform "$platform"} -t "$tag" - >/dev/null
}

APT='DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*'
build_image "${IMAGE_PREFIX}-debian" "FROM debian:12-slim
RUN $APT
RUN useradd -m -s /bin/bash tester"
build_image "${IMAGE_PREFIX}-ubuntu" "FROM ubuntu:24.04
RUN $APT
RUN useradd -m -s /bin/bash tester"
build_image "${IMAGE_PREFIX}-alpine" "FROM alpine:3.20
RUN apk add --no-cache curl
RUN adduser -D -s /bin/sh tester"
build_image "${IMAGE_PREFIX}-alpine-bash" "FROM alpine:3.20
RUN apk add --no-cache curl bash
RUN adduser -D -s /bin/bash tester"

image_for() {
    case "$1" in
        debian)              echo "debian:12-slim" ;;
        debian+curl)         echo "${IMAGE_PREFIX}-debian" ;;
        ubuntu+curl)         echo "${IMAGE_PREFIX}-ubuntu" ;;
        alpine+curl)         echo "${IMAGE_PREFIX}-alpine" ;;
        alpine+bash)         echo "${IMAGE_PREFIX}-alpine-bash" ;;
        debian+curl+arm64)   echo "${IMAGE_PREFIX}-debian-arm64" ;;
        *)                   echo "$1" ;;
    esac
}
disk_guard "after building images"

# arm64 needs qemu through binfmt_misc. Say so when it is absent instead of
# quietly dropping the cell or, worse, passing it.
# Docker registers the qemu handlers on first use, so the probe is also what
# turns emulation on; a second attempt after a failure is not worth it.
ARM64_REASON=""
if [ "$(docker run --rm --platform linux/arm64 alpine:3.20 uname -m 2>/dev/null | tr -d '\r')" != "aarch64" ]; then
    ARM64_REASON="no working linux/arm64 emulation on this host (needs a qemu-aarch64 binfmt_misc registration)"
else
    build_image "${IMAGE_PREFIX}-debian-arm64" "FROM debian:12-slim
RUN $APT
RUN useradd -m -s /bin/bash tester" linux/arm64
fi

# ----------------------------------------------------------------- run cells --

RESULTS="$WORK/results.tsv"
: > "$RESULTS"
FACETS=(installer onpath loginpath version doctor tui)
LOGS="$WORK/logs"; mkdir -p "$LOGS"

record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$RESULTS"; }

run_cell() {
    local id="$1" imagekey="$2" desc="$3" dockerargs="$4" probeenv="$5"
    local image; image=$(image_for "$imagekey")
    local out="$LOGS/$id.log"

    if [ -n "$ARM64_REASON" ] && case "$id" in arm64*) true ;; *) false ;; esac; then
        for f in "${FACETS[@]}"; do record "$id" "$f" untested "$ARM64_REASON"; done
        printf '  %-22s untested  %s\n' "$id" "$ARM64_REASON"
        return 0
    fi

    # The mirror stands in for GitHub, so a cell run without it measures nothing.
    # Restart it, and if it will not come back say the cell was not tested rather
    # than let a harness fault be recorded as a product failure.
    if ! mirror_up; then
        note "  (the release mirror stopped responding; restarting it before $id)"
        if ! start_mirror; then
            for f in "${FACETS[@]}"; do record "$id" "$f" untested "the local release mirror was unreachable, so this cell was not tested"; done
            printf '  %-22s untested  the local release mirror was unreachable\n' "$id"
            return 0
        fi
    fi

    # A terminal is what the interface needs, so every cell gets one except the
    # cell that is about to prove what happens without it.
    local tty_flag="-t"
    [ "$id" = "no-tty" ] && tty_flag=""

    # Cells that remove a tool do it here rather than in an image, so the
    # difference from the working cell is one line and visible.
    local pre="true" wrapper=""
    case "$id" in
        no-tar)           pre="rm -f /usr/bin/tar /bin/tar" ;;
        umask-077)        pre="umask 077" ;;
        # The musl build is linked against libstdc++, which Alpine does not
        # install by default. This cell is the control for the two above it.
        alpine-libstdcpp) pre="apk add --no-cache libstdc++ >/dev/null" ;;
        # Docker cannot pass an absent variable, and HOME= is an empty HOME
        # rather than no HOME, which the installer treats differently.
        home-unset)       wrapper="env -u HOME" ;;
        # The documented way out of a noexec /tmp, and the directory the runtime
        # fix on wp/2.13-noexec-tmpdir picks for itself.
        noexec-tmp-tmpdir) pre="mkdir -p /var/tmp/rafikicode-exec" ;;
    esac

    local -a extra=()
    # shellcheck disable=SC2206
    [ -n "$dockerargs" ] && extra=($dockerargs)

    local -a env=( --env "MATRIX_VERSION=$RELEASE_VERSION" --env "MATRIX_MIRROR=$MIRROR" --env "MATRIX_TUI_WAIT=$TUI_WAIT" )
    # A cell with no AVX2 would need the baseline archive; nothing here can mask
    # a CPU feature, so that row of the matrix stays untested on this host.
    [ -n "$probeenv" ] && env+=( --env "$probeenv" )
    # A noexec /tmp still has to hold the unpacked binary somewhere, and on a
    # real host that somewhere is /tmp itself. /var/tmp is used only where /tmp
    # has been deliberately made too small, so the cell measures the size and
    # not the unpacking.
    # Emulated cells start the interface a good deal more slowly.
    case "$id" in
        arm64*) env+=( --env "MATRIX_TUI_WAIT=$((TUI_WAIT * 3))" ) ;;
    esac

    local status=0
    # shellcheck disable=SC2086
    docker run --rm $tty_flag \
        --label "$IMAGE_PREFIX" \
        --network host \
        -v "$INSTALLER:/matrix/install.sh:ro" \
        -v "$PROBE:/matrix/probe.sh:ro" \
        "${env[@]}" "${extra[@]}" \
        "$image" \
        sh -c "$pre; exec $wrapper sh /matrix/probe.sh" >"$out" 2>&1 </dev/null || status=$?

    # The probe reports every facet it reached. Anything it did not reach, because
    # the container itself failed to start, is untested rather than failed: a
    # harness fault must not be filed against the product.
    local seen=0
    for f in "${FACETS[@]}"; do
        local line verdict detail
        line=$(grep -a "^MATRIX_RESULT $f " "$out" 2>/dev/null | tail -1 || true)
        if [ -n "$line" ]; then
            verdict=$(printf '%s' "$line" | awk '{print $3}')
            detail=$(printf '%s' "$line" | cut -d' ' -f4-)
            # The interface draws on the terminal, which belongs to this process,
            # not to the probe: the probe can time the run and read stderr but
            # cannot see what was painted. So the last word on the tui facet is
            # here, and it needs the one thing only a running full screen
            # interface does -- switch the terminal to its alternate screen.
            # Without that check a binary that starts, prints nothing and hangs
            # until the clock runs out passes, which is how a build of mine that
            # rendered nothing at all nearly came back green.
            if [ "$f" = "tui" ] && [ "$verdict" = "pass" ] \
               && ! grep -qa "$(printf '\033')\[?1049h" "$out"; then
                verdict=fail
                detail="stayed up but never switched the terminal to its alternate screen, so nothing was drawn"
            fi
            record "$id" "$f" "$verdict" "$detail"
            seen=1
        else
            record "$id" "$f" untested "the probe did not report this facet (container exit $status)"
        fi
    done
    # qemu-user emulates the guest's mappings through its own code, so a guest
    # PROT_EXEC mapping of a file on a noexec mount is not refused the way the
    # kernel refuses it natively: this cell passes under emulation and the same
    # binary on real hardware would not. The arm64 build does unpack the same
    # 14 MiB shared object into the temporary directory -- checked -- so there is
    # no reason to think it is exempt. Untested, therefore, and not a pass.
    if [ "$id" = "arm64-noexec" ]; then
        sed -i "/^$id\ttui\t/d" "$RESULTS"
        record "$id" tui untested "emulation does not enforce noexec on a guest mapping, so this cell cannot answer it; needs real arm64 hardware"
    fi

    # Same check the other way round: if a cell failed complaining about the
    # mirror and the mirror is indeed down, that is this harness, not the product.
    if grep -qa "could not download ${CHECKSUMS:-SHA256SUMS}" "$out" 2>/dev/null && ! mirror_up; then
        note "  (the release mirror died during $id; its result is not usable)"
        sed -i "/^$id\t/d" "$RESULTS"
        for f in "${FACETS[@]}"; do record "$id" "$f" untested "the local release mirror died during this cell, so it was not tested"; done
        printf '  %-22s untested  the release mirror died mid cell\n' "$id"
        start_mirror || true
        disk_guard "after cell $id"
        return 0
    fi

    if [ "$seen" = "0" ]; then
        printf '  %-22s DID NOT RUN (exit %s) %s\n' "$id" "$status" "$(tail -2 "$out" | tr '\n' ' ' | cut -c1-120)"
    else
        local summary=""
        for f in "${FACETS[@]}"; do
            local v; v=$(awk -F'\t' -v i="$id" -v f="$f" '$1==i && $2==f {print $3}' "$RESULTS" | tail -1)
            case "$v" in pass) summary+="." ;; fail) summary+="X" ;; *) summary+="-" ;; esac
        done
        printf '  %-22s %s  %s\n' "$id" "$summary" "$desc"
    fi
    disk_guard "after cell $id"
}

note ""
note "cells (. pass  X fail  - untested, in order: ${FACETS[*]})"
ran=0
for c in "${cells[@]}"; do
    id=$(cell_field "$c" 1)
    if [ -n "$only" ] && [[ "$id" != *"$only"* ]]; then continue; fi
    run_cell "$id" "$(cell_field "$c" 2)" "$(cell_field "$c" 3)" "$(cell_field "$c" 4)" "$(cell_field "$c" 5)"
    ran=$((ran + 1))
done
[ "$ran" = "0" ] && { note "no cell matched --only $only"; exit 1; }

# -------------------------------------------------------------------- report --

echo
echo "================================ install matrix ================================"
printf '%-22s%-11s%-10s%-11s%-9s%-9s%-9s\n' CELL "${FACETS[@]}"
for c in "${cells[@]}"; do
    id=$(cell_field "$c" 1)
    awk -F'\t' -v i="$id" '$1==i' "$RESULTS" >/dev/null 2>&1 || continue
    grep -q "^$id	" "$RESULTS" || continue
    line=$(printf '%-22s' "$id")
    for f in "${FACETS[@]}"; do
        v=$(awk -F'\t' -v i="$id" -v f="$f" '$1==i && $2==f {print $3}' "$RESULTS" | tail -1)
        line+=$(printf '%-10s ' "${v:-untested}")
    done
    echo "$line"
done
echo

echo "failures, with what the user would see:"
fails=$(awk -F'\t' '$3=="fail"' "$RESULTS" || true)
if [ -z "$fails" ]; then
    echo "  none"
else
    while IFS=$'\t' read -r id facet _ detail; do
        printf '  %-22s %-10s %s\n' "$id" "$facet" "$detail"
    done <<< "$fails"
fi
echo
echo "untested, and why:"
untested=$(awk -F'\t' '$3=="untested" || $3=="skip"' "$RESULTS" || true)
if [ -z "$untested" ]; then
    echo "  none"
else
    while IFS=$'\t' read -r id facet _ detail; do
        printf '  %-22s %-10s %s\n' "$id" "$facet" "$detail"
    done <<< "$untested"
fi

# Copied out before the trap removes the work directory. Written whatever the
# verdicts are, because a gate that only ever sees the good runs is not a gate.
if [ -n "$results_out" ]; then
    cp "$RESULTS" "$results_out"
    note "verdicts written to $results_out"
fi

p=$(awk -F'\t' '$3=="pass"' "$RESULTS" | wc -l | tr -d ' ')
f=$(awk -F'\t' '$3=="fail"' "$RESULTS" | wc -l | tr -d ' ')
u=$(awk -F'\t' '$3=="untested" || $3=="skip"' "$RESULTS" | wc -l | tr -d ' ')
echo
echo "install matrix: ${p} passed, ${f} failed, ${u} untested"
note "disk after: $(df -h / | awk 'NR==2{print $4" free on / ("$5" used)"}')"

# Logs outlive the run only when asked for, since they sit in the work directory.
if [ "$keep" = "true" ]; then
    cp -r "$LOGS" "./matrix-logs-$$" && note "per cell logs in ./matrix-logs-$$"
fi

[ "$f" = "0" ]
