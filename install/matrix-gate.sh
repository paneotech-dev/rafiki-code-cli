#!/usr/bin/env bash
# Judges one install matrix run against what the matrix is known to do, and
# renders the result for a person to read.
#
#   install/matrix-gate.sh --results run.tsv [--expectations install/matrix-expectations.tsv]
#                          [--markdown INSTALL-MATRIX.md] [--version 0.1.7] [--where "ubuntu-24.04 hosted runner"]
#                          [--subset]
#
# --subset is for a run made with test-matrix.sh --only: cells the run did not
# attempt at all are left out of the judging instead of counting as missing, and
# the record names them so that nobody reads a green subset as a green matrix.
#
# Why this is not just the harness's exit status. install/test-matrix.sh exits
# non-zero when any facet failed, and several cells are built to fail: a machine
# with no bash cannot run a bash installer, a machine with no tar cannot unpack
# an archive. Those failures are the recorded truth about those machines, so a
# run that reproduces them is a correct run, and a gate keyed on the exit status
# alone would be red forever and then switched off.
#
# So every cell and facet has a recorded expectation, and this compares against
# it. The three verdicts stay three all the way through:
#
#   pass      the facet was exercised and worked
#   fail      the facet was exercised and did not work
#   untested  the facet was not exercised, so nothing is known about it
#
# untested is never folded into pass. A cell that was expected to pass and came
# back untested fails this gate, because "we could not check" and "we checked
# and it was fine" are the two things that were confused when v0.1.7 shipped
# twelve binaries on the strength of one --version run.
#
# Two rules sit above the expectations file and cannot be edited out of it:
#
#   * The cells in REQUIRED_CELLS must come back pass on every facet. They are
#     the customer incident -- a noexec /tmp, where the native render library
#     cannot be mapped and the terminal interface dies while the install, the
#     PATH, --version, doctor, the sign in and the billing all report success.
#     Nothing about that cell is optional and no expectation file can excuse it.
#
#   * Any result that is not the recorded one fails, in both directions. A cell
#     that starts passing is as much a change as one that starts failing, and the
#     fix belongs in the same commit as the new expectation.
#
# The one tolerated deviation is EMULATION_CELLS coming back untested: an
# arm64 cell needs a qemu binfmt registration that a given runner may not have,
# and failing every run over an absent emulator is how a matrix gets disabled.
# Tolerated means reported as untested and warned about -- never counted as a
# pass, and never silent.
set -euo pipefail

# The incident. Not negotiable, not in a data file.
REQUIRED_CELLS="noexec-tmp noexec-tmp-nonroot noexec-tmp-tmpdir"
# Cells that need an emulator the runner may not have. Untested here is
# tolerated and loud; a fail here is still a fail.
EMULATION_CELLS="arm64-root arm64-noexec"

results=""
expectations=""
markdown=""
version=""
where=""
subset=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --results)      results="${2:?--results needs a path}"; shift 2 ;;
        --expectations) expectations="${2:?--expectations needs a path}"; shift 2 ;;
        --markdown)     markdown="${2:?--markdown needs a path}"; shift 2 ;;
        --version)      version="${2:-}"; shift 2 ;;
        --where)        where="${2:-}"; shift 2 ;;
        --subset)       subset=true; shift ;;
        -h|--help)      sed -n '2,15p' "$0"; exit 0 ;;
        *) echo "unknown option '$1'" >&2; exit 1 ;;
    esac
done

HERE=$(cd "$(dirname "$0")" && pwd)
: "${expectations:=$HERE/matrix-expectations.tsv}"
[ -n "$results" ] || { echo "--results is required" >&2; exit 2; }
[ -s "$results" ] || { echo "no verdicts in $results: the matrix did not get far enough to report anything" >&2; exit 1; }
[ -s "$expectations" ] || { echo "no expectations at $expectations" >&2; exit 2; }

in_list() { case " $2 " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# The probe says skip for a facet it could not reach and the driver says
# untested for a cell it could not run. They mean the same thing to a reader and
# the harness already counts them together, so normalise once, here.
norm() { case "$1" in skip) echo untested ;; *) echo "$1" ;; esac; }

