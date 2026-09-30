# Troubleshooting

Each entry gives the message or symptom, the cause, and what to do. The messages are those of `rafikicode` 0.1.5. Start with `rafikicode doctor`: it checks the configuration file, the credential, the gateway, the key's budget, the tiers, the Rafiki AI console and the installed version, one line each with a fix hint (details in [Headless and CI](./headless-and-ci.md#checking-a-machine-with-doctor)). Add `--print-logs --log-level DEBUG` to any command to see what it did.

## Installation

**`rafikicode: command not found` right after the installer.** Usually the installer prevents this by linking the binary into a directory that is already on your PATH, and says so: `Linked /usr/local/bin/rafikicode so rafikicode runs in this terminal`. If that line is missing, neither `/usr/local/bin` nor `~/.local/bin` was on your PATH and writable, so all you have is `export PATH=$HOME/.rafikicode/bin:$PATH` in `~/.bashrc` (the startup file of interactive bash terminals), which only new terminals read. With `--no-modify-path` there is no link and no line in `~/.bashrc` either, and the installer says so. In the same terminal run:

```bash
export PATH=$HOME/.rafikicode/bin:$PATH
```

or open a new terminal. Whenever it could not link, the installer prints that line as the first of its next steps and gives every following command as a full path, so `~/.rafikicode/bin/rafikicode login` works without changing PATH at all. Shells that are not interactive (`bash -lc`, cron, CI steps, `ssh host "command"`) do not read `~/.bashrc` either: call `~/.rafikicode/bin/rafikicode` by its full path there.

**`rafikicode` still runs after `uninstall`.** `uninstall` removes `~/.rafikicode`, the lines in `~/.bashrc` and the link the installer made in `/usr/local/bin` or `~/.local/bin`, and names each one as it goes. It leaves the link alone, and says so, when the name is no longer a link to the binary it removed, because then it belongs to something else. Anything still answering to `rafikicode` came from elsewhere: `ls -l $(command -v rafikicode)` shows what it is, and `rm` removes it if it is yours.

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

**`Unknown sign in surface "...". Use --surface cli or --surface ide.`** `rafikicode login --surface` takes `cli` (the default, a terminal) or `ide` (an editor). Nothing was sent. Exit code 2.

**`Missing API key. Run rafikicode login, or set RAFIKICODE_API_KEY.`** Printed by `whoami` when no credential is available (exit code 2). Sign in, or set the variable.

## Keys and credits

