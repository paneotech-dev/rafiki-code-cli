# Quick start

This page takes you from nothing to a first file written by `rafikicode` in about five minutes. Every command below was run as written on 15 September 2026 with `rafikicode` 0.1.0 in clean `ubuntu:24.04` and `debian:12` containers, and the install, key, first task and uninstall steps again with 0.1.1 (published the same day at 08:11 UTC), that had only `curl` and `ca-certificates` installed.

Terms used here: a **terminal** is the text window where you type commands. **PATH** is the list of folders your shell searches for programs. A **gateway key** (or API key) is a Rafiki issued key with its own spending budget; every model call is charged to it. **Headless** means running where nobody can answer a question, such as a server, a container or a CI (continuous integration) pipeline.

You need a Rafiki gateway key. Create a server key at [console.rafikiai.io/keys](https://console.rafikiai.io/keys) or ask the Rafiki team for one.

## 1. Install

Linux and macOS (Windows through WSL, the Windows Subsystem for Linux). The machine needs `curl`; on a minimal Debian or Ubuntu install it first with `apt-get install -y curl ca-certificates`.

```bash
curl -fsSL https://get.rafikiai.io | bash
```

Expected output (0.1.1):

```text
Installing rafikicode version 0.1.1
Checksum verified
Installed rafikicode at /root/.rafikicode/bin/rafikicode
Added /root/.rafikicode/bin to PATH in /root/.bashrc

Next steps:
  1. Make rafikicode available in this terminal:
       export PATH=/root/.rafikicode/bin:$PATH
  2. Connect your Rafiki Console account with a key:
       export RAFIKICODE_API_KEY=sk-...   (create one at https://console.rafikiai.io/keys)
     or sign in from a browser:
       rafikicode login
```

The installer changes `~/.bashrc` for new terminals only. In the terminal you installed from, `rafikicode` is not found yet. Either open a new terminal, or run:

```bash
export PATH=$HOME/.rafikicode/bin:$PATH
rafikicode --version
```

This prints `0.1.1`.

There is no npm package yet: `npm install -g rafikicode` does not work (the npm registry answers 404 for `rafikicode`). Use the installer.

## 2. Give it your key

```bash
export RAFIKICODE_API_KEY=...   # your gateway key
rafikicode doctor
```

In a shared room or on a recorded screen, load the key without showing it: `read -rs RAFIKICODE_API_KEY && export RAFIKICODE_API_KEY`, paste the key, press Enter (nothing is echoed).

`doctor` prints one line per check. The lines that matter for running tasks are `credential`, `gateway`, `key` and `tiers`:

```text
ok    credential  RAFIKICODE_API_KEY from the environment
ok    gateway     https://gateway.rafikiai.io answered in 181 ms
ok    key         key rafikicode-..., spent 0.0769 USD of 2.5 USD budget, expires 2026-10-13T12:34:43.455000+00:00
ok    tiers       rafiki-fast, rafiki-pro, rafiki-max
```

With a key created outside Rafiki Console the `console` line reads `FAIL ... does not know this key (401)` (0.1.0: `does not accept this key`) and `doctor` exits 1, while tasks still run. See [Troubleshooting](./troubleshooting.md#seen-on-15-september-2026).

`rafikicode models rafiki` lists the tiers the key may use: `rafiki/rafiki-fast`, `rafiki/rafiki-max`, `rafiki/rafiki-pro`.

The browser sign in, `rafikicode login`, is coming soon. Until it is announced, use `RAFIKICODE_API_KEY`.

## 3. Allow file edits and commands

With 0.1.1 this step is optional: the first task below wrote `index.html` with no terminal attached and no configuration. It is still needed in CI (`CI` or `GITHUB_ACTIONS` set) and on 0.1.0, where a run with no terminal attached (a script, `docker run` without `-it`, `ssh host "command"`) rejects every shell command, prints `! permission requested: bash (...); auto-rejecting`, and can end without writing any file while still exiting 0. For those cases, allow edits and commands in your own configuration file, for a folder you do not mind it changing:

```bash
mkdir -p ~/.rafikicode
echo '{"permission":{"bash":"allow","edit":"allow","external_directory":"allow"}}' > ~/.rafikicode/config.json
```

This replaces any existing `~/.rafikicode/config.json`. It lets the agent run any shell command as your user, so use it in a project folder or a disposable machine, not in your home folder with important files. For a single run you can pass `--auto` instead, which approves every permission that is not explicitly denied.

## 4. Run a first task

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

The agent does not need `git`. Clean Debian and Ubuntu images do not include it; install it with `apt-get install -y git` if your project uses it, and set `git config --global user.name` and `user.email` before your first commit.

## 5. Choose a tier

Every request goes through the Rafiki gateway under one of three aliases. Credits are charged per token with a multiplier per tier:

| alias | multiplier | good for |
|---|---|---|
| `rafiki-fast` | 1x | everyday edits, fixes, questions (default) |
| `rafiki-pro` | 4x | longer agentic work, larger features |
| `rafiki-max` | 15x | the hardest problems, when the cheaper tiers stall |

Pick a tier for one run with `-m` (or `--model`):

```bash
rafikicode run -m rafiki/rafiki-pro "Reply with the single word ok and do nothing else" < /dev/null
```

The output starts with `> build · rafiki-pro`. To make a tier your default, add `"model": "rafiki/rafiki-pro"` to `~/.rafikicode/config.json`, next to the `permission` entry.

## 6. Tell it about your project

Create an `AGENTS.md` at the root of the repository with the conventions you want followed: build and test commands, code style, what not to touch. `rafikicode` reads it into every session. A global `~/.rafikicode/AGENTS.md` applies to every project. Keep it short and factual; it is the single most effective way to get better results from the cheaper tiers.

## 7. Uninstall

```bash
rafikicode uninstall --force
```

It removes `~/.rafikicode` (binary and configuration), `~/.cache/rafikicode`, `~/.local/state/rafikicode`, `~/.local/share/rafikicode` and, from 0.1.1, the two lines the installer added to `~/.bashrc`; without `--force` it asks first, and `--dry-run` only lists what it would remove. On 0.1.0 remove the `~/.bashrc` lines with `sed -i '/^# rafikicode$/d; /\.rafikicode\/bin/d' ~/.bashrc`.

## Next

- [Configuration](./configuration.md) for every setting the CLI honors.
- [Headless and CI](./headless-and-ci.md) for servers, pipelines and scripts.
- [IDE preset](./ide-preset.md) to use the same wallet from an editor.
- [Troubleshooting](./troubleshooting.md) when something does not work.
