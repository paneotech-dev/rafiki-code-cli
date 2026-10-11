# Releasing Rafiki Code

This page is for maintainers. It says what a release needs from the repository settings, how to add it, and what a release run publishes.

## What a release publishes

Pushing a tag `v<version>` runs `.github/workflows/release.yml`. It builds the twelve archives, gates every one of them, and then publishes:

1. The GitHub release, with the archives, `SHA256SUMS`, `install.sh` and `install.ps1`. The installer line `curl -fsSL https://get.rafikiai.io | bash`, the PowerShell installer and the daily update check of installer copies all read the latest full release, so customers receive the new version through them as soon as this step ends. This step needs no publishing token.
2. Then, each one only when its token is set: npm, the Homebrew tap and winget.

A version with a hyphen (such as `0.2.0-rc.1`) is a pre-release: it goes to GitHub only, never becomes the latest release, and needs no secret.

## Repository secrets

| Secret | Needed for | Without it |
| --- | --- | --- |
| `RAFIKICODE_STAGING_API_KEY` | every full release | the run stops in preflight, before anything is built, and names the secret |
| `NPM_TOKEN` | publishing the package `rafikicode` to npm | npm is skipped |
| `HOMEBREW_TAP_TOKEN` | pushing the formula to `paneotech-dev/homebrew-tap`, and the `brew install` check on macOS that follows | Homebrew is skipped |
| `WINGET_TOKEN` | opening the pull request on `microsoft/winget-pkgs` | winget is skipped |

A skipped channel is not a failure. The preflight job writes a warning annotation that names the missing secret, the jobs of that channel show as skipped, the run summary lists the channels published and the channels skipped, and the release notes carry a section "Package managers" that says the same for each channel. The last job of the run, `report the package managers`, rewrites that section with how each channel ended.

While a token is missing, npm, Homebrew and winget may lag behind the GitHub release: customers who installed through them stay on the version that channel last received, until a release runs with the token set. The installer script always has the latest release.

### What the staging key is used for

`install/release-gate.sh` (and `install/release-gate.ps1` on Windows) gates each build before anything is public. After it has installed the build in a clean container or on a fresh runner, and checked `--version` and the licence files, it uses the key for two live checks:

- signin: `rafikicode whoami` with the key as `RAFIKICODE_API_KEY`, which must name the account.
- task: one headless `rafikicode run` that asks for the words `hello world`, which must come back in the answer.

The key is read from that secret and nowhere else. It is redacted from the gate's log. Each release spends one short task per gated build, thirteen in all.

### Add `RAFIKICODE_STAGING_API_KEY`

1. Sign in at https://console.rafikiai.io with a dedicated test account, not a personal or customer account.
2. Give that account a small budget, enough for a few releases. Each release runs thirteen one line tasks.
3. Open https://console.rafikiai.io/keys and create a new key with the Rafiki Code option ticked. Copy the key when it is shown.
4. Open https://github.com/paneotech-dev/rafiki-code-cli, then Settings, then Secrets and variables, then Actions.
5. On the Secrets tab, choose New repository secret.
6. Name: `RAFIKICODE_STAGING_API_KEY`. Secret: the key from step 3. Choose Add secret.

The secret then appears in the list of repository secrets with the date it was updated. Its value can no longer be read, only replaced. To replace a key, create a new one in the console, update the secret the same way, and then revoke the old key.

The tokens `NPM_TOKEN`, `HOMEBREW_TAP_TOKEN` and `WINGET_TOKEN` are added on the same page, under their own names, when those channels are to be published.

### The staging addresses

Two repository variables (not secrets) point the gate at the gateway and the console:

| Variable | Value |
| --- | --- |
| `RAFIKICODE_STAGING_GATEWAY_URL` | `https://gateway.rafikiai.io` |
| `RAFIKICODE_STAGING_CONSOLE_URL` | `https://console.rafikiai.io` |

Both are optional. When a variable is not set, the build uses its own default, which is the same gateway and console. Set them when the gate should check against other addresses.

To check whether they are set: Settings, then Secrets and variables, then Actions, then the Variables tab, which lists each repository variable with its value. To add one, choose New repository variable there. With the GitHub command line:

```bash
gh variable list --repo paneotech-dev/rafiki-code-cli
gh secret list --repo paneotech-dev/rafiki-code-cli
```

The second command lists the names of the secrets, never their values.

## Cutting a release

1. Write `docs/releases/<version>.md` and run `node docs/check.mjs`.
2. Push the branch, then an annotated tag: `git tag -a v<version> -m "rafikicode <version>"` and `git push origin v<version>`.
3. Wait for the run and check it as [the install page](./install.md#when-a-release-counts-as-published) describes.

The tests of the workflow's own decisions run without a tag:

```bash
install/test-release-channels.sh     # secrets, channels, release notes section, workflow shape
install/test-release-gate.sh         # the gate's judgement
```
