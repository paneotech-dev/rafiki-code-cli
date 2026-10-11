#!/usr/bin/env bash
# Which channels a release run publishes, and what the release says about them.
#
# The GitHub release is the one channel every customer can reach: the installer
# script, install.ps1, get.rafikiai.io and the daily update check all read the
# latest full release. npm, Homebrew and winget are published from it, each
# with a token of its own, and each one is optional: a missing token skips that
# channel with a warning, never the release. The staging key is different. It
# runs the live sign-in and task checks of the gate, and a full release does not
# start without it.
#
# Commands:
#
#   install/release-channels.sh preflight
#       Reads PRERELEASE (true or false) and the secrets RAFIKICODE_STAGING_API_KEY,
#       NPM_TOKEN, HOMEBREW_TAP_TOKEN and WINGET_TOKEN from the environment;
#       secrets are compared with the empty string only and never printed.
#       A full release without the staging key: one ::error, a step summary,
#       exit 1. Otherwise it writes live_gate, npm, homebrew and winget (true or
#       false) to $GITHUB_OUTPUT, one ::warning per channel token that is
#       missing on a full release, and the list of channels to the step summary.
#       A pre-release goes to GitHub only, so its three channels are false and
#       no token is asked for.
#
#   install/release-channels.sh section
#       Prints the "Package managers" section of the release notes and the run
#       summary, between two marker lines. Reads NPM_ENABLED, HOMEBREW_ENABLED,
#       WINGET_ENABLED (true or false, from preflight) and, once the channel
#       jobs have ended, NPM_RESULT, HOMEBREW_RESULT, HOMEBREW_VERIFY_RESULT and
#       WINGET_RESULT (success, failure, cancelled or skipped). An empty result
#       means the job has not run yet.
#
#   install/release-channels.sh splice NOTES SECTION
#       Replaces the section in the release notes file NOTES with the file
#       SECTION, or appends it when NOTES has none, in place. Run again with the
#       same section, it changes nothing.
#
# install/test-release-channels.sh tests all three, and the shape of
# .github/workflows/release.yml that depends on them.
set -euo pipefail

BEGIN="<!-- package-managers -->"
END="<!-- /package-managers -->"

# channel id, secret, display name, package, upgrade command
CHANNELS=(
    "npm|NPM_TOKEN|npm|rafikicode|npm install -g rafikicode@latest"
    "homebrew|HOMEBREW_TAP_TOKEN|Homebrew|paneotech-dev/tap/rafikicode|brew upgrade paneotech-dev/tap/rafikicode"
    "winget|WINGET_TOKEN|winget|PaneoTech.RafikiCode|winget upgrade --id PaneoTech.RafikiCode --exact"
)

out() { echo "$1" >> "${GITHUB_OUTPUT:-/dev/null}"; }
summary() { echo "$1" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"; }

preflight() {
    local prerelease=${PRERELEASE:-}
    case "$prerelease" in
        true|false) ;;
        *) echo "::error title=release::PRERELEASE must be true or false, got '${prerelease}'."; exit 1 ;;
    esac

    if [ "$prerelease" = "false" ] && [ -z "${RAFIKICODE_STAGING_API_KEY:-}" ]; then
        echo "::error title=release::The repository secret RAFIKICODE_STAGING_API_KEY is not set. A full release signs in and runs one task against staging with it, and does not run without it. See docs/releasing.md."
        summary "## Release not started"
        summary ""
        summary "Missing repository secret: RAFIKICODE_STAGING_API_KEY."
        summary "Nothing was built and nothing was published. See docs/releasing.md."
        exit 1
    fi

    if [ -n "${RAFIKICODE_STAGING_API_KEY:-}" ]; then
        out "live_gate=true"
    else
        # Only a pre-release reaches this line without the key.
        out "live_gate=false"
        echo "::warning title=release::Pre-release without the staging key: live checks against staging are skipped; every other check runs. Set the repository secret RAFIKICODE_STAGING_API_KEY to run them."
        summary "Pre-release without the staging key: live checks against staging are skipped; every other check runs"
    fi

    if [ "$prerelease" = "true" ]; then
        for entry in "${CHANNELS[@]}"; do
            IFS='|' read -r id _ <<< "$entry"
            out "${id}=false"
        done
        summary ""
        summary "Pre-release: published to GitHub only. npm, Homebrew and winget receive full releases only."
        echo "Pre-release: GitHub only."
        return 0
    fi

    local published=() skipped=()
    for entry in "${CHANNELS[@]}"; do
        IFS='|' read -r id secret name _ <<< "$entry"
        if [ -n "${!secret:-}" ]; then
            out "${id}=true"
            published+=("$name")
        else
            out "${id}=false"
            skipped+=("$name ($secret not set)")
            echo "::warning title=${name} skipped::The repository secret ${secret} is not set, so ${name} is not published by this release. The GitHub release, the installer scripts and get.rafikiai.io are not affected. ${name} users keep the previous version until ${secret} is set and a release publishes it. See docs/releasing.md."
        fi
    done
    summary ""
    summary "## Channels"
    summary ""
    summary "- GitHub release, install.sh, install.ps1 and get.rafikiai.io: published by this run."
    if [ "${#published[@]}" -gt 0 ]; then
        summary "- Package managers published after the GitHub release: $(join "${published[@]}")."
    fi
    if [ "${#skipped[@]}" -gt 0 ]; then
        summary "- Package managers skipped: $(join "${skipped[@]}")."
    fi
    echo "Channels: GitHub release; package managers published: ${published[*]:-none}; skipped: ${skipped[*]:-none}."
}

