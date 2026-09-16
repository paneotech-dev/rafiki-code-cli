# Rafiki Code for VS Code

Rafiki Code is the PANEOTECH coding agent that runs on your Rafiki AI account and its credits. This extension opens the `rafikicode` terminal interface inside VS Code and connects it to your editor.

## Requirements

- The `rafikicode` command, version 0.1.4 or later. Install it with:

  ```bash
  curl -fsSL https://get.rafikiai.io | bash
  ```

- A Rafiki AI account, from the Rafiki AI console at [console.rafikiai.io](https://console.rafikiai.io).

## Features

- **Open Rafiki Code** (`Ctrl+Esc`, `Cmd+Esc` on macOS): opens a session for the current workspace beside your editor, or focuses the one already open. **Open in New Tab** (`Ctrl+Shift+Esc`, `Cmd+Shift+Esc`) always starts a new one; the Rafiki button in the editor title does the same.
- **Send Selection or File** (`Ctrl+Alt+K`, `Cmd+Alt+K` on macOS, also in the editor context menu): adds a reference such as `@src/app.ts#L37-42` to the session prompt. **Send File** is in the explorer context menu.
- **Sign In** and **Sign Out**: sign in runs `rafikicode login` in a terminal (open the link, enter the code, approve in the Rafiki AI console at console.rafikiai.io). The editor and your terminals share the same sign in.
- **Status bar**: shows whether a key is available and the tier for new sessions. Click it for the menu.
- **Doctor** and **Show Account**: run `rafikicode doctor` and `rafikicode whoami` and show the result in the Rafiki Code output.
- **Choose Tier**: fast (1x credits) or pro (4x) for the next session.

## Settings

| setting | default | meaning |
|---|---|---|
| `rafikicode.path` | empty | Absolute path of `rafikicode`. Empty: search `PATH`, then `~/.rafikicode/bin`. |
| `rafikicode.tier` | `default` | `fast`, `pro`, or `default` for the model in your rafikicode configuration. |
| `rafikicode.terminalLocation` | `editor` | `editor` opens sessions in a tab beside the file, `panel` in the terminal panel. |
| `rafikicode.showStatusBar` | `true` | Show the status bar item. |

## Documentation

Editor guide for Rafiki Code, including sign in and troubleshooting: [docs/ide.md](https://github.com/paneotech-dev/rafiki-code-cli/blob/v0.1.4/docs/ide.md).

## Attribution and license

MIT. Based on the opencode VS Code extension; see LICENSE and NOTICE.

## Development

1. Open `sdks/vscode` in VS Code (not the repository root).
2. Run `bun install` inside `sdks/vscode`.
3. Press `F5` to start a VS Code window with the extension loaded.

Checks: `bun run check-types`, `bun run lint`, `bun run test:unit`, and `xvfb-run -a bun run test` for the tests inside VS Code. Package with `bun run vsix`.
