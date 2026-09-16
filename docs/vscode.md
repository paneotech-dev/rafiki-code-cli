# Rafiki Code for VS Code

The Rafiki Code extension runs the `rafikicode` terminal interface inside VS Code, beside your code. You sign in once with your Rafiki Console account, and every session spends from the same wallet as the terminal.

What you get:

- Rafiki Code in an editor tab (or the terminal panel), one session per tab, started in your workspace folder.
- Send the current file, a selection, or a file from the explorer to the session prompt as a reference such as `@src/app.ts#L37-42`.
- Sign in and sign out from the command palette. The extension and your terminals share one sign in.
- A status bar item that shows whether a key is available and which tier new sessions use.
- **Doctor** and **Show Account** commands, and a tier picker (fast, pro, max).

## Requirements

- VS Code 1.94 or later.
- The `rafikicode` command, version 0.1.3 or later. With 0.1.1 and 0.1.2, sessions open and sign in works, but references sent from the editor do not appear in the prompt. Install or update with:

  ```bash
  curl -fsSL https://get.rafikiai.io | bash
  ```

- A Rafiki Console account at [console.rafikiai.io](https://console.rafikiai.io), or a server key (see [Using a server key](#using-a-server-key)).

## Install

### From a .vsix file (now)

Until the extension is listed in the marketplaces, it ships as a `.vsix` file (a VS Code extension package). With the file on your computer:

```bash
code --install-extension rafiki-code-0.1.0.vsix
```

Or in VS Code: open the Extensions view, click the `...` menu at the top, choose **Install from VSIX...**, and pick the file. Reload the window when asked.

To update, install the newer `.vsix` the same way. To remove it, uninstall **Rafiki Code** from the Extensions view.

### From the marketplaces (later)

The extension will be published as `paneotech.rafiki-code` (identifier not final) on:

- the Visual Studio Marketplace, for Microsoft VS Code;
- Open VSX, for VSCodium and other editors built on VS Code that use that registry.

This page will be updated when the listings are live.

## First run

1. After installing, look at the right side of the status bar. It shows one of the states below.
2. If it says **Rafiki Code: install**, `rafikicode` was not found. Click it and choose **Copy Install Command** or **Install in Terminal**, or set `rafikicode.path` (see [Settings](#settings)).
3. If it says **Rafiki Code: sign in**, click it. A terminal named **Rafiki Code Sign In** runs `rafikicode login`: open the link it prints, enter the code, and approve in the Console. The terminal closes on success and a notification names the account.
4. Press `Ctrl+Esc` (`Cmd+Esc` on macOS) to open Rafiki Code beside the current file.

Status bar states:

| status bar | meaning | click does |
|---|---|---|
| Rafiki Code | signed in, or a server key is set; the tier is shown in brackets when you picked one | opens the menu |
| Rafiki Code: sign in | no key | starts sign in |
| Rafiki Code: sign in again | the stored key has expired | starts sign in |
| Rafiki Code: install | `rafikicode` not found, or `rafikicode.path` is wrong | shows the fix |
| Rafiki Code (warning colour) | the key cannot be used, for example the credential file has unsafe permissions; the tooltip says why | opens the menu, run **Doctor** |

The status reads `rafikicode whoami --offline`, which does not contact the Console. It refreshes when the credential file changes, when a sign in terminal closes, when settings change, and when the window regains focus. **Rafiki Code: Refresh Status** forces it.

## Commands

All commands are in the command palette under **Rafiki Code**.

| command | keys | what it does |
|---|---|---|
| Open | `Ctrl+Esc`, macOS `Cmd+Esc` | Focuses the open session, or starts one. The current file is added to the prompt as `In @path`. |
| Open in New Tab | `Ctrl+Shift+Esc`, macOS `Cmd+Shift+Esc`; the Rafiki button in the editor title | Always starts a new session. |
| Send Selection or File | `Ctrl+Alt+K`, macOS `Cmd+Alt+K`; editor context menu | Adds `@path` or `@path#L3-7` to the prompt of the active session (or the last one opened). Starts a session if none is open. For an unsaved file, sends the selected text itself. |
| Send File | explorer context menu | Adds `@path` for the chosen file. |
| Sign In | | Runs `rafikicode login` in a terminal (device flow). With rafikicode 0.1.3 or later it adds `--surface ide`, so the Console key list shows the key as an editor sign in. |
| Sign Out | | After a confirmation, runs `rafikicode logout`, which revokes the stored key at the Console and removes it from this computer, for terminals too. |
| Show Account | | Runs `rafikicode whoami` (asks the Console) and shows the answer in the **Rafiki Code** output. |
| Doctor | | Runs `rafikicode doctor` and shows the report in the **Rafiki Code** output, with a one line summary. |
| Choose Tier | | Picks the tier for the next session: fast (1x credits), pro (4x), max (15x), or the rafikicode default. A running session keeps its model. |
| Refresh Status | | Re-reads the key state. |

Inside a session, everything works as in the terminal: see the [quickstart](./quickstart.md).

## Settings

| setting | default | meaning |
|---|---|---|
| `rafikicode.path` | empty | Absolute path of the `rafikicode` command (`~` is expanded). Empty: search `PATH`, then `RAFIKICODE_INSTALL_DIR` if VS Code was started with it, then `~/.rafikicode/bin` (the installer's default), then `~/.local/bin` and `/usr/local/bin` (and `/opt/homebrew/bin` on macOS). A path that does not point to an executable file is reported, never skipped silently. |
| `rafikicode.tier` | `default` | `fast`, `pro`, `max`, or `default` (the model in your rafikicode configuration, `rafiki-fast` unless you changed it). Sessions start with `--model rafiki/rafiki-<tier>`. |
| `rafikicode.terminalLocation` | `editor` | `editor`: sessions open in a tab beside the current file. `panel`: in the terminal panel. |
| `rafikicode.showStatusBar` | `true` | Show or hide the status bar item. |

The extension never stores a key in settings.

## Using a server key

On a machine where you cannot use the browser sign in, create a server key at [console.rafikiai.io/keys](https://console.rafikiai.io/keys) and make `RAFIKICODE_API_KEY` available in the environment VS Code starts from, for example by starting VS Code from a shell where it is exported:

```bash
export RAFIKICODE_API_KEY=sk-...
code .
```

The status bar then shows **Rafiki Code** and the tooltip says a server key is in use; **Sign In** explains that the environment key takes precedence. Keep the key out of shell history and dotfiles you share. See [Headless and CI](./headless-and-ci.md) for key handling.

## How it works

- Each session is `rafikicode --hostname 127.0.0.1 --port <free port> [--model rafiki/rafiki-<tier>]`, started directly (not through your shell) in an editor terminal, in the workspace folder of the active file.
- The terminal interface then runs a small control server on that loopback port. The extension creates a random password for each session and passes it to that session only, through `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SERVER_USERNAME` in the terminal's environment (the variable names are inherited from the upstream code). References are sent with `POST /tui/append-prompt` using that password. Without the password the server answers 401, and requests carrying a web page's `Origin` are refused with 403, so other programs and web pages cannot type into your session.
- Sign in, sign out, the status, Doctor and Show Account all run the `rafikicode` command. The key stays in `~/.rafikicode/credentials` (mode 0600), managed by `rafikicode`; the extension never reads or copies it.
- Sign ins from the extension appear in the Console key list with the label `Rafiki Code for VS Code <version> on <computer name>`.

Why this design: the terminal interface is the complete Rafiki Code experience (tiers, permissions, `AGENTS.md`, wallet errors) and is what the upstream extension already drove, so the extension stays small and every CLI improvement reaches VS Code at once. `rafikicode serve` would need a chat interface rebuilt inside VS Code, and ACP needs an ACP client, which VS Code does not include; both stay open for a later, richer panel.

## Troubleshooting

| symptom | cause and fix |
|---|---|
| "Rafiki Code could not find the rafikicode command" | Install it (`curl -fsSL https://get.rafikiai.io \| bash`), then **Refresh Status**. If it is installed somewhere else, set `rafikicode.path`. **Show Checked Paths** in the message lists every file that was tried. VS Code started from a desktop launcher may not see the `PATH` from your shell profile; `~/.rafikicode/bin` is always checked. |
| "rafikicode.path points to ..., which is not an executable file" | Fix the path or clear the setting. |
| **Open** shows "Rafiki Code needs a Rafiki Console account" | No key. Choose **Sign In**, or **Create Server Key** and see [Using a server key](#using-a-server-key). |
| The sign in terminal shows an error and stays open | Read the message; it is the same as in a terminal (see [Troubleshooting](./troubleshooting.md)). Close the terminal and run **Sign In** again. |
| **Sign In** says a server key is already in use | `RAFIKICODE_API_KEY` is set in VS Code's environment. Remove it and restart VS Code to use your account instead. |
| Status bar in warning colour with "cannot use its key" | Usually the credential file: run **Doctor**; it prints the exact fix (for example `chmod 600 ~/.rafikicode/credentials`). |
| **Send Selection or File** does nothing visible | Update `rafikicode` to 0.1.3 or later. If the session was just opened, wait for its screen to appear and send again. Messages are in the **Rafiki Code** output (View, Output). |
| "Rafiki Code did not accept the reference" | The session has exited or is still starting. Open a new one. |
| A new session still uses the old tier | The tier applies to sessions started after the change. Open a new tab. |
| `Ctrl+Esc` opens something else | Another extension uses the same key. Change it in Keyboard Shortcuts (search for "Rafiki Code"). |
| Remote SSH, WSL, containers | The extension runs where your workspace is, so `rafikicode` and the sign in must be on that machine. Not yet tested. |
| Windows | Point `rafikicode.path` to `rafikicode.exe`. Not yet tested. |

## What was tested

On 16 September 2026, on Linux:

- Unit tests for the binary search order, the whoami and doctor parsing (including real coloured output), references, tiers and the password protected control calls.
- Integration tests inside VS Code 1.138.0 (headless, `@vscode/test-cli`) with a stub `rafikicode`: commands registered, missing binary, no key state, opening without a key starts nothing, sign in through a terminal updates the status, a session starts on 127.0.0.1 with the chosen tier and a password and receives the file and selection references, Doctor runs. The same suite passed on the minified bundle that goes into the `.vsix`.
- The real `rafikicode` 0.1.2 (console only build) started from a VS Code terminal: health answered only with the session password, and a reference was accepted.
- The real 0.1.2 and 0.1.1 binaries driven outside VS Code: password and `Origin` checks answer 401 and 403, the tier shows on screen, and the appended reference shows on the 0.1.2 console only build but not on 0.1.1.
- Again on 16 September with the same driver: a local 0.1.3 build showed the reference; the 0.1.2 release candidate (without the console only changes) did not, in two runs. Hence the 0.1.3 minimum.
- The `.vsix` installs with `code --install-extension`.

Not yet tested: a real device flow sign in from the extension against the Console, macOS, Windows, Remote SSH, VSCodium and other editors built on VS Code.