**`doctor` shows `WARN  key ...` with `This key was not created for Rafiki Code`.** The key is a general key from the Rafiki AI console, created without the Rafiki Code option. Runs still work, but Rafiki Code tracks usage only on keys created for it. Create a key at [console.rafikiai.io/keys](https://console.rafikiai.io/keys) with the Rafiki Code option ticked, or run `rafikicode login`. `doctor` still exits 0.

**`doctor` shows `WARN  console ... does not know this key (401)`, while tasks run.** The key works at the gateway, but the Rafiki AI console does not know it (it was created outside the console). `doctor` adds that usage still works and is metered at the gateway, ends with `All checks passed, 1 warning, see the line marked WARN.` and exits 0. `whoami` prints the same explanation and exits 2. Create a key in the Rafiki AI console at [console.rafikiai.io/keys](https://console.rafikiai.io/keys) with the Rafiki Code option ticked, or run `rafikicode login`. If the `key` line fails too, the key really is revoked or spent, and both commands say `revoked or has expired`.

**`run` or the terminal interface stops at once with `Rafiki Code needs a Rafiki AI account.`** No credential is available:

```text
Error: Rafiki Code needs a Rafiki AI account. Create one in the Rafiki AI console (https://console.rafikiai.io), then run: rafikicode login
On a server or in CI, create an API key at https://console.rafikiai.io/keys with the Rafiki Code option ticked, and set RAFIKICODE_API_KEY.
```

Sign in with `rafikicode login`, or set `RAFIKICODE_API_KEY`, and check that `rafikicode doctor` shows `ok credential`. Exit code 2.

**`No models available: not signed in.`** Printed by `rafikicode models rafiki` when no credential is present. Sign in or set the key, then run the command again.

**Budget exceeded.** The key's budget or the credits in your Rafiki AI account are spent. The request was refused and not charged, and `run` exits 3. Add credits in the Rafiki AI console, raise the key's budget on the key page, or use a different key. The `key` line of `rafikicode doctor` shows spend and budget.

**A tier is refused with an access error.** The key was created for fewer tiers than you asked for (`run` exits 2). Check the `tiers` line of `rafikicode doctor` and pick an allowed tier, or create a key with the tiers you need.

## Models and providers

`rafikicode` runs on the Rafiki tiers only.

**`Warning: ignored enabled_providers in the configuration` or `Warning: ignored model openai/gpt-4o in the configuration`.** A configuration file asks for another provider or model. `rafikicode` ignores that setting, prints the warning, and carries on with the Rafiki tiers. Remove the setting to silence the warning.

**`Error: rafikicode runs on Rafiki models only (...)`.** `run -m` named a model outside the Rafiki tiers. Use `-m rafiki/rafiki-fast` or `-m rafiki/rafiki-pro`. Exit code 2.

**`rafikicode providers` or `rafikicode auth` answers `rafikicode providers is not available: rafikicode runs on Rafiki models only.`** These commands stored keys for other providers and were removed. Sign in with `rafikicode login`, or set `RAFIKICODE_API_KEY`. Exit code 2.

## Local server

**A script that calls `rafikicode serve` or `rafikicode web` gets `401 Unauthorized`.** From 0.1.4 the local server always requires a password. Set `RAFIKICODE_SERVER_PASSWORD` for both the server and the script, or read the password from the server file the server names when it starts (`~/.rafikicode/servers/<port>.json`). See [Server files](./configuration.md#server-files).

**`The rafikicode server at <url> needs a password` or `... refused the password`.** `rafikicode run --attach` or `attach` sent no password, or the wrong one. Pass `--password`, or set `RAFIKICODE_SERVER_PASSWORD` to the value the server was started with. Exit code 2. When no server answers at the address, the exit code is 4.

**`Warning: not using the server file ...`.** The client found a server file for that port but did not trust it: the file or its folder can be read by another user, belongs to someone else, or its server process is no longer running. The warning gives the reason. Start the server again, or pass the password yourself.

**`rafikicode serve` refuses to start with exit code 2.** It was asked to listen on an address other machines can reach (`--hostname` other than `127.0.0.1`, `::1` or `localhost`, or `--mdns`) without a password you chose, or the `servers` folder cannot be used safely. Set `RAFIKICODE_SERVER_PASSWORD`, or fix the folder the message names.

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

**Your editor warns that the schema of `~/.rafikicode/config.json` cannot be loaded.** Releases 0.1.0 and 0.1.1 wrote a `$schema` address that answers 404. Runs are not affected. From 0.1.4, new configuration files point at the schema of the installed release, for example `https://raw.githubusercontent.com/paneotech-dev/rafiki-code-cli/v0.1.4/schema/config.json`, and the first command you run replaces the old address in an existing file, changing nothing else in it.

## Updating

**`rafikicode upgrade skipped: 0.1.5 is already installed`.** `rafikicode update` (or `upgrade`) found nothing newer; nothing to do.

**`update` fails with a checksum error.** The downloaded binary did not match `SHA256SUMS`; the installed binary was left untouched. Retry, or install the release with the installer script.

**`update` reports an installation method it cannot handle.** The CLI was installed from source or by hand. Reinstall with the installer script, or pass `--method curl`.

## Still stuck

Run `rafikicode doctor`, then the failing command with `--print-logs --log-level DEBUG`, and include both outputs when you ask for help. Neither contains your key.
