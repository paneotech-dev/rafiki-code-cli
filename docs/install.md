# Install and update

`rafikicode` is one binary. There are four ways to install it, and all four install the same files: the archives published on the [GitHub release](https://github.com/paneotech-dev/rafiki-code-cli/releases) of each version, checked against the `SHA256SUMS` file published with them.

| Channel | Command | Platforms |
| --- | --- | --- |
| Installer script | `curl -fsSL https://get.rafikiai.io \| bash` | Linux x64 and arm64 (glibc and musl), macOS Apple Silicon and Intel, Windows inside WSL |
| Installer script, Windows | `irm https://github.com/paneotech-dev/rafiki-code-cli/releases/latest/download/install.ps1 \| iex` | Windows x64 and arm64 |
| npm | `npm install -g rafikicode` | every platform above that has Node.js 18 or later |
| Homebrew | `brew install paneotech-dev/tap/rafikicode` | macOS Apple Silicon and Intel, Linux x64 and arm64 (glibc) |
| winget | `winget install --id PaneoTech.RafikiCode --exact` | Windows x64 and arm64 |

Pick one. Installing through two channels leaves two copies on your PATH, and `rafikicode doctor` tells you which one your shell runs.

After any of them:

```bash
rafikicode --version
rafikicode login
```

## Installer script

Linux and macOS:

```bash
curl -fsSL https://get.rafikiai.io | bash
```

Windows, in PowerShell:

```powershell
irm https://github.com/paneotech-dev/rafiki-code-cli/releases/latest/download/install.ps1 | iex
```

The script detects the platform, downloads the archive, verifies it against `SHA256SUMS`, installs the binary into `~/.rafikicode/bin` (`%USERPROFILE%\.rafikicode\bin` on Windows) and puts that directory on your PATH. It needs `curl` and `tar` on Linux, and `curl` and `unzip` on macOS.

Options of `install.sh`, passed after `bash -s --`:

| Option | Effect |
| --- | --- |
| `--version 0.1.9` | install that release instead of the latest |
| `--prefix DIR` | install into `DIR` instead of `~/.rafikicode/bin` |
| `--target linux-x64-baseline` | install a named build instead of the detected one |
| `--binary PATH` | install a binary you already downloaded |
| `--no-modify-path` | leave shell startup files alone |
| `--no-login` | do not start the sign-in after installing |
| `--dry-run` | show what would happen, download nothing |

Options of `install.ps1`: `-Version 0.1.9`, `-Prefix DIR`, `-Baseline`, `-NoModifyPath`, `-DryRun`.

A copy installed this way updates itself, see [Updates](#updates).

## npm

```bash
npm install -g rafikicode
```

`pnpm add -g rafikicode` and `bun install -g rafikicode` install the same package.

The package holds no binary. When it is installed it downloads the archive for your machine from the GitHub release of the same version, compares its SHA-256 with the value recorded in the package, and unpacks it next to a small launcher. It needs Node.js 18 or later and the `tar` command, which Linux, macOS and Windows 10 and later include. If your package manager skips install scripts (pnpm and bun do by default), the same download runs the first time you start `rafikicode`.

Update with `npm install -g rafikicode@latest`, or `rafikicode update`, which runs that for you.

## Homebrew

```bash
brew install paneotech-dev/tap/rafikicode
```

The formula lives in the tap `paneotech-dev/homebrew-tap` and is rewritten by the release workflow for each version. It installs the standard builds: macOS arm64 and x64, Linux arm64 and x64 on glibc. On an x64 CPU without AVX2, or on a musl system such as Alpine, use the installer script, which picks the baseline and musl builds.

Update with `brew upgrade paneotech-dev/tap/rafikicode`, or `rafikicode update`.

## winget

```powershell
winget install --id PaneoTech.RafikiCode --exact
```

The manifest installs the same `rafikicode-windows-x64.zip` and `rafikicode-windows-arm64.zip` as the release page, as a portable package. Each version is submitted to the winget community repository when it is released, and that repository reviews submissions before they can be installed, so a new version can reach winget some days after the other channels.

Update with `winget upgrade --id PaneoTech.RafikiCode --exact`, or `rafikicode update`.

## Updates

A copy installed by the installer script keeps itself up to date:

1. Once a day at most, when the interactive interface starts, `rafikicode` asks the release page for the newest version. Headless commands such as `rafikicode run` never check.
2. A newer release is downloaded in the background while you work. The archive is verified against the `SHA256SUMS` published with that release. A download that does not match is discarded.
3. The verified binary waits in `~/.local/state/rafikicode/update`. The next time you start `rafikicode`, with any command, it checks that file's SHA-256 again, puts it in place of the installed binary, prints `rafikicode updated from <old> to <new>.` on standard error, and continues as the new version. `rafikicode update` and `rafikicode uninstall` leave a waiting update alone and do their own work.

Only an interactive session downloads an update, so a machine that only ever runs `rafikicode run` stays on the version it was installed with until you update it.

A copy installed by npm, Homebrew or winget is never replaced this way. The daily check shows one notice naming the command of your package manager.

To turn it off, set `autoupdate` in `~/.rafikicode/config.json`:

```json
{
  "autoupdate": false
}
```

`"autoupdate": "notify"` checks once a day and asks before doing anything. The environment variable `RAFIKICODE_DISABLE_AUTOUPDATE=1` turns the check and the pending update off for one process, which is what a CI job or a wrapper script should set.

To update now, whatever the setting:

```bash
rafikicode update            # the latest release
rafikicode update 0.1.9      # a specific release
```

`rafikicode update` works out how the copy was installed and uses that channel: the installer's own download with its checksum check, or `npm`, `brew` or `winget`. `--method` names the channel when the detection is wrong.

## Licence

Rafiki Code is distributed under the MIT licence. Every channel delivers the licence and the notice with the binary:

- `rafikicode licenses` prints both. They are compiled into the binary.
- Every release archive holds `LICENSE` and `NOTICE` beside the binary.
- The installer scripts copy them to `~/.rafikicode/licenses/`.
- The npm package holds them at its root.
- Homebrew installs them in the formula's prefix.

## Integrity

Release archives are verified by SHA-256 on every channel. The macOS builds carry an ad-hoc signature and are not notarised with an Apple Developer ID; the Windows builds are not Authenticode signed, so SmartScreen warns the first time one runs. See [Troubleshooting](./troubleshooting.md).

## What each channel was tested on

Before a release is published, the release workflow installs every one of its twelve builds on a clean container or a fresh hosted runner of that build's platform, runs `rafikicode --version`, checks the licence files, signs in with a staging test account and runs one task. The result is the `RELEASE-GATE.md` file on each release page, next to `INSTALL-MATRIX.md` and `PLATFORM-COVERAGE.md`. A build that fails stops the release.

What was run while these channels were written, and what was not:

| Piece | Run | Not run |
| --- | --- | --- |
| `install.sh` | its test suites, and the release gate in a Debian container with a real build | the `--target` option on macOS |
| `install.ps1` | nothing new; under PowerShell on Linux in dry run mode only, for 0.1.9 | on Windows, ever; the licence file copy added here |
| npm package | its tests against a mock release, and an install of the packed package in a Node container with a real build | a publish to the registry; Windows; macOS |
| Homebrew formula | rendering, checked by tests | `brew install` and `brew test`: Homebrew has not read this formula |
| winget manifests | rendering, checked by tests | `winget validate`, a submission, an install: winget has not read these manifests |
| Automatic update | its tests, and a real build updating itself from a local mirror on Linux x64 | on macOS and on Windows. On Windows a running program cannot be overwritten, so the old file is renamed aside first; that path is written and has not been executed |
| Release gate | `release-gate.sh` in containers on Linux x64, against mock staging endpoints | on hosted runners; against staging; `release-gate.ps1`, which has never been run |

## For maintainers

The release workflow (`.github/workflows/release.yml`) refuses to start unless these repository secrets exist, and names the ones that are missing:

| Secret | Used for |
| --- | --- |
| `RAFIKICODE_STAGING_API_KEY` | the gate's sign-in and task: an API key of the staging test account, created with the Rafiki Code option ticked |
| `NPM_TOKEN` | publishing the package `rafikicode` |
| `HOMEBREW_TAP_TOKEN` | pushing the formula to `paneotech-dev/homebrew-tap` |
| `WINGET_TOKEN` | opening the pull request on `microsoft/winget-pkgs` |

The repository variables `RAFIKICODE_STAGING_GATEWAY_URL` and `RAFIKICODE_STAGING_CONSOLE_URL` point the gate at staging when staging is not the product default.

The gate for one build can be run by hand against a directory of archives:

```bash
RAFIKICODE_STAGING_API_KEY=... install/release-gate.sh \
  --target linux-x64 --version 0.2.0 --assets packages/opencode/dist
```
