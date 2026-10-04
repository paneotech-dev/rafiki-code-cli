#!/usr/bin/env bash
# The release gate for one published build.
#
# Takes the archives a release is about to publish, starts a clean environment
# for the platform of one of them, installs that build the way a user does, and
# checks five things: the install, --version, the licence files, a sign-in with
# the staging test credential, and one hello world task against staging. Any
# facet that is not a pass fails the gate, and a failed gate blocks the release
# (.github/workflows/release.yml runs one of these per published build and
# publishes only when all of them are green).
#
# Why it exists. v0.1.7 published twelve builds on the strength of one
# --version run on the build host. install/test-matrix.sh then covered the
# machines users have, for three of the twelve archives and after they were
# public. This runs before anything is public, for every archive, and goes as
# far as a real model call, because an install can be perfect and the product
# still unable to do its one job.
#
# Usage:
#   install/release-gate.sh --target linux-x64 --version 0.2.0 --assets DIR
#   install/release-gate.sh --target darwin-arm64 --version 0.2.0 --assets DIR --host
#   install/release-gate.sh --target linux-x64 --version 0.2.0 --assets DIR \
#       --channel npm --npm-tarball rafikicode-0.2.0.tgz
#
#   --assets DIR      the release archives and their SHA256SUMS
#   --host            run on this machine instead of in a container (macOS
#                     runners, which are a fresh virtual machine per job)
#   --image IMAGE     container image, when the default for the target is wrong
#   --channel NAME    installer (default) or npm
#   --results FILE    also write target, channel, facet, verdict, detail as TSV
#   --no-live         a pre-release without the staging key: skip the two
#                     facets that call staging (signin, task) and run the rest
#
# The staging test credential is read from RAFIKICODE_STAGING_API_KEY and
# nowhere else. Without it the gate stops before doing anything, with exit 2:
# a gate that skips the sign-in when the secret is missing passes exactly the
# release it exists to stop. RAFIKICODE_STAGING_GATEWAY_URL and
# RAFIKICODE_STAGING_CONSOLE_URL point the build at staging when staging is not
# the product default.
#
# --no-live is the one exception, and it is explicit: the release workflow
# passes it only for a pre-release when the secret is not configured. It is
# refused for a version without a pre-release part and when a key is set, and
# signin and task are then recorded as "skipped (no staging key, pre-release)",
# never as a pass. A missing key without --no-live still stops the gate.
#
# Windows builds are gated by install/release-gate.ps1, which does the same
# with install.ps1.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PROBE="$HERE/release-gate-probe.sh"
INSTALLER="$HERE/install.sh"
PORT="${PORT:-4170}"
MIN_FREE_MIB="${RAFIKICODE_GATE_MIN_FREE_MIB:-2048}"
IMAGE_PREFIX=rafikicode-gate
FACETS=(install version licence signin task)
LIVE_FACETS=" signin task "
SKIPPED_VERDICT="skipped (no staging key, pre-release)"

target=""
version=""
assets=""
channel=installer
image=""
host=false
results_out=""
npm_tarball=""
live=true
while [[ $# -gt 0 ]]; do
    case "$1" in
        --target)      target="${2:?--target needs a build name}"; shift 2 ;;
        --version)     version="${2:?--version needs a version}"; shift 2 ;;
        --assets)      assets="${2:?--assets needs a directory}"; shift 2 ;;
        --channel)     channel="${2:?--channel needs installer or npm}"; shift 2 ;;
        --image)       image="${2:?--image needs an image name}"; shift 2 ;;
        --npm-tarball) npm_tarball="${2:?--npm-tarball needs a path}"; shift 2 ;;
        --results)     results_out="${2:?--results needs a path}"; shift 2 ;;
        --host)        host=true; shift ;;
        --no-live)     live=false; shift ;;
        -h|--help)     sed -n '2,48p' "$0"; exit 0 ;;
        *) echo "unknown option '$1'" >&2; exit 2 ;;
    esac
done

