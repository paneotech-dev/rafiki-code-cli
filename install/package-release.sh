#!/usr/bin/env bash
# Packs the built binaries into the archives a release publishes, and writes
# their SHA256SUMS.
#
#   install/package-release.sh <dist directory>
#
# <dist> is what packages/opencode/script/build.ts leaves behind: one directory
# per build, rafikicode-<target>/bin/, holding the binary. Each becomes
# rafikicode-<target>.tar.gz (Linux) or .zip (macOS, Windows) in <dist>, with
# the binary at the root of the archive and LICENSE and NOTICE beside it.
#
# The licence files are packed here because this is the one place every channel
# passes through: the installers, the npm package, the Homebrew formula and the
# winget manifest all install these archives, so a copy that arrives by any of
# them arrives with the notice the upstream licence requires. The archives used
# to hold the binary alone.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
dist="${1:?usage: package-release.sh <dist directory>}"
[ -d "$dist" ] || { echo "no such directory: $dist" >&2; exit 1; }
for file in LICENSE NOTICE; do
    [ -s "$ROOT/$file" ] || { echo "$ROOT/$file is missing: refusing to pack a release without it" >&2; exit 1; }
done

cd "$dist"
stage=$(mktemp -d "${TMPDIR:-/tmp}/rafikicode-package.XXXXXX")
trap 'rm -rf "$stage"' EXIT

count=0
for dir in rafikicode-*/; do
    name="${dir%/}"
    [ -d "$name/bin" ] || continue
    mkdir -p "$stage/$name"
    cp -R "$name/bin/." "$stage/$name/"
    cp "$ROOT/LICENSE" "$ROOT/NOTICE" "$stage/$name/"
    case "$name" in
        *linux*) rm -f "${name}.tar.gz"; tar -czf "${name}.tar.gz" -C "$stage/$name" . ;;
        *) rm -f "${name}.zip"; (cd "$stage/$name" && zip -qr "$OLDPWD/${name}.zip" .) ;;
    esac
    count=$((count + 1))
done
[ "$count" -gt 0 ] || { echo "no rafikicode-*/bin directory in $dist: build first" >&2; exit 1; }

shopt -s nullglob
archives=(rafikicode-*.tar.gz rafikicode-*.zip)
if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${archives[@]}" > SHA256SUMS
else
    shasum -a 256 "${archives[@]}" > SHA256SUMS
fi
cat SHA256SUMS
