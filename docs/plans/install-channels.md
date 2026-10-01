# Plan: install channels, automatic updates and the release gate

Branch `feature/install-channels`, cut from `v0.1.9`. This file is the plan the work follows. It is technical and describes the state of the branch, not of a published release.

## What exists at v0.1.9

Updater:

- `packages/opencode/src/cli/upgrade.ts` is the inherited start-up check. It runs once per start of the terminal interface (`cli/cmd/tui.ts` calls `checkUpgrade` in the worker one second after start), asks `Installation.latest()`, and for a patch release calls `Installation.upgrade()` straight away, replacing the running binary in place. For a minor or major release it only raises a dialog. It has no daily limit and no staging step.
- `packages/core/src/brand/brand.ts` seeds `autoupdate: false`, which makes that check return on its first line.
- `packages/opencode/src/rafiki/update.ts` downloads an archive from this repository's GitHub releases, checks it against `SHA256SUMS`, and swaps the binary. `rafikicode update` (alias of `upgrade`) uses it. Its `latest()` asks the unauthenticated GitHub API, which is limited to 60 requests an hour per IP address.

Channels:

- Published: the shell installer at `https://get.rafikiai.io` and `install.ps1` on the release page. Nothing else.
- `packages/opencode/script/publish-npm.ts` packs one package per platform plus a meta package and is run by `release.yml` in dry run mode when `NPM_TOKEN` is absent, so a release without the secret passes without publishing.
- `Brand.packageManagers` is empty; `upgrade --method` offers `curl`, `brew`, `choco`, `scoop`, and the last three are refused.
- No Homebrew formula, no winget manifest.

Licence:

- Release archives contain only the binary. Neither installer writes `LICENSE` or `NOTICE`, and the binary cannot print them.

Release pipeline:

- `release.yml`: one job builds every target, creates the GitHub release with all assets in a single `gh release create`, then `install-matrix.yml` installs the published archives in twenty Linux containers and only the npm job waits on it. The release page is public before any install is tested.
- `install/test-matrix.sh`, `install/matrix-gate.sh`, `install/matrix-expectations.tsv`: the container matrix and its gate. It starts three of the twelve archives.

## What changes

### 1. Automatic updates

New fork-only module `packages/opencode/src/rafiki/autoupdate.ts`:

- `upgrade()`: the start-up check, called by the worker in place of the inherited one (`cli/tui/worker.ts`, one import line; `cli/upgrade.ts` stays identical to upstream and unused).
  - Returns at once when `autoupdate` is `false` in the global configuration, when `RAFIKICODE_DISABLE_AUTOUPDATE` or `OPENCODE_DISABLE_AUTOUPDATE` is set, or when the process is not a release binary (source runs, local channel).
  - Reads `update/state.json` under the state directory. When the last check is less than 24 hours old it does nothing. Otherwise it records the time first, so a failed lookup is not retried until the next day.
  - Finds the newest version from the release page redirect (`<release base>/latest`), not from the API.
  - Newer version, `autoupdate: "notify"`: raises the existing update dialog, nothing is downloaded.
  - Newer version, installed by a package manager (npm, pnpm, bun, Homebrew, winget) or an install directory that is not writable: shows one notice naming the command to run. The binary is never replaced behind a package manager.
  - Newer version, installed by the installer script: downloads the archive in the background, verifies it against the published `SHA256SUMS`, unpacks the binary into `update/` under the state directory, records its own SHA-256 in `update/staged.json`, and shows one notice that it will be used from the next start.
- `applyStaged()`: called from `src/index.ts` before any command is parsed. One `existsSync` when nothing is staged. When an update is staged it checks the disable switches again (environment and the global configuration file), recomputes the SHA-256 of the staged binary and compares it with the recorded one, replaces the installed binary with the same rename the manual update uses, removes the staged files, and starts the new binary with the same arguments (the restart pattern `rafiki/exec-tmp.ts` already uses). A mismatch or a failed replace discards the staged files and the start continues on the current version.

Changes to existing files:

- `packages/opencode/src/rafiki/update.ts`: `latest()` reads the release page redirect first and falls back to the API; a synchronous `replaceSync` shared by the manual and the staged path.
- `packages/core/src/brand/brand.ts`: `autoupdate: true` as the seeded default (still `false` when a browser sign-in is refused in CI), the `RAFIKICODE_DISABLE_AUTOUPDATE` name, `packageManagers`, the tap and winget identifiers, the wording of `unpublishedHint`.
- `packages/opencode/src/cli/cmd/upgrade.ts`: a forced update also clears anything staged.

