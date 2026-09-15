# Troubleshooting

Each entry gives the message or symptom, the cause, and what to do. Start with `rafikicode doctor`: it checks the configuration file, the credential, the gateway, the key's budget, the tiers, the Console and the installed version, one line each with a fix hint (details in [Headless and CI](./headless-and-ci.md#checking-a-machine-with-doctor)). Add `--print-logs --log-level DEBUG` to any command to see what it did.

## Seen on 15 September 2026

These are real messages from `rafikicode` 0.1.0 on clean `ubuntu:24.04` and `debian:12` machines that had only `curl` and `ca-certificates` installed.

**`rafikicode: command not found` right after the installer.** The installer adds `export PATH=$HOME/.rafikicode/bin:$PATH` to `~/.bashrc` (the startup file of interactive bash terminals), and only new terminals read it. In the same terminal run:

```bash
export PATH=$HOME/.rafikicode/bin:$PATH
```

or open a new terminal. Shells that are not interactive (`bash -lc`, cron, CI steps, `ssh host "command"`) do not read `~/.bashrc` either: call `~/.rafikicode/bin/rafikicode` by its full path there.

**`curl: (22) The requested URL returned error: 404` from the installer.** Before release 0.1.0 was published on 15 September, the installer had no release to download and stopped with this 404. The same message appears today when you ask for a version that does not exist:

```text
curl: (22) The requested URL returned error: 404
Error: could not download SHA256SUMS for v0.0.9 from https://github.com/paneotech-dev/rafiki-code-cli/releases/download/v0.0.9/SHA256SUMS. Is the version published?
```

Run the installer without `--version` to get the latest release.

**`npm: command not found`, or the npm registry answers 404 for `rafikicode`.** The npm package is not published yet. Use the installer.

**`permission requested: bash (...); auto-rejecting`, and no file is written.**

```text
! permission requested: bash (ls -la /root/calc1); auto-rejecting
✗ ls -la /root/calc1 failed
Error: The user rejected permission to use this specific tool call.
```

The run had no terminal attached, so nobody could approve the shell command. The run still exits 0, with nothing created. Allow edits and commands in your own configuration, in a folder you do not mind it changing:

```bash
mkdir -p ~/.rafikicode
echo '{"permission":{"bash":"allow","edit":"allow","external_directory":"allow"}}' > ~/.rafikicode/config.json
```

or pass `--auto` for one run. Both let the agent run any command as your user.

**`git: command not found`.** Clean Debian and Ubuntu images do not include git, so steps such as `git init` fail. `rafikicode` itself does not need git. Install it with `apt-get install -y git` when your project uses it.

**`Please tell me who you are` on the first `git commit`.** A fresh git has no author identity. Set one once:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

**`doctor` shows `FAIL console ... does not accept this key (401)` and `whoami` says `This key was revoked or has expired`, but tasks run.** Seen with a working gateway key: the `key`, `gateway` and `tiers` lines read `ok` and `run` completes, while the Console does not recognise the key. `doctor` then exits 1. Runs are not affected. If the `key` line fails too, the key really is revoked or spent.

**`run` without a key prints `"name": "UnknownError"` and `Unexpected server error. Check server logs for details.`** No credential is set. Set `RAFIKICODE_API_KEY` and check that `rafikicode doctor` shows `ok credential`.

## Installation

**Checksum mismatch during install.** The downloaded archive did not match the published `SHA256SUMS`. Nothing was installed. Run the installer again; if it repeats, a proxy or mirror is altering downloads, and you should fetch from the release page directly.

**macOS refuses to open the binary.** Release binaries are not yet signed. Right click the binary and choose Open once, or remove the quarantine attribute with `xattr -d com.apple.quarantine ~/.rafikicode/bin/rafikicode`.

## Sign-in

The browser sign in, `rafikicode login`, is coming soon. Until it is announced, use `RAFIKICODE_API_KEY`. The messages below are what 0.1.0 prints today when `login` is not possible.

**`No terminal is attached, so the browser sign-in is not available.`** You ran `rafikicode login` in a pipeline, over a non-interactive SSH session, or with input redirected. Set `RAFIKICODE_API_KEY` as described in [Headless and CI](./headless-and-ci.md). Exit code 2.

**`RAFIKICODE_API_KEY is set, so this session is already authenticated with a server key.`** Login is unnecessary while the variable is set. Exit code 2.

## Keys and budget

**Budget exceeded.** The key's budget or the wallet balance is spent. The request was refused and not charged. Top up the wallet in Rafiki Console, raise the key's budget on the key page, or use a different key. The `key` line of `rafikicode doctor` shows spend and budget.

**`Missing API key. Run rafikicode login, or set RAFIKICODE_API_KEY.`** Printed by `whoami` when no credential is available. Set the variable.

**`No models available: not signed in.`** Printed by `rafikicode models rafiki` when no credential is present. Set the key, then run the command again.

**A model is refused with an access error.** The key was minted for fewer tiers than you asked for. Check the `tiers` line of `rafikicode doctor` and pick an allowed alias.

## Running tasks

**`run` waits forever in a script.** Standard input is not a terminal, so the CLI reads it as the message. Redirect it: `rafikicode run "task" < /dev/null`.

**The task does nothing in CI or a container.** See the `auto-rejecting` entry above: allow permissions in your own configuration or pass `--auto`, only in a disposable checkout.

**Slow or stalled first request.** The first run in a repository indexes the project and starts language servers. Later requests are faster.

## Updating

**`rafikicode upgrade skipped: 0.1.0 is already installed`.** `rafikicode update` (or `upgrade`) found nothing newer; nothing to do.

**`update` fails with a checksum error.** The downloaded binary did not match `SHA256SUMS`; the installed binary was left untouched. Retry, or install the release with the installer script.

**`update` reports an installation method it cannot handle.** The CLI was installed from source or by hand. Reinstall with the installer script, or pass `--method curl`.

## Still stuck

Run `rafikicode doctor`, then the failing command with `--print-logs --log-level DEBUG`, and include both outputs when you ask for help. Neither contains your key.
