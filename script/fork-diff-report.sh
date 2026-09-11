#!/usr/bin/env bash
# Diff-to-core report for the rafikicode fork.
# Lists every file that differs from the upstream default branch, grouped into
# the brand layer (files that only exist in this fork) and core files touched
# (upstream files modified, renamed, or removed), with line counts per file.
# Usage: script/fork-diff-report.sh [upstream-ref] > report.md
set -euo pipefail

ref="${1:-upstream/dev}"
base="$(git merge-base "$ref" HEAD)"

numstat="$(git diff --numstat -M "$base" HEAD)"
status="$(git diff --name-status -M "$base" HEAD)"

echo "# Diff to core report"
echo
echo "Upstream ref: $ref (merge base $(git rev-parse --short "$base"))"
echo "Fork head: $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD))"
echo "Generated: $(date -u +%Y-%m-%dT%H:%MZ)"
echo

section() {
  local title="$1" filter="$2" total_add=0 total_del=0 count=0
  echo "## $title"
  echo
  echo "| file | added | removed |"
  echo "|---|---:|---:|"
  while IFS=$'\t' read -r code path rest; do
    [ -z "${code:-}" ] && continue
    case "$code" in
      $filter) ;;
      *) continue ;;
    esac
    shown="$path"
    [ -n "${rest:-}" ] && shown="$path -> $rest"
    line="$(printf '%s\n' "$numstat" | awk -F'\t' -v p="$path" -v r="${rest:-}" '($3 == p && r == "") || ($3 == p && $4 == r) || ($3 ~ "=> " r "}$") || ($3 == p " => " r) {print $1 "\t" $2; exit}')"
    add="${line%%$'\t'*}"; del="${line##*$'\t'}"
    [ -z "$add" ] && add=0
    [ -z "$del" ] && del=0
    [ "$add" = "-" ] && add=0
    [ "$del" = "-" ] && del=0
    total_add=$((total_add + add)); total_del=$((total_del + del)); count=$((count + 1))
    echo "| $shown | $add | $del |"
  done <<< "$status"
  echo "| total ($count files) | $total_add | $total_del |"
  echo
}

section "Brand layer (files that only exist in the fork)" "A"
section "Core files touched (upstream files modified, renamed, or removed)" "[MRD]*"
