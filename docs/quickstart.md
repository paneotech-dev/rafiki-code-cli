# Quick start

This page takes you from nothing to a first file written by `rafikicode` in about five minutes. It describes `rafikicode` 0.1.5. The key, first task and uninstall steps were run as written in clean `ubuntu:24.04` and `debian:12` containers that had only `curl` and `ca-certificates` installed. The install output below is that of the 0.1.5 installer and has not been run again in those containers.

Terms used here: a **terminal** is the text window where you type commands. **PATH** is the list of folders your shell searches for programs. An **API key** is a key issued by Rafiki AI with its own spending limit; every model call made with it uses credits in your Rafiki AI account. **Headless** means running where nobody can answer a question, such as a server, a container or a CI (continuous integration) pipeline.

You need a Rafiki AI account. Rafiki Code is part of Rafiki AI by PANEOTECH, and the Rafiki AI console at [console.rafikiai.io](https://console.rafikiai.io) is where you sign in, create keys and see your credits.

## 1. Install

Linux and macOS. The machine needs `curl`; on a minimal Debian or Ubuntu install it first with `apt-get install -y curl ca-certificates`. macOS needs nothing extra: `curl` and `unzip` are both present by default.

```bash
curl -fsSL https://get.rafikiai.io | bash
```

On Windows, open PowerShell and run:

```powershell
irm https://github.com/paneotech-dev/rafiki-code-cli/releases/latest/download/install.ps1 | iex
```

The line above is the native Windows route; `install.sh` is a POSIX shell script and runs on Windows only inside WSL, Git Bash or Cygwin. Either way the interactive interface in step 4 needs Windows Terminal, because the older console window cannot draw it. `rafikicode run "your task"` works in both.

Expected output:

```text
Installing rafikicode version 0.1.5
Checksum verified
Installed rafikicode at /root/.rafikicode/bin/rafikicode
Linked /usr/local/bin/rafikicode so rafikicode runs in this terminal
Added /root/.rafikicode/bin to PATH in /root/.bashrc

Next steps:
  1. Sign in to your Rafiki AI account:
       rafikicode login
     On a server with no browser, use a key from https://console.rafikiai.io/keys (tick the Rafiki Code option):
       export RAFIKICODE_API_KEY=sk-...
```

The `Linked` line is the one that matters for the terminal you are sitting in. A line added to `~/.bashrc` is read by new terminals only, so the installer also puts a link to the binary in a directory that is already on your PATH: `/usr/local/bin`, or `~/.local/bin`. It uses such a directory only when it is already on your PATH and you can write to it, and it never replaces a file that is not one of its own links. When you see that line, the command works straight away:

```bash
rafikicode --version
```

This prints `0.1.5`.

When the line is absent, neither directory was on your PATH and writable. The next steps then open with the PATH line, and every command they show uses the binary's full path:

```text
Next steps:
  1. New terminals find rafikicode on their own. To use this one:
       export PATH=/root/.rafikicode/bin:$PATH
  2. Sign in to your Rafiki AI account:
       /root/.rafikicode/bin/rafikicode login
```

Run that `export` line, open a new terminal, or call the binary by the full path the installer printed.

With `--no-modify-path` there is no link and nothing is written to `~/.bashrc`, so no terminal finds the command by name until you place the line yourself. The installer says only what is true in that case:

```text
Next steps:
  1. Nothing was added to your shell startup files. To use rafikicode in this terminal:
       export PATH=/root/.rafikicode/bin:$PATH
     Put the same line in your shell startup file so new terminals find it too.
  2. Sign in to your Rafiki AI account:
       /root/.rafikicode/bin/rafikicode login
```

`rafikicode` is installed with the installer script; it is not published on npm.

## 2. Sign in

On a computer where you can open a browser, sign in with your Rafiki AI account:

```bash
rafikicode login
```

`login` prints a code and a link, then waits:

```text
Open https://console.rafikiai.io/device in a browser and enter this code:

    XXXX-XXXX

Or open https://console.rafikiai.io/device?code=XXXX-XXXX
Approving as: <label>. The code expires in 10 minutes.
Waiting for approval...
```

1. Open https://console.rafikiai.io/device in a browser (the second link fills in the code for you).
2. Sign in with your Rafiki AI account, check that the code matches the one in your terminal, and approve.
3. The terminal prints `Signed in` with your account and stores the key in `~/.rafikicode/credentials` (readable only by you).

The code is eight letters shown as `XXXX-XXXX` and expires after 10 minutes; run `rafikicode login` again if it does. `--label NAME` sets the name shown on the approval page and in the key list of the Rafiki AI console, so you can tell your machines apart:

```bash
rafikicode login --label work-laptop
```

Then:

```bash
rafikicode whoami     # the account and key this terminal uses
rafikicode logout     # sign out and revoke this terminal's key
```

`login` needs a terminal: in a script, a pipeline or `ssh host "command"` it stops with exit code 2 and points you to an API key.

### Or use an API key

On a server, in CI, or wherever you prefer a key: create a key in the Rafiki AI console at [console.rafikiai.io/keys](https://console.rafikiai.io/keys) and tick the Rafiki Code option. Keys created without that option are not billed through Rafiki Code, so always tick it for keys you use with `rafikicode`. Then:

```bash
export RAFIKICODE_API_KEY=...   # the key you created
rafikicode doctor
```

In a shared room or on a recorded screen, load the key without showing it: `read -rs RAFIKICODE_API_KEY && export RAFIKICODE_API_KEY`, paste the key, press Enter (nothing is echoed).

`RAFIKICODE_API_KEY` takes precedence over a stored sign in. While it is set, `rafikicode login` stops with exit code 2 and says the session already uses a key.

`doctor` prints one line per check. The lines that matter for running tasks are `credential`, `gateway`, `key` and `tiers`, for example:

```text
ok    credential  RAFIKICODE_API_KEY from the environment
ok    gateway     https://gateway.rafikiai.io answered in 181 ms
ok    key         key rafikicode-..., spent 0.0769 USD of 2.5 USD budget, expires 2026-10-13T12:34:43.455000+00:00
ok    tiers       rafiki-fast, rafiki-pro
```

The other lines check things that are not about the key: your configuration file and the project configuration of the directory you are in, whether the workspace is trusted, which copy of `rafikicode` your shell resolves the name to, and the installed version. Every line is one of `ok`, `WARN` with a fix hint, `FAIL` with a fix hint, or `skip`, and `doctor` exits 0 unless something failed. The full list is in [Headless and CI](./headless-and-ci.md#checking-a-machine-with-doctor).

## 3. Run a first task

Start in an empty folder:

```bash
mkdir -p ~/calc && cd ~/calc
rafikicode run "Create a calculator web page in index.html with basic styling"
ls -la
```

The run prints its steps and a summary, for example:

```text
> build · rafiki-fast
← Write index.html
Wrote file successfully.
Created `/root/calc/index.html` with a working calculator: ...
```

and `ls -la` shows `index.html` (about 5 to 7 KB). Open it in a browser.

`run` prints the answer and exits. In a script, add `< /dev/null` so `run` does not wait for a message on standard input. `rafikicode` with no command starts the terminal user interface (TUI), a full screen chat on `rafiki-fast`.

By default the agent may edit files and run commands inside the folder it starts in, and asks before it reaches outside it. In CI (`CI` or `GITHUB_ACTIONS` set) it also asks before every shell command, and nobody can answer; see [Headless and CI](./headless-and-ci.md#shell-commands-in-headless-runs) for how to allow commands there.

The agent does not need `git`. Clean Debian and Ubuntu images do not include it; install it with `apt-get install -y git` if your project uses it, and set `git config --global user.name` and `user.email` before your first commit.

## 4. Choose a tier

Every request goes through the Rafiki AI gateway under a tier name:

| tier | good for |
|---|---|
| `rafiki-fast` | everyday edits, fixes, questions (default) |
| `rafiki-pro` | longer agentic work and larger features; uses more credits per token |

Pick a tier for one run with `-m` (or `--model`):

```bash
rafikicode run -m rafiki/rafiki-pro "Reply with the single word ok and do nothing else" < /dev/null
```

The output starts with `> build · rafiki-pro`. To make a tier your default, add `"model": "rafiki/rafiki-pro"` to `~/.rafikicode/config.json`.

## 5. Tell it about your project

Create an `AGENTS.md` at the root of the repository with the conventions you want followed: build and test commands, code style, what not to touch. `rafikicode` reads it into every session. A global `~/.rafikicode/AGENTS.md` applies to every project. Keep it short and factual; it is the most effective way to get better results from `rafiki-fast`.

## 6. Uninstall

```bash
rafikicode logout
rafikicode uninstall --force
```

`logout` revokes the key of a signed in terminal (skip it if you used `RAFIKICODE_API_KEY`). `uninstall` removes `~/.rafikicode` (binary and configuration), `~/.cache/rafikicode`, `~/.local/state/rafikicode`, `~/.local/share/rafikicode`, the two lines the installer added to `~/.bashrc` and the `rafikicode` symlink the installer placed in a directory on your `PATH` (only when it is still a link to the binary being removed); without `--force` it asks first, and `--dry-run` only lists what it would remove.

## Next

- [Configuration](./configuration.md) for every setting the CLI honors.
- [Headless and CI](./headless-and-ci.md) for servers, pipelines and scripts.
- [Editors](./ide.md) to use Rafiki Code from Zed, JetBrains IDEs, Cline or Aider.
- [Troubleshooting](./troubleshooting.md) when something does not work.
