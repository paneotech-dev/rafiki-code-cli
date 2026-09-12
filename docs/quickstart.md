# Quick start

This page takes you from nothing to a first completed task in about five minutes. It assumes a Rafiki Console account with credits. If you do not have one yet, create it at [console.rafikiai.io](https://console.rafikiai.io).

## 1. Install

Linux and macOS:

```bash
curl -fsSL https://get.rafikiai.io | bash
```

The installer downloads the release archive for your machine, verifies it against the published checksums, installs the binary in `~/.rafikicode/bin`, and prints the line to add to your shell configuration if that directory is not on your PATH yet. Open a new terminal afterwards, then check:

```bash
rafikicode --version
```

npm works as a second channel: `npm install -g rafikicode`. Windows users go through WSL (Windows Subsystem for Linux) or npm for now. See [Troubleshooting](./troubleshooting.md) if the command is not found.

## 2. Sign in

```bash
rafikicode login
```

The command prints a short code and a link to `console.rafikiai.io/device`. Open the link in any browser, sign in to Rafiki Console if you are not already, check that the code matches, and approve. The terminal notices the approval within a few seconds and prints the account it is now signed in as.

Behind the scenes the Console issues this terminal its own gateway key (a per-device credential with a spending budget that you can see and revoke in the Console). The key is stored in `~/.rafikicode/credentials`, readable only by your user. You never need to copy it anywhere.

Check at any time who the terminal is signed in as, what budget the key has, and how much of your wallet is available:

```bash
rafikicode whoami
```

On a server or in CI there is no browser, so `rafikicode login` refuses and tells you to set `RAFIKICODE_API_KEY` instead. See [Headless and CI](./headless-and-ci.md).

## 3. Run a first task

Go to a repository and describe what you want:

```bash
cd your-project
rafikicode run "explain how this project is built and tested"
```

`run` prints the answer and exits. Tasks that edit files ask for permission before writing or running commands, unless you allow them in the configuration. For a longer session start the terminal user interface (TUI), where you can chat, review diffs, and switch models:

```bash
rafikicode
```

Both start on the `rafiki-fast` tier by default.

## 4. Choose a tier

Every request goes through the Rafiki gateway under one of three aliases. Credits are charged per token with a multiplier per tier:

| alias | multiplier | good for |
|---|---|---|
| `rafiki-fast` | 1x | everyday edits, fixes, questions (default) |
| `rafiki-pro` | 4x | longer agentic work, larger features |
| `rafiki-max` | 15x | the hardest problems, when the cheaper tiers stall |

Pick a tier for one run with `--model rafiki/rafiki-pro`, switch inside the TUI with the model dialog, or set a default in `~/.rafikicode/config.json`:

```json
{
  "model": "rafiki/rafiki-pro"
}
```

`rafikicode models rafiki` lists the aliases available to your key.

## 5. Tell it about your project

Create an `AGENTS.md` at the root of the repository with the conventions you want followed: build and test commands, code style, what not to touch. `rafikicode` reads it into every session. A global `~/.rafikicode/AGENTS.md` applies to every project. Keep it short and factual; it is the single most effective way to get better results from the cheaper tiers.

## 6. Sign out

```bash
rafikicode logout
```

This revokes the terminal's key at the Console and deletes the local credential file. Keys can also be revoked from the Console key list at any time.

## Next

- [Configuration](./configuration.md) for every setting the CLI honors.
- [Headless and CI](./headless-and-ci.md) for servers, pipelines and scripts.
- [IDE preset](./ide-preset.md) to use the same wallet from an editor.
- [Troubleshooting](./troubleshooting.md) when something does not work.