### 2. Install channels

- npm: `install/npm/` holds the wrapper package: `package.json`, a postinstall script that downloads the archive for the machine from the GitHub release of the same version and verifies it against checksums packed into the package, and a launcher. `packages/opencode/script/publish-npm.ts` is rewritten to assemble and publish that one package (name `rafikicode`).
- Homebrew: `install/channels/homebrew/rafikicode.rb.tmpl`, rendered per release from `SHA256SUMS` by `install/channels/render.mjs`.
- winget: `install/channels/winget/*.yaml.tmpl`, rendered by the same script (identifier `PaneoTech.RafikiCode`, portable zip).
- `packages/opencode/src/installation/index.ts`: `brew` and `winget` become real upgrade methods for the tap and the winget identifier above; `choco` and `scoop` stay refused. `cli/cmd/upgrade.ts` offers `npm`, `pnpm`, `bun`, `brew`, `winget` again. `cli/cmd/uninstall.ts` learns the two new package commands.
- Licence: the release archives carry `LICENSE` and `NOTICE` next to the binary; `install.sh` and `install.ps1` copy them to `~/.rafikicode/licenses/`; the npm package ships them; the formula installs them; the binary embeds both and prints them with `rafikicode licenses`.
- `install.sh` gains `--target <name>` to install a named build instead of the detected one, which the gate needs for the baseline builds.
- Docs: new `docs/install.md` with the four channels, the update behaviour and what each channel was tested on; `README.md`, `docs/quickstart.md` and `docs/configuration.md` point at it.

### 3. Release pipeline

`release.yml` becomes: `preflight` (tag check, every required secret present, each named when absent), `build` (archives and `SHA256SUMS` as a workflow artifact, nothing published), `gate` (one job per published target), `install-matrix` (the existing twenty cells, run against the artifact), `publish` (draft release, upload every asset, check the asset list, then publish), then `npm`, `homebrew`, `winget`.

- `install/release-gate.sh` drives one target: serves the built assets from a loopback mirror, starts a clean container for the platform (or uses the fresh hosted runner for macOS), installs with `install.sh` the way a user does, then checks `--version`, the licence files, a sign-in with the staging test credential and one hello-world task. `install/release-gate-probe.sh` is the part that runs inside the container. `install/release-gate.ps1` is the Windows counterpart using `install.ps1`.
- The staging credential is read from the secret `RAFIKICODE_STAGING_API_KEY`. Without it the gate fails and names the secret.
- `install-matrix.yml` gains an input naming the artifact to test, so the matrix runs before the release exists.
- `publish` creates the release as a draft and publishes it only after every asset is uploaded, so `releases/latest` cannot point at a release without its installer.

## Tests

- `packages/opencode/test/rafiki/autoupdate.test.ts`: once a day, disabled by configuration and by environment, `notify`, package manager installs, checksum mismatch at download, tampered staged binary at apply, apply replaces the binary, stale staged version discarded.
- `packages/opencode/test/brand/update.test.ts`: latest version from the redirect, API fallback.
- `packages/opencode/test/installation/installation.test.ts`: brew and winget upgrade commands, refusals for choco and scoop.
- `packages/opencode/test/brand/channels.test.ts`: rendered formula and manifests against a sample `SHA256SUMS`; the npm wrapper against a mock release (install, checksum refusal, launcher).
- `install/test-install.sh`: `--target`, licence files installed.
- `install/test-release-gate.sh`: the gate probe against a fake release and mock staging endpoints, including the missing-credential refusal.
- Help snapshots for `upgrade` and the new `licenses` command.
- Existing suites: installer suites, upgrade, installation, brand, help snapshots, typecheck, docs check.

## What stays with the owner

Nothing is published from this branch. These need an account, a token or a repository:

- Secrets on the repository: `RAFIKICODE_STAGING_API_KEY`, `NPM_TOKEN`, `HOMEBREW_TAP_TOKEN`, `WINGET_TOKEN`.
- The tap repository `paneotech-dev/homebrew-tap`.
- The first winget submission for `PaneoTech.RafikiCode`, which the community repository reviews by hand.
- Ownership of the npm name `rafikicode`.
- Running the pipeline: hosted macOS, Windows and arm64 runners are not reachable from the development machine, so the macOS and Windows gate jobs, `install.ps1`, `release-gate.ps1`, the formula and the winget manifests are written but have not been run.
