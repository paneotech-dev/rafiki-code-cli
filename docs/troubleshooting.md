# Troubleshooting

Each entry gives the message or symptom, the cause, and what to do. The messages quoted here are the ones the current release prints. Start with `rafikicode doctor`: it checks your configuration file, the project configuration this directory would load, whether the workspace is trusted, the credential, the gateway, the key's budget, the tiers, the Rafiki AI console, the copy of `rafikicode` your shell resolves the name to, and the installed version, one line each with a fix hint (details in [Headless and CI](./headless-and-ci.md#checking-a-machine-with-doctor)). Add `--print-logs --log-level DEBUG` to any command to see what it did.

## Installation

**`rafikicode: command not found` right after the installer.** Usually the installer prevents this by linking the binary into a directory that is already on your PATH, and says so: `Linked /usr/local/bin/rafikicode so rafikicode runs in this terminal`. If that line is missing, neither `/usr/local/bin` nor `~/.local/bin` was on your PATH and writable, so all you have is `export PATH=$HOME/.rafikicode/bin:$PATH` in `~/.bashrc` (the startup file of interactive bash terminals), which only new terminals read. With `--no-modify-path` there is no link and no line in `~/.bashrc` either, and the installer says so. In the same terminal run:

```bash
export PATH=$HOME/.rafikicode/bin:$PATH
```

or open a new terminal. Whenever it could not link, the installer prints that line as the first of its next steps and gives every following command as a full path, so `~/.rafikicode/bin/rafikicode login` works without changing PATH at all. Shells that are not interactive (`bash -lc`, cron, CI steps, `ssh host "command"`) do not read `~/.bashrc` either: call `~/.rafikicode/bin/rafikicode` by its full path there.

**`doctor` shows `FAIL  path  rafikicode resolves to ... but this process runs from ...`.** Your shell finds a different copy of `rafikicode` than the one that just ran: a stale link from an older install, or a second copy in a directory earlier on your `PATH`. The fix line prints both paths. Remove the copy your shell finds, or put the directory of the running binary earlier on `PATH`, then open a new terminal and run `rafikicode doctor` again. Two other forms of this line:

- `WARN  path  ... a launcher script, not the binary running this check`. A package manager or a shim based version manager put a small script on `PATH` that starts the real binary. Nothing is wrong. If you did not expect one, it is an older install still answering to the name: run `rafikicode --version` in a new terminal to see which version it starts.
- `FAIL  path  rafikicode is not on PATH`. No directory on your `PATH` holds the name at all, so only the full path works. Add the directory the line names to `PATH`, or reinstall with the installer at https://get.rafikiai.io, which links `rafikicode` into a directory already on it.

In a source checkout the process runs from `bun` rather than from an installed binary, so there is nothing to compare and the line reads `skip`.

**`rafikicode` still runs after `uninstall`.** `uninstall` removes `~/.rafikicode`, the lines in `~/.bashrc` and the link the installer made in `/usr/local/bin` or `~/.local/bin`, and names each one as it goes. It leaves the link alone, and says so, when the name is no longer a link to the binary it removed, because then it belongs to something else. Anything still answering to `rafikicode` came from elsewhere: `ls -l $(command -v rafikicode)` shows what it is, and `rm` removes it if it is yours.

**`curl: (22) The requested URL returned error: 404` from the installer.** You asked for a version that does not exist:

```text
curl: (22) The requested URL returned error: 404
Error: could not download SHA256SUMS for v0.0.9 from https://github.com/paneotech-dev/rafiki-code-cli/releases/download/v0.0.9/SHA256SUMS. Is the version published?
```

Run the installer without `--version` to get the latest release.

**`npm install -g rafikicode` fails during install.** The npm package holds no binary: it downloads the archive for your machine from the GitHub release of the same version and checks its SHA-256. A message starting `Could not download` means the release page was not reachable from this machine; `Checksum mismatch` means the bytes that arrived are not the published ones, usually a proxy or a download cut short. Nothing is installed in either case. Run the install again, or use another channel from [Install and update](./install.md). If the registry answers 404 for `rafikicode` itself, that version is not on npm: the installer script is always published first.