verdict_of() { awk -F'\t' -v c="$1" -v f="$2" '$1==c && $2==f {v=$3} END{print v}' "$results"; }
detail_of()  { awk -F'\t' -v c="$1" -v f="$2" '$1==c && $2==f {d=$4} END{print d}' "$results"; }

# Expectations drive the walk, so a cell the harness skipped entirely is a
# missing row rather than an absent one.
mapfile -t rows < <(grep -v '^[[:space:]]*#' "$expectations" | grep -v '^[[:space:]]*$')
# The rendered table covers both files, so a cell the run reported and nothing
# recorded still appears rather than being quietly left out of the picture.
cells=$(printf '%s\n' "${rows[@]}" | cut -f1; cut -f1 "$results")
cells=$(printf '%s\n' "$cells" | awk 'NF && !seen[$0]++')
facets=$(printf '%s\n' "${rows[@]}" | cut -f2; cut -f2 "$results")
facets=$(printf '%s\n' "$facets" | awk 'NF && !seen[$0]++')

problems=()
warnings=()
notrun=()
n_pass=0; n_fail=0; n_untested=0; n_missing=0

ran_cell() { awk -F'\t' -v c="$1" '$1==c {found=1} END{exit !found}' "$results"; }

for row in "${rows[@]}"; do
    cell=$(printf '%s' "$row" | cut -f1)
    facet=$(printf '%s' "$row" | cut -f2)
    expected=$(printf '%s' "$row" | cut -f3)
    got=$(norm "$(verdict_of "$cell" "$facet")")
    detail=$(detail_of "$cell" "$facet")

    # A --only run attempted some of the cells. The rest are not missing
    # results, they were never asked for; they are also not passes.
    if [ "$subset" = "true" ] && ! ran_cell "$cell"; then
        case " ${notrun[*]-} " in *" $cell "*) : ;; *) notrun+=("$cell") ;; esac
        continue
    fi

    if [ -z "$got" ]; then
        n_missing=$((n_missing + 1))
        problems+=("$cell/$facet: the run reported nothing at all (expected $expected). The cell did not run, so it is untested, not passed.")
        continue
    fi
    case "$got" in
        pass)     n_pass=$((n_pass + 1)) ;;
        fail)     n_fail=$((n_fail + 1)) ;;
        untested) n_untested=$((n_untested + 1)) ;;
        *) problems+=("$cell/$facet: unrecognised verdict '$got'") ;;
    esac

    if in_list "$cell" "$REQUIRED_CELLS" && [ "$got" != "pass" ]; then
        problems+=("$cell/$facet: $got -- this cell is the noexec /tmp customer incident and must pass. ${detail:-no detail}")
        continue
    fi
    [ "$got" = "$expected" ] && continue

    if [ "$got" = "untested" ] && in_list "$cell" "$EMULATION_CELLS"; then
        warnings+=("$cell/$facet: untested on this runner, expected $expected. ${detail:-no detail}")
        continue
    fi
    case "$expected/$got" in
        pass/fail)     problems+=("$cell/$facet: REGRESSION, was passing. ${detail:-no detail}") ;;
        pass/untested) problems+=("$cell/$facet: NOT TESTED, and it used to be. A green run here would be a lie. ${detail:-no detail}") ;;
        fail/pass)     problems+=("$cell/$facet: now passes, which the recorded expectation says it should not. If that is a fix, record it in $(basename "$expectations") in the same change.") ;;
        fail/untested) problems+=("$cell/$facet: NOT TESTED; it was a known failure and now nothing is known. ${detail:-no detail}") ;;
        untested/*)    problems+=("$cell/$facet: $got, recorded as untested. Something started working or started being measured; record it in $(basename "$expectations").") ;;
        *)             problems+=("$cell/$facet: $got, expected $expected. ${detail:-no detail}") ;;
    esac
done

# A cell the harness grew without anyone recording what it should do would
# otherwise never be looked at.
while IFS=$'\t' read -r cell facet _ _; do
    [ -n "$cell" ] || continue
    if ! awk -F'\t' -v c="$cell" -v f="$facet" '$1==c && $2==f {found=1} END{exit !found}' <<< "$(printf '%s\n' "${rows[@]}")"; then
        problems+=("$cell/$facet: the run reports this and nothing records what it should do. Add it to $(basename "$expectations").")
    fi
done < "$results"

# ------------------------------------------------------------------ rendering --

render() {
    local header_width=22
    echo "# Install matrix${version:+ for $version}"
    echo
    echo "Ran $(date -u '+%Y-%m-%d %H:%M UTC')${where:+ on $where}. Every cell is"
    echo "install/install.sh plus the real published release archives, run in a"
    echo "container shaped like a machine a user actually has."
    echo
    echo "A facet is \`pass\` when it was exercised and worked, \`fail\` when it was"
    echo "exercised and did not, and \`untested\` when it was not exercised at all."
    echo "\`untested\` is not a pass and this run claims nothing about it."
    echo
    printf '| cell |'; for f in $facets; do printf ' %s |' "$f"; done; echo
    printf '| --- |'; for f in $facets; do printf ' --- |'; done; echo
    for cell in $cells; do
        printf '| %s |' "$cell"
        for f in $facets; do
            v=$(norm "$(verdict_of "$cell" "$f")")
            printf ' %s |' "${v:-untested}"
        done
        echo
    done
    echo
    echo "${n_pass} passed, ${n_fail} failed, $((n_untested + n_missing)) untested."
    echo
    echo "The three \`noexec-tmp\` cells are the customer incident -- a temporary"
    echo "directory mounted \`noexec\`, where the install, the \`PATH\`, \`--version\`,"
    echo "\`doctor\`, the sign in and the billing all report success and the program"
    echo "still cannot start. Every facet of them must be \`pass\`, and a run where"
    echo "any of them is not is refused whatever else it achieved."
    echo
    if [ ${#problems[@]} -gt 0 ]; then
        echo "**This run was refused**: ${#problems[@]} facet(s) did not do what they are"
        echo "recorded to do. See the list below and the workflow log."
    else
        echo "This run matched the record for every cell it was able to run."
    fi
    echo
    if [ ${#notrun[@]} -gt 0 ]; then
        echo "**This was a partial run.** ${#notrun[@]} cell(s) were not attempted at all and"
        echo "nothing here speaks for them: ${notrun[*]}."
        echo
    fi

    local any
    any=$(awk -F'\t' '$3=="fail"' "$results" || true)
    echo "## Failures, with what the user would see"
    echo
    echo "\`recorded\` means install/matrix-expectations.tsv already says this is what"
    echo "that machine does; read the note there for whether it is an open defect or a"
    echo "refusal the installer is right to make. Anything else is new."
    echo
    if [ -z "$any" ]; then
        echo "None."
    else
        while IFS=$'\t' read -r cell facet _ detail; do
            exp=$(awk -F'\t' -v c="$cell" -v f="$facet" '$1==c && $2==f {print $3}' <(grep -v '^[[:space:]]*#' "$expectations") | tail -1)
            local tag="**NOT EXPECTED**"
            [ "$exp" = "fail" ] && tag="recorded"
            echo "- \`$cell\` / \`$facet\` (${tag}): ${detail:-no detail}"
        done <<< "$any"
    fi
    echo

    any=$(awk -F'\t' '$3=="untested" || $3=="skip"' "$results" || true)
    echo "## Untested, and why"
    echo
    if [ -z "$any" ]; then
        echo "Nothing was left untested."
    else
        while IFS=$'\t' read -r cell facet _ detail; do
            echo "- \`$cell\` / \`$facet\`: ${detail:-no reason recorded}"
        done <<< "$any"
    fi
    if [ "$n_missing" -gt 0 ]; then
        echo
        echo "$n_missing recorded facet(s) were not reported by this run at all; see the gate output."
    fi
    echo
    echo "## Which published archives this run actually started"
    echo
    echo "Twelve binary archives are published. Every cell above runs a Linux"
    echo "container, so three of the twelve are all that any cell can install:"
    echo
    echo "| archive | started by a cell | why not |"
    echo "| --- | --- | --- |"
    echo "| rafikicode-linux-x64 | yes | - |"
    echo "| rafikicode-linux-x64-musl | yes | - |"
    echo "| rafikicode-linux-arm64 | yes, under emulation | no arm64 hardware here |"
    echo "| rafikicode-linux-arm64-musl | no | no musl arm64 cell exists |"
    echo "| rafikicode-linux-x64-baseline | no | the installer asks for it only on a CPU without AVX2, and nothing here can mask a CPU feature |"
    echo "| rafikicode-linux-x64-baseline-musl | no | as above |"
    echo "| rafikicode-darwin-arm64 | no | no cell runs macOS |"
    echo "| rafikicode-darwin-x64 | no | no cell runs macOS |"
    echo "| rafikicode-darwin-x64-baseline | no | no cell runs macOS |"
    echo "| rafikicode-windows-arm64 | no | no cell runs Windows |"
    echo "| rafikicode-windows-x64 | no | no cell runs Windows |"
    echo "| rafikicode-windows-x64-baseline | no | no cell runs Windows |"
    echo
    echo "Nine of the twelve are therefore published and never started by this"
    echo "matrix. A green table above is a statement about three archives, not"
    echo "twelve. \`PLATFORM-COVERAGE.md\`, beside this file, says which of them the"
    echo "build host managed to start at all, which is the other end of the same"
    echo "question; between the two files, a published archive that nothing has"
    echo "ever run is named rather than assumed."
    echo
    echo "## What this run still does not cover"
    echo
    echo "- x64 CPUs without AVX2. The four \`-baseline\` archives exist for them,"
    echo "  the installer selects one by reading \`avx2\` out of \`/proc/cpuinfo\`,"
    echo "  and nothing in a container can take that flag away, so the selection"
    echo "  is never exercised and the archives are never started. In v0.1.7 all"
    echo "  four were byte identical to the siblings they exist to replace."
    echo "- Real arm64 hardware. Every arm64 verdict above is qemu-user, and"
    echo "  qemu-user emulates the guest's mappings through its own code: a guest"
    echo "  \`PROT_EXEC\` mapping of a file on a \`noexec\` mount is not refused the"
    echo "  way the kernel refuses it natively. A hosted CI runner registers the"
    echo "  same qemu-user through binfmt_misc and so offers the same false"
    echo "  comfort. That is why \`arm64-noexec\` reports its \`tui\` facet untested"
    echo "  whatever it did: it passed once, for the wrong reason, and was"
    echo "  demoted. The arm64 passes mean the archive links and draws under"
    echo "  emulation, nothing more."
    echo "- macOS and Windows, and \`install.ps1\` with them. The archives are"
    echo "  published; no cell starts them."
    echo "- The unit and brand suites. This job runs the matrix and nothing else;"
    echo "  .github/workflows/test.yml runs those."
}

if [ -n "$markdown" ]; then
    render > "$markdown"
    echo "wrote $markdown" >&2
fi

echo
echo "================================= matrix gate ================================="
echo "verdicts: ${n_pass} pass, ${n_fail} fail, ${n_untested} untested, ${n_missing} not reported"
echo "required cells (must pass): ${REQUIRED_CELLS}"
echo

if [ ${#notrun[@]} -gt 0 ]; then
    echo "not attempted by this run, and therefore neither passed nor failed:"
    echo "  ${notrun[*]}"
    echo
fi

if [ ${#warnings[@]} -gt 0 ]; then
    echo "tolerated, and reported as untested rather than as a pass:"
    for w in "${warnings[@]}"; do
        echo "  - $w"
        # Shows up on the run's summary page as well as in the log.
        [ -n "${GITHUB_ACTIONS:-}" ] && echo "::warning title=install matrix cell untested::$w"
    done
    echo
fi

if [ ${#problems[@]} -gt 0 ]; then
    echo "the gate refuses this run:"
    for p in "${problems[@]}"; do
        echo "  - $p"
        [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=install matrix::$p"
    done
    echo
    echo "Fix the product, or -- if the change in behaviour is the intended one --"
    echo "record the new expectation in $expectations in the same change. Do not"
    echo "loosen install/test-matrix.sh to get a green tick."
    exit 1
fi

if [ ${#warnings[@]} -gt 0 ]; then
    echo "no cell contradicted its record, and ${#warnings[@]} facet(s) listed above were"
    echo "not tested on this runner at all. They are untested, not passed; this run says"
    echo "nothing about them."
elif [ ${#notrun[@]} -gt 0 ]; then
    echo "every cell this run attempted did what it is recorded to do. The cells"
    echo "listed above were not attempted and this run says nothing about them."
else
    echo "every cell did what it is recorded to do."
fi
