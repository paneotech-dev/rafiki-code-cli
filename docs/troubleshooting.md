# Troubleshooting

Each entry gives the message or symptom, the cause, and what to do. Add `--print-logs --log-level DEBUG` to any command to see what it did.

## Installation

**`rafikicode: command not found` after installing.** The binary is in `~/.rafikicode/bin`, which is not on your PATH in this shell yet. The installer prints the exact line; for bash and zsh it is:

```bash
export PATH=$HOME/.rafikicode/bin:$PATH
```

Open a new terminal after adding it to your shell configuration file.

**Checksum mismatch during install.** The downloaded archive did not match the published `SHA256SUMS`. Nothing was installed. Run the installer again; if it repeats, a proxy or mirror is altering downloads, and you should fetch from the release page directly.

**macOS refuses to open the binary.** Release binaries are not yet signed. Right click the binary and choose Open once, or remove the quarantine attribute with `xattr -d com.apple.quarantine ~/.rafikicode/bin/rafikicode`.

## Sign-in

**`No terminal is attached, so the browser sign-in is not available.`** You ran `rafikicode login` in a pipeline, over a non-interactive SSH session, or with input redirected. Create a server key in Rafiki Console and set `RAFIKICODE_API_KEY` as described in [Headless and CI](./headless-and-ci.md). Exit code 2.

**`RAFIKICODE_API_KEY is set, so this session is already authenticated with a server key.`** Login is unnecessary while the variable is set. Unset it if you want a browser sign-in on this machine. Exit code 2.

**`That sign-in code expired. Run rafikicode login again.`** Codes are valid for ten minutes. Run the command again and approve promptly.

**`Sign-in was denied in the browser.`** Someone chose Deny on the approval page. Exit code 1.

**`Console asked to slow down; polling every N s.`** Not an error. The Console throttled the terminal's polling and the CLI adapted; approval is still picked up.

**Network errors during login (exit code 4).** The Console was unreachable. Check connectivity and, if you use `RAFIKICODE_CONSOLE_URL`, that it points at the right host.

## Keys and budget

**Budget exceeded.** The key's budget or the wallet balance is spent. The request was refused and not charged. Top up the wallet in Rafiki Console, raise the key's budget on the key page, or use a different key. `rafikicode whoami` shows the key budget and the wallet balance.

**`This key was revoked or has expired. Run rafikicode login.`** The terminal's key was revoked from the Console, or it reached its expiry. Sign in again to receive a fresh key. For a server key, create a new one in the Console and update `RAFIKICODE_API_KEY`.

**`Missing API key. Run rafikicode login, or set RAFIKICODE_API_KEY.`** No credential is available. Sign in, or set the variable.

**A model is refused with an access error.** The key was minted for fewer tiers than you asked for (for example a server key limited to `rafiki-fast`). Check the tiers with `rafikicode whoami` and pick an allowed alias, or create a key with the tiers you need.

**`rafikicode models` shows no `rafiki` models.** No credential is present, so the provider was not registered. Sign in or set the key, then run the command again.

## Running tasks

**`run` waits forever in a script.** Standard input is not a terminal, so the CLI reads it as the message. Redirect it: `rafikicode run "task" < /dev/null`.

**The task stops at a permission prompt in CI.** Automated jobs need `--auto` to approve tool permissions that are not explicitly denied. Use it only in a disposable checkout.

**Slow or stalled first request.** The first run in a repository indexes the project and starts language servers. Later requests are faster.

## Updating

**`rafikicode update` says the version is already current.** The latest published release matches the installed one; nothing to do. Pass a version explicitly (`rafikicode update 1.2.3`) to move to a specific release, including an older one.

**`update` fails with a checksum error.** The downloaded binary did not match `SHA256SUMS`; the installed binary was left untouched. Retry, or install the release with the installer script.

**`update` reports an installation method it cannot handle.** The CLI was installed through npm, a package manager or from source. Update through the same channel (`npm install -g rafikicode@latest`, or rebuild).

## Still stuck

Run the failing command with `--print-logs --log-level DEBUG` and include the output when you ask for help. Log files never contain your key.