**`rafikicode` updated itself and I did not ask it to.** A copy installed by the installer script looks for a new release once a day, downloads it in the background, verifies it against the published `SHA256SUMS`, and uses it from the next start, printing `rafikicode updated from <old> to <new>.` when it does. Set `"autoupdate": false` in `~/.rafikicode/config.json` to turn that off, or `RAFIKICODE_DISABLE_AUTOUPDATE=1` for one process. See [Install and update](./install.md#updates).

**Checksum mismatch during install.** The downloaded archive did not match the published `SHA256SUMS`. Nothing was installed. Run the installer again; if it repeats, a proxy or mirror is altering downloads, and you should fetch from the release page directly.

**macOS refuses to open the binary, or says the developer cannot be verified.** The macOS builds carry an ad-hoc signature, which is what lets them run on Apple Silicon at all, but they are not notarised with an Apple Developer ID. Gatekeeper only blocks a file that is *quarantined*, and macOS sets that attribute on files a browser downloaded. The installer fetches with `curl`, which does not set it, so an install from `https://get.rafikiai.io` is not affected. If you took the `.zip` from the release page in a browser instead, clear the attribute:

```bash
xattr -d com.apple.quarantine ~/.rafikicode/bin/rafikicode
```

Or right click the file in the Finder and choose Open once. `xattr -p com.apple.quarantine <file>` says whether a file carries it; "No such xattr" means it does not.

**macOS: the binary will not start on an older Mac.** The macOS builds need macOS 13 (Ventura) or newer, on Apple Silicon and on Intel. On macOS 12 or older they cannot run; there is no build for those versions. `sw_vers -productVersion` prints the version of your Mac.

**macOS: `Killed: 9` as soon as `rafikicode` starts.** macOS stopped a binary whose code signature does not match its contents. Check it with `codesign --verify --strict --verbose=2 ~/.rafikicode/bin/rafikicode`. Reinstall with the installer, and if the check still fails, please report it with that output.

**macOS: the installer says `No shell startup file found`.** Only releases before 0.1.8 did this. A fresh macOS account runs zsh and has no `~/.zshrc`, and `/usr/local/bin` there belongs to root, so the installer could neither write a startup file nor make the link, and `rafikicode` was not found in any new terminal. The installer now creates `~/.zshrc` with the PATH line. On an older install, create it yourself:

```bash
echo 'export PATH=$HOME/.rafikicode/bin:$PATH' >> ~/.zshrc
```

**The installer says `unzip` is missing.** The macOS builds and the Windows builds installed from Git Bash are `.zip` archives, so the shell installer needs `unzip` there; Linux uses `tar`. Install `unzip` with your package manager. In Git Bash, `command -v unzip` says whether it is there; when it is not, use `install.ps1` in PowerShell instead, which needs no extra tool.

**Alpine: the installed binary does not start and the installer prints `apk add libstdc++ libgcc`.** The musl build needs the C++ runtime, which a minimal Alpine system does not have. Run `apk add libstdc++ libgcc`, then the installer again.

**PowerShell: `irm https://get.rafikiai.io/install.ps1 | iex` fails with `Use '{ instead of { in variable names`.** `https://get.rafikiai.io` serves only the shell installer, whatever the path, so PowerShell was given `install.sh`. Fetch `install.ps1` from the release:

```powershell
irm https://github.com/paneotech-dev/rafiki-code-cli/releases/latest/download/install.ps1 | iex
```

**PowerShell: `install.ps1` says `USERPROFILE is not set`.** Windows always sets it, so the script is running somewhere else, such as PowerShell on macOS or Linux. Use `curl -fsSL https://get.rafikiai.io | bash` there, or name the directory with `-Prefix` or `RAFIKICODE_INSTALL_DIR`.

**Windows: `install.sh` does nothing, or the shell cannot run it.** `install/install.sh` is a POSIX shell script. On Windows it runs only inside WSL, Git Bash or Cygwin. In PowerShell use the PowerShell installer instead:

```powershell
irm https://github.com/paneotech-dev/rafiki-code-cli/releases/latest/download/install.ps1 | iex
```

**Windows: SmartScreen warns that the publisher is unknown.** The `.exe` is not Authenticode signed. The archive is verified against the published `SHA256SUMS` before it is installed, which is the check that matters; `Get-FileHash -Algorithm SHA256` on the downloaded archive reproduces it. Choose **More info**, then **Run anyway**, or unblock the file with `Unblock-File`.

**Windows: `Rafiki Code cannot draw its full screen interface in this window.`** You started `rafikicode` in the old Windows console (`conhost.exe`), which is what Windows PowerShell and `cmd` open on Windows 10 unless Windows Terminal is installed and set as the default. That console cannot draw the full screen interface, so `rafikicode` says so and exits with code 7 instead of showing nothing. Open Windows Terminal (from the Microsoft Store, or `winget install --id Microsoft.WindowsTerminal`) and run `rafikicode` there, or give the task directly with `rafikicode run "your task"`, which works in any console. The same message, with another cause, appears when the console refuses virtual terminal processing (Windows older than Windows 10 version 1511, or the console's "Use legacy console" option is on). `rafikicode doctor` has a `terminal` line on Windows that says whether the current window can draw the interface. Windows Terminal, the VS Code terminal, WezTerm, Git Bash and SSH sessions are not refused. If your console draws the interface well anyway, `RAFIKICODE_FORCE_TUI=1` skips the check.

**Windows: the interactive interface draws garbage, or boxes and colours are wrong.** Use Windows Terminal, which is the default on Windows 11 and installable from the Microsoft Store on Windows 10. `rafikicode run "your task"` prints plain lines and works in any console.

**PowerShell: the installer printed an error and the window stayed open.** That is intended. Run as `irm ... | iex`, `install.ps1` returns to your prompt after an error, with `$LASTEXITCODE` set to 1, instead of closing the window before the error can be read. Run as a file (`.\install.ps1`), it exits with code 1.

**Windows: the installed program does not start, or exits immediately with no message.** `install.ps1` checks this itself: it runs `rafikicode --version` after installing and exits with code 1 and the message `was installed but did not run` when that fails. This is not an old processor, and the baseline build will not fix it. The published builds need no recent instruction set: the ordinary binary has been run on an emulated 2008 processor with neither AVX nor AVX2. The four archives labelled `baseline` are byte identical to the siblings they exist to replace, so `-Baseline` fetches the same bytes and changes nothing. Please report it, with the processor named:

```powershell
& "$env:USERPROFILE\.rafikicode\bin\rafikicode.exe" --version
Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name
```

If `--version` works and only the full screen interface fails, say so in the report. That path loads a separately compiled drawing library, which the run above does not touch, so it is the one case here that is not yet ruled out.

**Windows: `rafikicode` is not found in a new terminal.** The installer puts `%USERPROFILE%\.rafikicode\bin` on the user `PATH`, which only processes started afterwards read. Close the terminal and open a new one. For the terminal you installed from:

```powershell
$env:Path = "$env:USERPROFILE\.rafikicode\bin;$env:Path"
```

## When it will not start

When `rafikicode` cannot start, it says what it thinks the cause is, gives one command to try, and prints the original error under `Original error:` so you can paste it to us. Add `--print-logs` to the same command for the full error and its stack. Two exit codes carry the result for scripts: 6 means this machine or this build cannot run `rafikicode` at all, 7 means it runs but this terminal cannot host the full screen interface.

**`Rafiki Code cannot start: a library it needs could not be loaded on this machine.`** The full screen interface is drawn by a library that is unpacked into the temporary directory and run from there. When that fails, `rafikicode` tests every temporary directory it could use, by writing a small file there and running it, and the message is what it found. Either no directory will run a file, and it lists each one it tried and why (a `noexec` mount, which is common on shared hosts; full; not writable), or the temporary directory is fine and the cause lies elsewhere, in which case it says so and names what is left: a build for another kind of machine, a newer C library than this one has, or a memory limit. Your sign in and your key are not the problem in either case. When no directory will run a file, point `rafikicode` at one that programs are allowed to run from:

```bash
TMPDIR=/that/directory rafikicode
```

If you do not have one, the message carries a line you can send to whoever runs the server. Meanwhile `rafikicode run "your task"` needs no drawing library and keeps working. Exit code 6.

**`Rafiki Code cannot start: it stopped on an instruction this machine's CPU would not run.`** The published builds need no recent instruction set, such as AVX2, and there is no other build for the installer to fetch instead, so an illegal instruction here should not happen on any processor: it is a bug in the build. Reinstalling changes nothing. Please report it at the issue tracker the message names, with the original error and the processor this happened on (`lscpu`, or `sysctl -n machdep.cpu.brand_string` on macOS). Exit code 6.

**`Rafiki Code cannot start: this build does not match the system C library of this machine.`** The installed build needs a different C library from the one this machine has: a newer glibc than it carries, or glibc where the machine uses musl (Alpine Linux and similar), or the other way round. Run the installer again: it detects which build this machine needs. Exit code 6.

**`Rafiki Code cannot start: it has no directory it can write to.`** The directory that holds the configuration, the logs and the session history cannot be created or written, and the message names it and the reason (`EACCES`, `EROFS`, `ENOSPC`, `ENOTDIR`). Give yourself that directory (`mkdir -p` and `chmod 700`, as the message prints it), free space on its disk, or check where `HOME` points when the reason is `ENOTDIR`. Exit code 6.

**`Rafiki Code cannot start its full screen interface here: standard output is not a terminal.`** The output is redirected to a file or a pipe, or nothing is attached to this job at all (CI, cron, a container, `ssh host "command"`). Give the task directly instead with `rafikicode run "your task"`, which is built for exactly this. A matching message names the other two cases: a terminal whose `TERM` is `dumb`, and a window too small to draw in. A terminal that reports no size at all (0 columns by 0 rows, which is what `docker run -t` gives a container when nothing on the client side is a terminal) is not refused: the interface draws at 80 by 24. Exit code 7.

**`Rafiki Code stopped with a failure it has no diagnosis for.`** No cause is known for this one. The original error is printed below the message, `--print-logs` adds its stack, `rafikicode doctor` checks the machine, and `rafikicode run "your task"` works without the full screen interface. Please report it with the original error at the issue tracker the message names. Exit code 1.

## Sign in

**`No terminal is attached, so the browser sign-in is not available.`** You ran `rafikicode login` in a pipeline, over a non-interactive SSH session, or with input redirected. `login` needs a person at a terminal. Run it in an interactive terminal, or use an API key as described in [Headless and CI](./headless-and-ci.md#api-keys). Exit code 2.

**`RAFIKICODE_API_KEY is set, so this session is already authenticated with a server key.`** Signing in is unnecessary while the variable is set, and the variable takes precedence over a stored sign in. Unset it (`unset RAFIKICODE_API_KEY`) if you want to use `login`. Exit code 2.

**`Your Rafiki AI account cannot sign in yet: it is waiting for email verification or for approval.`** A new account has to verify its email address and then be approved before it can sign in. `login` stops as soon as the Rafiki AI console says so. Open the verification link in your email if you have not, wait for the approval message, then run `rafikicode login` again. Exit code 2.

**`login` says `Still waiting`, or the code expired before you approved it.** A code is valid for the time `login` prints (10 minutes). After two minutes with no answer from the browser, `login` says once that a new account may still be waiting for email verification or approval: if the browser showed a page about approval, that is the cause, and the sign in cannot finish until the account is approved. Otherwise run `rafikicode login` again for a new code.

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

**Project plugins, custom tools, a local MCP server, a formatter or a language server declared in the repository do not load.** The workspace is not trusted. `rafikicode doctor` says so on its `trust` line, as a `WARN` rather than a failure, with the list of what was dropped on the line below and the command that fixes it: `rafikicode trust` in the repository, or `RAFIKICODE_TRUST_WORKSPACE=1` for one run. Trust only repositories whose contents you would run as a script; see [workspace trust](./security/workspace-trust.md).

**`Working in ~/RafikiCode (started from your home folder).`** You started `rafikicode` (the interface or `run`) in your home folder, or at the root of a drive or of the file system. Neither is a project, and treating one as the project meant reading the whole tree before the first request, which on Windows could hang `run` after its first line. So `rafikicode` works in the `RafikiCode` folder of your home folder instead, creating it on first use, and prints that line on standard error. To work on a project, `cd` into it first. To work in the home folder anyway: `rafikicode run --dir . "your task"`, `rafikicode .` for the interface, or `RAFIKICODE_NO_DEFAULT_WORKSPACE=1`. A home folder that is itself a git repository is used as it is.

**Slow first request.** The first run in a repository indexes the project and starts language servers. Later requests are faster. The file checkpoints that undo uses are skipped for a directory with more than 10,000 changed or untracked files, or when listing them takes longer than 10 seconds, so a huge directory never holds back the first request; the log says `snapshots off for this directory` when that happens, and undo cannot restore files changed there.

## When the connection drops

A task survives a lost connection. Nothing below needs a setting.

**The answer stops in the middle and then carries on.** The connection to the gateway was cut while the model was answering. The text that had arrived is kept and the model is asked to continue from where it stopped; a command or edit that had already run is not run again. In the session you see the answer in two parts.

**The status line says the request is being retried.** The gateway could not be reached. The request is sent again after 2 seconds, then 4, 8, 16 and every 30 seconds, each wait with a random part added, for up to 2 minutes (`RAFIKICODE_RETRY_WINDOW`, in seconds, changes that). A closed laptop lid or a change of network is covered by this.

**`The connection to the model gateway was lost and did not come back for 2 minutes. The session is saved`.** The retries ran out. Nothing is lost: the conversation, the task list and the file checkpoints are stored on this machine as each step happens. When the network is back, send any message in the same session (for example `continue`), or start again later with:

```bash
rafikicode --resume
rafikicode run --resume "continue"
```

`--resume` is the same as `--continue`: it opens the most recent session of the folder you are in. `--session ID` opens a particular one; `rafikicode session list` shows the ids.

**The program was killed, or the machine restarted, in the middle of a task.** Run `rafikicode --resume`. A command that was running when the program died is shown as interrupted and the model is told so; it is not assumed to have finished. The files that step had changed are recorded when the session is opened again, so undo restores them. Edits you made yourself to those same files between the crash and the resume are part of what undo reverts.

**A gateway address that is wrong, or no network when the task starts.** This is reported after one retry, in a few seconds, with `Cannot reach the model gateway`. The two minute wait applies only once the gateway has answered in the running program.

## Configuration

**A command stops at start with `Configuration is invalid ...` or `Config file at ... is not valid JSON(C)`.** A configuration file cannot be loaded, so nothing starts. The message ends with three fix lines: run `rafikicode doctor` to see which file is at fault and what to change, `RAFIKICODE_DISABLE_PROJECT_CONFIG=1 rafikicode` to start one run without anything from the working tree, and the address of the schema that lists every option with its type. `doctor` checks both places a file can come from: the `config` line is `~/.rafikicode/config.json`, and the `project` line is every project file a session started in this directory would load, named in the order they merge.

**`doctor` shows `FAIL  config` or `FAIL  project  ... does not match the configuration schema (...)`.** The file parses but a field has the wrong shape. The detail names up to three fields and counts the rest, and the fix names the schema to check them against. `doctor` validates with the same decoder a session uses, so a file that passes here starts a session. For a project file the escape hatch is `RAFIKICODE_DISABLE_PROJECT_CONFIG=1`, because the file belongs to the repository rather than to you; for `~/.rafikicode/config.json` you can also move the file aside and let the next run recreate it with defaults.

**Your editor warns that the schema of `~/.rafikicode/config.json` cannot be loaded.** Releases 0.1.0 and 0.1.1 wrote a `$schema` address that answers 404. Runs are not affected. From 0.1.4, new configuration files point at the schema of the installed release, for example `https://raw.githubusercontent.com/paneotech-dev/rafiki-code-cli/v0.1.4/schema/config.json`, and the first command you run replaces the old address in an existing file, changing nothing else in it.

## Updating

**`rafikicode upgrade skipped: 0.1.5 is already installed`.** `rafikicode update` (or `upgrade`) found nothing newer; nothing to do.

**`update` fails with a checksum error.** The downloaded binary did not match `SHA256SUMS`; the installed binary was left untouched. Retry, or install the release with the installer script.

**`update` says `This is a run from source` and installs nothing.** You started `rafikicode` from a checkout of the repository (`bun run src/index.ts`), where the program being run is the JavaScript runtime and not a `rafikicode` binary. `update` refuses every method there, `--method curl` included, and exits with code 2: there is no installed copy to replace, and it will not install a global package as a side effect of a command run from a checkout. Update the checkout with `git pull` instead. To get a released binary on this machine as well, use one of the channels in [Install and update](./install.md).

**`update` says the binary `may be managed by a package manager` and asks `Install anyways?`.** The binary was put in place by hand, for example copied out of a release archive into a directory of your own, so `update` cannot tell which channel owns it. Answer yes, or pass `--method curl`, to have it download the release, verify it against `SHA256SUMS` and replace that binary where it is. Reinstalling with the installer script moves it to `~/.rafikicode/bin`, which `update` recognises from then on.

## Still stuck

Run `rafikicode doctor`, then the failing command with `--print-logs --log-level DEBUG`, and include both outputs when you ask for help. Neither contains your key.