note() { printf '%s\n' "$*" >&2; }
die() { note "release gate: $*"; exit 2; }

[ -n "$target" ] || die "--target is required"
[ -n "$assets" ] && [ -d "$assets" ] || die "--assets must name the directory holding the release archives"
version="${version#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "--version must be the version being released, for example 0.2.0"
case "$channel" in installer|npm) ;; *) die "--channel must be installer or npm" ;; esac
case "$target" in
    linux-x64|linux-x64-baseline|linux-x64-musl|linux-x64-baseline-musl|linux-arm64|linux-arm64-musl) ext=.tar.gz ;;
    darwin-arm64|darwin-x64|darwin-x64-baseline) ext=.zip ;;
    windows-*) die "Windows builds are gated by install/release-gate.ps1" ;;
    *) die "${target} is not a build this product publishes" ;;
esac
archive="rafikicode-${target}${ext}"

# Fail closed, before anything else is done, and name the secret.
if [ "$live" = "false" ]; then
    # Skipping the live facets is asked for, never inferred from an empty key.
    [[ "$version" == *-* ]] || die "--no-live is for a pre-release only, and ${version} has no pre-release part: a release is gated against staging"
    [ -z "${RAFIKICODE_STAGING_API_KEY:-}" ] || die "--no-live was given while RAFIKICODE_STAGING_API_KEY is set: drop --no-live to run the live facets, or unset the key"
    note "release gate: --no-live, a pre-release without the staging key: signin and task are skipped, every other facet runs."
elif [ -z "${RAFIKICODE_STAGING_API_KEY:-}" ]; then
    note "release gate: RAFIKICODE_STAGING_API_KEY is not set."
    note "  The gate signs in with a staging test account and runs one task against"
    note "  staging. Without that credential it cannot say the build works, so it"
    note "  does not run and the release is blocked. Add the repository secret"
    note "  RAFIKICODE_STAGING_API_KEY (an API key of the staging test account,"
    note "  created with the Rafiki Code option ticked)."
    exit 2
fi

[ -f "$assets/SHA256SUMS" ] || die "no SHA256SUMS in ${assets}"
[ -f "$assets/$archive" ] || die "no ${archive} in ${assets}: the build for ${target} was not produced"
command -v python3 >/dev/null 2>&1 || die "python3 is required to serve the release assets"
if [ "$channel" = "npm" ]; then
    [ -n "$npm_tarball" ] && [ -f "$npm_tarball" ] || die "--channel npm needs --npm-tarball, the packed npm package"
