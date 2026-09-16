# Troubleshooting

Each entry gives the message or symptom, the cause, and what to do. The messages are those of `rafikicode` 0.1.1. Start with `rafikicode doctor`: it checks the configuration file, the credential, the gateway, the key's budget, the tiers, the Rafiki AI console and the installed version, one line each with a fix hint (details in [Headless and CI](./headless-and-ci.md#checking-a-machine-with-doctor)). Add `--print-logs --log-level DEBUG` to any command to see what it did.

## Installation

**`rafikicode: command not found` right after the installer.** The installer adds `export PATH=$HOME/.rafikicode/bin:$PATH` to `~/.bashrc` (the startup file of interactive bash terminals), and only new terminals read it. In the same terminal run:

```bash
export PATH=$HOME/.rafikicode/bin:$PATH
```

or open a new terminal. The installer prints this line as its first next step. Shells that are not interactive (`bash -lc`, cron, CI steps, `ssh host "command"`) do not read `~/.bashrc` either: call `~/.rafikicode/bin/rafikicode` by its full path there.

**`curl: (22) The requested URL returned error: 404` from the installer.** You asked for a version that does not exist:

```text
curl: (22) The requested URL returned error: 404
Error: could not download SHA256SUMS for v0.0.9 from https://github.com/paneotech-dev/rafiki-code-cli/releases/download/v0.0.9/SHA256SUMS. Is the version published?
```

Run the installer without `--version` to get the latest release.

**`npm install -g rafikicode` fails, or the npm registry answers 404 for `rafikicode`.** `rafikicode` is installed with the installer script only.

**Checksum mismatch during install.** The downloaded archive did not match the published `SHA256SUMS`. Nothing was installed. Run the installer again; if it repeats, a proxy or mirror is altering downloads, and you should fetch from the release page directly.

**macOS refuses to open the binary.** Release binaries are not code signed. Right click the binary and choose Open once, or remove the quarantine attribute with `xattr -d com.apple.quarantine ~/.rafikicode/bin/rafikicode`.

## Sign in

**`No terminal is attached, so the browser sign-in is not available.`** You ran `rafikicode login` in a pipeline, over a non-interactive SSH session, or with input redirected. `login` needs a person at a terminal. Run it in an interactive terminal, or use an API key as described in [Headless and CI](./headless-and-ci.md#api-keys). Exit code 2.

**`RAFIKICODE_API_KEY is set, so this session is already authenticated with a server key.`** Signing in is unnecessary while the variable is set, and the variable takes precedence over a stored sign in. Unset it (`unset RAFIKICODE_API_KEY`) if you want to use `login`. Exit code 2.

**The code expired before you approved it.** A code is valid for the time `login` prints (10 minutes). Run `rafikicode login` again for a new code.

**The approval page shows a different code.** Do not approve it. Approve only the code your own terminal printed, then run `rafikicode login` again if in doubt.

**`Missing API key. Run rafikicode login, or set RAFIKICODE_API_KEY.`** Printed by `whoami` when no credential is available (exit code 2). Sign in, or set the variable.

## Keys and credits

**`doctor` shows `FAIL console ... does not know this key (401)`, while tasks run.** The key works at the gateway, but it was not created in the Rafiki AI console, so `doctor` exits 1 and `whoami` says `This key is valid at the gateway but not registered in Rafiki Console (created outside the Console)`. Create a key in the Rafiki AI console at [console.rafikiai.io/keys](https://console.rafikiai.io/keys) with the Rafiki Code option ticked, or run `rafikicode login`. If the `key` line fails too, the key really is revoked or spent, and both commands say `revoked or has expired`.

**`run` stops with `No Rafiki key found. Set RAFIKICODE_API_KEY (create a key at https://console.rafikiai.io/keys), or run rafikicode login.`** No credential is available. Sign in with `rafikicode login`, or set `RAFIKICODE_API_KEY`, and check that `rafikicode doctor` shows `ok credential`. Exit code 2.

**`No models available: not signed in.`** Printed by `rafikicode models rafiki` when no credential is present. Sign in or set the key, then run the command again.

**Budget exceeded.** The key's budget or the credits in your Rafiki AI account are spent. The request was refused and not charged, and `run` exits 3. Add credits in the Rafiki AI console, raise the key's budget on the key page, or use a different key. The `key` line of `rafikicode doctor` shows spend and budget.

**A tier is refused with an access error.** The key was created for fewer tiers than you asked for (`run` exits 2). Check the `tiers` line of `rafikicode doctor` and pick an allowed tier, or create a key with the tiers you need.

## Running tasks

**`run` waits forever in a script.** Standard input is not a terminal, so the CLI reads it as the message. Redirect it: `rafikicode run "task" < /dev/null`.

**`permission requested: bash (...); auto-rejecting`, and no command runs.**

```text
! permission requested: bash (ls -la /root/calc1); auto-rejecting
```

Nobody could approve the request: the run is in CI (`CI` or `GITHUB_ACTIONS` set), where the shell tool asks before every command, or the command reaches outside the folder the run started in. The rejection prints a hint, and a run whose every tool call was rejected exits 1. To allow edits and commands, in a folder you do not mind it changing:

```bash
mkdir -p ~/.rafikicode
echo '{"permission":{"bash":"allow","edit":"allow","external_directory":"allow"}}' > ~/.rafikicode/config.json
```

or pass `--auto` for one run. Both let the agent run any command as your user. This replaces any existing `~/.rafikicode/config.json`. More ways are listed in [Headless and CI](./headless-and-ci.md#shell-commands-in-headless-runs).

**The reply stops with `The model used its whole output budget reasoning and wrote no answer`.** Run again with `--variant none`, or see [Reasoning and output limits](./configuration.md#reasoning-and-output-limits).

**`git: command not found`.** Clean Debian and Ubuntu images do not include git, so steps such as `git init` fail. `rafikicode` itself does not need git. Install it with `apt-get install -y git` when your project uses it.

**`Please tell me who you are` on the first `git commit`.** A fresh git has no author identity. Set one once:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

**Slow first request.** The first run in a repository indexes the project and starts language servers. Later requests are faster.

## Configuration

**Your editor warns that the schema of `~/.rafikicode/config.json` cannot be loaded.** The `$schema` address that 0.1.1 writes into a new configuration file answers 404. Runs are not affected. To get validation in your editor, change that line to:

```json
{
  "$schema": "https://raw.githubusercontent.com/paneotech-dev/rafiki-code-cli/v0.1.1/schema/config.json"
}
```

## Updating

**`rafikicode upgrade skipped: 0.1.1 is already installed`.** `rafikicode update` (or `upgrade`) found nothing newer; nothing to do.

**`update` fails with a checksum error.** The downloaded binary did not match `SHA256SUMS`; the installed binary was left untouched. Retry, or install the release with the installer script.

**`update` reports an installation method it cannot handle.** The CLI was installed from source or by hand. Reinstall with the installer script, or pass `--method curl`.

## Still stuck

Run `rafikicode doctor`, then the failing command with `--print-logs --log-level DEBUG`, and include both outputs when you ask for help. Neither contains your key.