join() {
    local IFS=","
    local text="$*"
    echo "${text//,/, }"
}

# One line per channel, from what preflight decided and how the jobs ended.
line() {
    local id=$1 secret=$2 name=$3 package=$4 upgrade=$5
    local upper
    upper=$(echo "$id" | tr '[:lower:]' '[:upper:]')
    local enabled_var="${upper}_ENABLED" result_var="${upper}_RESULT"
    local enabled=${!enabled_var:-false} result=${!result_var:-}
    local head="- ${name} (\`${package}\`):"
    if [ "$enabled" != "true" ]; then
        echo "${head} skipped. The repository secret \`${secret}\` is not set, so this release was not published to ${name}, and \`${upgrade}\` keeps the previous version until a release is. Install this version with the installer script instead."
        return
    fi
    if [ "$id" = "homebrew" ] && [ "$result" = "success" ]; then
        case "${HOMEBREW_VERIFY_RESULT:-}" in
            success) echo "${head} published. The tap carries this version, and \`brew install\` of it was checked on macOS." ;;
            "") echo "${head} published to the tap. The install check on macOS has not ended yet." ;;
            *) echo "${head} published to the tap, but the install check on macOS ended \`${HOMEBREW_VERIFY_RESULT}\`. See the release run." ;;
        esac
        return
    fi
    case "$result" in
        "") echo "${head} being published by the release run; this line is updated when it ends." ;;
        success)
            if [ "$id" = "winget" ]; then
                echo "${head} submitted. The pull request on \`microsoft/winget-pkgs\` is open, and the version installs once it is merged."
            else
                echo "${head} published."
            fi ;;
        *) echo "${head} not published: the job ended \`${result}\`. See the release run." ;;
    esac
}

section() {
    echo "$BEGIN"
    echo "### Package managers"
    echo
    echo "The GitHub release, the installer scripts and get.rafikiai.io serve this version."
    echo
    for entry in "${CHANNELS[@]}"; do
        IFS='|' read -r id secret name package upgrade <<< "$entry"
        line "$id" "$secret" "$name" "$package" "$upgrade"
    done
    echo "$END"
}

splice() {
    local notes=${1:?splice needs the notes file} part=${2:?splice needs the section file}
    local tmp="${notes}.splice"
    awk -v begin="$BEGIN" -v end="$END" '
        $0 == begin { skipping = 1; next }
        skipping && $0 == end { skipping = 0; next }
        !skipping { print }
    ' "$notes" > "$tmp"
    # Trailing blank lines are dropped, so that a section put back in place
    # leaves the file exactly as it was.
    awk '{ lines[NR] = $0 } END { n = NR; while (n > 0 && lines[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print lines[i] }' "$tmp" > "${tmp}.trim"
    {
        cat "${tmp}.trim"
        [ -s "${tmp}.trim" ] && echo
        cat "$part"
    } > "$notes"
    rm -f "$tmp" "${tmp}.trim"
}

case "${1:-}" in
    preflight) preflight ;;
    section) section ;;
    splice) shift; splice "$@" ;;
    *) echo "usage: install/release-channels.sh preflight | section | splice NOTES SECTION" >&2; exit 2 ;;
esac