fi

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}
# What is gated is what is published: the archive must be the one SHA256SUMS names.
expected=$(awk -v f="$archive" '$2 == f || $2 == "*" f {print tolower($1)}' "$assets/SHA256SUMS" | head -n 1)
[ -n "$expected" ] || die "SHA256SUMS has no entry for ${archive}"
actual=$(sha256_of "$assets/$archive")
[ "$actual" = "$expected" ] || die "${archive} does not match SHA256SUMS (expected ${expected}, got ${actual})"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/rafikicode-gate.XXXXXX")
SERVER_PID=""
cleanup() {
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
    rm -rf "$WORK"
    if [ "$host" = "false" ]; then
        docker ps -aq --filter "label=${IMAGE_PREFIX}" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

free_mib() { df -Pm "$1" | awk 'NR==2{print $4}'; }
if [ "$(free_mib /)" -lt "$MIN_FREE_MIB" ]; then
    die "/ has $(free_mib /) MiB free, below the ${MIN_FREE_MIB} MiB floor. Nothing was tested."
fi

# ------------------------------------------------- local mirror of the release --
#
# GitHub's layout, served from loopback: the installer script, the release API
# answer for "latest", and the archives with their checksums. What the gate
# installs is byte for byte what the publish job uploads afterwards.
SITE="$WORK/site"
mkdir -p "$SITE/api/releases" "$SITE/dl/download/v${version}"
printf '{"tag_name": "v%s", "name": "v%s"}\n' "$version" "$version" > "$SITE/api/releases/latest"
cp "$INSTALLER" "$SITE/install.sh"
ln -s "$(cd "$assets" && pwd)/SHA256SUMS" "$SITE/dl/download/v${version}/SHA256SUMS"
ln -s "$(cd "$assets" && pwd)/$archive" "$SITE/dl/download/v${version}/$archive"

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
( cd "$SITE" && exec python3 "$WORK/serve.py" "$PORT" >>"$WORK/server.log" 2>&1 ) &
SERVER_PID=$!
up=false
for _ in $(seq 1 60); do
    if curl -fsS -m 5 -o /dev/null "${MIRROR}/dl/download/v${version}/SHA256SUMS" 2>/dev/null; then up=true; break; fi
    sleep 0.2
done
[ "$up" = "true" ] || die "the local release mirror did not come up on port ${PORT} (set PORT to a free one)"

# ---------------------------------------------------------------- environment --

LOG="$WORK/probe.log"
probe_env=(
    "GATE_TARGET=$target" "GATE_VERSION=$version" "GATE_MIRROR=$MIRROR" "GATE_CHANNEL=$channel"
)
if [ "$live" = "true" ]; then
    probe_env+=("RAFIKICODE_API_KEY=$RAFIKICODE_STAGING_API_KEY")
else
    probe_env+=("GATE_LIVE=0")
fi
[ -n "${RAFIKICODE_STAGING_GATEWAY_URL:-}" ] && probe_env+=("RAFIKICODE_GATEWAY_URL=$RAFIKICODE_STAGING_GATEWAY_URL")
[ -n "${RAFIKICODE_STAGING_CONSOLE_URL:-}" ] && probe_env+=("RAFIKICODE_CONSOLE_URL=$RAFIKICODE_STAGING_CONSOLE_URL")
[ -n "${GATE_PROMPT:-}" ] && probe_env+=("GATE_PROMPT=$GATE_PROMPT")
[ -n "${GATE_EXPECT:-}" ] && probe_env+=("GATE_EXPECT=$GATE_EXPECT")
[ -n "${GATE_TASK_TIMEOUT:-}" ] && probe_env+=("GATE_TASK_TIMEOUT=$GATE_TASK_TIMEOUT")

status=0
if [ "$host" = "true" ]; then
    # A hosted macOS runner is a new virtual machine for every job. The home
    # directory is still replaced, so the install starts from nothing whatever
    # the image came with.
    home="$WORK/home"
    mkdir -p "$home"
    [ "$channel" = "npm" ] && probe_env+=("GATE_NPM_TARBALL=$npm_tarball" "npm_config_prefix=$home/.npm-global")
    # The variables are arguments of env here, which a process list shows for
    # as long as the probe runs. The machine is the job's own and is destroyed
    # with it; the container path below passes them by name instead.
    # /usr/local/bin is taken off PATH for the same reason the installer suite
    # does it: the installer links the binary into the first directory of
    # /usr/local/bin and ~/.local/bin that is on PATH and writable, and a gate
    # run must not leave a link behind on the machine it ran on, pointing into
    # a work directory that is about to be deleted.
    safe_path=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/usr/local/bin/*$' | paste -sd: -)
    env -i PATH="$safe_path" HOME="$home" TMPDIR="${TMPDIR:-/tmp}" "${probe_env[@]}" sh "$PROBE" >"$LOG" 2>&1 || status=$?
else
    command -v docker >/dev/null 2>&1 || die "docker is required (or use --host on a fresh machine)"
    docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"

    # The clean image for the platform, with only what the documented install
    # command itself needs: curl and CA certificates on Debian, plus bash on
    # Alpine and the C++ runtime the musl build is linked against.
    build_image() {
        local tag="$1" dockerfile="$2"
        docker image inspect "$tag" >/dev/null 2>&1 && return 0
        note "building $tag"
        printf '%s\n' "$dockerfile" | docker build -q -t "$tag" - >/dev/null
    }
    if [ -z "$image" ]; then
        if [ "$channel" = "npm" ]; then
            image="node:22-bookworm-slim"
        else
            case "$target" in
                *-musl)
                    image="${IMAGE_PREFIX}-alpine"
                    build_image "$image" "FROM alpine:3.20
RUN apk add --no-cache curl bash libstdc++ libgcc"
                    ;;
                *)
                    image="${IMAGE_PREFIX}-debian"
                    build_image "$image" "FROM debian:12-slim
RUN DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*"
                    ;;
            esac
        fi
    fi

    docker_env=()
    for pair in "${probe_env[@]}"; do
        # Exported here and passed to docker by name only, so the credential is
        # never an argument on a command line.
        export "${pair%%=*}=${pair#*=}"
        docker_env+=(--env "${pair%%=*}")
    done
    mounts=(-v "$PROBE:/gate/probe.sh:ro")
    if [ "$channel" = "npm" ]; then
        mounts+=(-v "$(cd "$(dirname "$npm_tarball")" && pwd)/$(basename "$npm_tarball"):/gate/$(basename "$npm_tarball"):ro")
        docker_env+=(--env "GATE_NPM_TARBALL=/gate/$(basename "$npm_tarball")")
    fi
    # The host network namespace, so the container reaches the mirror on
    # 127.0.0.1; nothing else is shared with it.
    docker run --rm --label "$IMAGE_PREFIX" --network host \
        "${mounts[@]}" "${docker_env[@]}" \
        "$image" sh /gate/probe.sh >"$LOG" 2>&1 </dev/null || status=$?
fi

# -------------------------------------------------------------------- verdict --

# The credential is not echoed by the probe; this is the belt to that brace.
GATE_REDACT="${RAFIKICODE_STAGING_API_KEY:-}" awk '
    BEGIN { key = ENVIRON["GATE_REDACT"]; n = length(key) }
    {
        while (n > 0 && (i = index($0, key)) > 0) $0 = substr($0, 1, i - 1) "[staging credential]" substr($0, i + n)
        print
    }' "$LOG"

RESULTS="$WORK/results.tsv"
: > "$RESULTS"
failed=0
skipped=0
echo
echo "release gate: ${target} ${version} via ${channel} ($([ "$host" = "true" ] && echo "this machine" || echo "$image"))"
for f in "${FACETS[@]}"; do
    line=$(grep -a "^GATE_RESULT $f " "$LOG" 2>/dev/null | tail -1 || true)
    if [ -n "$line" ]; then
        verdict=$(printf '%s' "$line" | awk '{print $3}')
        detail=$(printf '%s' "$line" | cut -d' ' -f4-)
    else
        # Not reached is not known, and not known does not ship.
        verdict=fail
        detail="the probe did not report this facet (exit ${status})"
    fi
    if [ "$verdict" = "skipped" ] && [ "$live" = "false" ] && [[ "$LIVE_FACETS" == *" $f "* ]]; then
        verdict="$SKIPPED_VERDICT"
        skipped=$((skipped + 1))
    elif [ "$verdict" != "pass" ]; then
        verdict=fail
        failed=$((failed + 1))
    fi
    printf '%s\t%s\t%s\t%s\t%s\n' "$target" "$channel" "$f" "$verdict" "$detail" >> "$RESULTS"
    printf '  %-8s %-5s %s\n' "$f" "$verdict" "$detail"
done
[ -n "$results_out" ] && cp "$RESULTS" "$results_out"

if [ "$failed" != "0" ]; then
    echo "release gate: ${target} FAILED (${failed} of ${#FACETS[@]} facets). This build blocks the release."
    exit 1
fi
if [ "$skipped" != "0" ]; then
    echo "release gate: ${target} passed $(( ${#FACETS[@]} - skipped )) of ${#FACETS[@]} facets; signin and task were ${SKIPPED_VERDICT}."
    exit 0
fi
echo "release gate: ${target} passed all ${#FACETS[@]} facets."
