# Plan: say so when the Windows console cannot draw the interface

Branch `fix/windows-console-message`, based on `review/cli-integration-2026-10-02`
at `a3f5d6dbb7`. Written before any code was edited.

## What happened

The 0.1.9 PowerShell installer was run on a Windows 10 laptop, a new Windows
PowerShell window was opened and `rafikicode` was started: nothing showed. On
Windows 10, Windows PowerShell opens in the old console host (`conhost.exe`)
unless Windows Terminal is installed and set as the default. The full screen
interface does not draw there. The installer mentions this only in a grey
closing note, and the program itself says nothing.

## What the program should do

When the full screen interface is about to start in a console that cannot draw
it, print a short message and exit 7, like the other startup refusals in
`packages/opencode/src/rafiki/startup.ts` (no terminal, `TERM=dumb`, a terminal
too small to draw in):

- what happened (this window is the old Windows console, which cannot draw the
  full screen interface);
- open Windows Terminal (from the Microsoft Store, or
  `winget install --id Microsoft.WindowsTerminal`) and run `rafikicode` there;
- or give the task directly: `rafikicode run "your task"`.

Only the full screen interface (the default command, and `attach`, which share
`Startup.terminal()`) is refused. `run`, `login`, `doctor`, `--version`,
`--help` and every other command never reach the check.

`rafikicode doctor` gains one line on Windows, `terminal`, saying whether this
console can draw the interface. It is a warning, not a failure, because `run`
works in that console.

## How to tell the old console from a terminal that works

Signals considered:

| signal | verdict |
|---|---|
| `WT_SESSION` (Windows Terminal) | set by Windows Terminal, but inherited by every process started from it, including a classic console window opened with `start powershell`. Not proof of anything about the current window. |
| `TERM_PROGRAM` (VS Code, WezTerm), `ConEmuANSI` | the same inheritance problem; ConEmu is kept as an override because it draws its own window over a hidden console. |
| `SetConsoleMode(ENABLE_VIRTUAL_TERMINAL_PROCESSING)` on the output handle | Microsoft's documented test for a console that cannot interpret escape sequences: it fails with `ERROR_INVALID_PARAMETER` before Windows 10 1511 and with the "Use legacy console" option on. A console that refuses it cannot draw anything. |
| `GetConsoleWindow()` and the class of that window | Windows Terminal, VS Code, WezTerm, Alacritty and the OpenSSH server all host the program through a pseudo console (ConPTY), whose window is an invisible `PseudoConsoleWindow`. The classic console host shows a visible `ConsoleWindowClass` window. winpty (mintty in Git Bash) and ConEmu use a hidden `ConsoleWindowClass` window. |

Chosen detection, in this order, Windows only:

1. `RAFIKICODE_FORCE_TUI=1`: start anyway (an escape hatch for a console that
   works better than expected).
2. Turn virtual terminal processing on for the output handle. If the console
   refuses it, refuse: nothing can be drawn.
3. If the console window is a visible `ConsoleWindowClass` window and ConEmu is
   not drawing over it, refuse: this is the classic console host.
4. Anything else starts: a pseudo console, a hidden console (winpty, ConEmu),
   no console window at all (SSH), or any failure of the probe itself. When in
   doubt the interface starts, as it does today.

The probe is a small module with the Windows calls behind an interface, so the
decision is unit tested on Linux with injected environment and a stubbed
console mode and window.

## Tests

- Unit: the decision for each case above with a stubbed probe.
- The real entry point on a pseudo terminal (existing style in
  `test/rafiki/startup.test.ts`): on Linux the check does not apply and the
  interface still takes the screen over.
- Doctor: the `terminal` line on an injected Windows platform, absent elsewhere.
- Cross build `windows-x64` and run it under Wine in a throwaway container
  `cli-conhost-...`: the Windows calls load and the message path does not
  crash. Wine's console is not the real console host, so this proves the probe
  runs, not that it classifies a real Windows 10 window correctly.

## Docs

`docs/troubleshooting.md` and `docs/install.md` Windows sections, one CHANGELOG
line.

## Second item on this branch: `run` hangs in the home folder

Reported on the same laptop: `rafikicode run "say hello"` started in
`C:\Users\<name>` printed the agent line and then hung; only the title request
reached the gateway. To be investigated on Linux with a large tree and a fake
gateway before any change; the cause and the fix are recorded in the results
below.

Owner decision, recorded before the fix: started from the home folder or a
filesystem or drive root (not itself a git repository), the interface and
`run` work in `<home>/RafikiCode`, created on first use (mode 700 on Unix),
and print one line saying so. `--dir`, the interface's project argument and
`RAFIKICODE_NO_DEFAULT_WORKSPACE=1` keep the current directory. Both
installers create the folder and name it in their next steps. Separately, the
first model request must never wait on an unbounded scan.

## Third item: first run audit findings N30, N31, N33

- N30: `install.ps1` under `irm | iex` ends the user's session on any error.
  The body runs in a script block; a failure prints and ends the block; only
  a run as a file exits 1, through iex it returns with `$LASTEXITCODE` 1.
- N31: `install.ps1` never names `rafikicode login`. Its next steps name
  login, doctor and the RafikiCode folder.
- N33: a user not yet approved waits ten minutes in `login`. The Console's
  token endpoint cannot tell (the device code stays `authorization_pending`,
  because `/device` sends a pending user to `/approval-pending`), so the CLI
  says once after two minutes that a new account may still be waiting, the
  expiry message says so, and a new `account_pending` answer, specified in
  `docs/contracts/device-account-pending.md`, stops `login` at once. The
  Console side of that answer is not on this branch.

## Results

Further items were added to this branch after the plan was written, each by
the owner: the folder doctor (the start folder, home, temporary, config, data,
cache and state folders, the disk), the temporary folder fallback of the
installers, and a fallback for every problem the installers meet. They are
recorded here with what was done.

### Windows console

- Detection, Windows only: `RAFIKICODE_FORCE_TUI=1` starts anyway; virtual
  terminal processing is turned on for the output handle and a console that
  refuses it is refused; a visible `ConsoleWindowClass` window (the classic
  console host) is refused unless ConEmu draws over it; a pseudo console, a
  hidden console (winpty, ConEmu), no console window (SSH) or any failure of
  the probe starts. Environment variables decide nothing on their own.
- Only the interface and `attach` are refused, with exit 7. `doctor` gains a
  `terminal` line on Windows.
- Cross built `windows-x64` and run under Wine 9.0 in throwaway containers:
  `--version` runs; with the console answer forced to the old console the
  message prints and the exit code is 7; with the real probe, `doctor` reports
  `WineConsoleClass`, which is not a refusal. Wine proves the Windows calls
  load and the message path does not crash; it is not the real console host,
  so it does not prove the classification of a Windows 10 window.

### `run` hangs in the home folder

- Cause, reproduced on Linux: the working tree snapshot taken before the first
  model request stages every untracked file with one pathspec each, which
  grows with the square of the count (10k files 2 s, 40k files 31 s), and a
  home folder that is a git repository never finishes. Only the title request
  reaches the gateway, which is the owner's symptom.
- Fix: snapshots are skipped in the home folder and at a root, and bounded to
  10,000 files and 10 seconds elsewhere. Started from a folder that is not a
  project, the interface and `run` work in `~/RafikiCode` (owner decision).

### Folder doctor

- Before anything is loaded (`rafiki/folders-early.ts`): home, temporary,
  config, data, cache and state folders, each fixed in one line when it can
  be. The runtime reads the home folder once at start, so a replaced home also
  names the XDG folders and the home override outright. A compiled binary
  whose temporary folder had to change starts itself again, because it reads
  TMPDIR once at start.
- In the command line middleware (`rafiki/workspace.ts`): the start folder
  (home, root, system folders, Desktop, Downloads, OneDrive roots, more than
  50,000 files outside git with a 2 second limit, deleted, unwritable, no
  answer in 2 seconds) and one warning under 500 MB free.
- `rafikicode doctor` lists every check; `doctor --folders` only those.

### Installers

- `install.sh`: wget, python3 or perl without curl; bsdtar, busybox or python3
  without a working tar or unzip; the direct latest address after the API and
  the release page; proxies in either case; three tries for a cut download or
  a wrong checksum; the clock named on a TLS failure it causes; the temporary
  folder and the install folder fall back; HOME from the password database;
  root through sudo into a user's home refused; an older copy first on PATH
  named and outranked; the PATH line for bash, zsh and fish; a closing check
  (program, gateway, folders) in green or red; `install.log` on failure.
- `install.ps1`: the same where Windows has the problem, plus the system proxy
  with the user's credentials, antivirus removing the binary, the conhost tip
  only in what looks like that window, and safe under `irm | iex`.
- Install folder order: the folder asked for, then `~/.rafikicode/bin`, then
  `~/.local/bin`. The owner's list named `~/.local/bin` first; it is second
  because `rafikicode update` recognises only `~/.rafikicode/bin` as this
  installer's channel.

### Login (N33)

- The Console cannot yet tell the CLI that an account is pending: `/device`
  sends a pending user to the approval page and the code stays pending. The
  CLI says so after two minutes and in the expiry message, and stops at once
  on `account_pending`, specified in `docs/contracts/device-account-pending.md`
  for the Console to send.

### Checks before pushing

| check | result |
|---|---|
| `bun turbo typecheck --concurrency=3` | 30 of 30 |
| `node docs/check.mjs` | passed |
| `test/brand`, `test/installation`, `test/rafiki` (startup included) | 663 pass, 0 fail |
| full `packages/opencode` suite, once | 4352 pass, 22 skip, 1 todo, 3 fail: the two known root only failures, and "max: a continuation after a cut keeps the stable prefix" (a 60 s timeout under load; the file passes on its own, see below) |
| `install/test-install.sh` | 79 passed |
| `install/test-install-ps1.sh` (PowerShell 7 in a container) | 11 passed |
| `install/test-install-containers.sh` (Debian, Ubuntu, Alpine, Fedora, as root and as a normal user through `su -`, and a binary built from this branch under a read only /tmp) | 24 passed |
| `install/test-install-url.sh`, `test-install-shells.sh`, `test-release-gate.sh` | 54, 10 and 27 passed |

A finding outside this branch: `integration-set.test.ts`, "the closing line
names the call that reported no usage", fails now and then under load, on
this branch and in a run of the whole suite. When the cut arrives before the
stream handler has stored the text, the step is sent again from the start
instead of being continued. The answer is still right and the run exits 0;
only the continuation is lost. The file passed three times in a row on the
line and on this branch when run on its own.

### Fixes after an independent run in containers

- A normal user on Alpine with no startup file got none written, because
  `/etc/profile` was a candidate; as root the PATH line went into
  `/etc/profile`. Only the user's own files are written now, and `~/.profile`
  (or `~/.zprofile`) is made when there is no login file.
- Every temporary folder fallback (full, unwritable, read only, noexec) now
  writes `export TMPDIR=$HOME/.rafikicode/tmp` into the same startup files as
  the PATH line, once, and prints it for the current window. The closing
  check runs in a fresh login shell with nothing inherited.
- In a compiled binary the folder checks ran after the folders were in use:
  the bundler evaluates modules with a top level await first. The compiled
  entry is now `src/main.ts`, which runs them, then loads the rest with a
  dynamic import. Checked with a binary built from this branch: under a read
  only /tmp with no TMPDIR, `--version`, `run` (to the gateway) and `doctor
  --folders` work.
- BusyBox wget is used with the options it has; a downloader that fails hands
  over to the next one on the machine.
- A missing C++ runtime: the remedy first, the loader output cut to three
  lines, the administrator named for a normal user, the cause in
  `install.log`.
- `install.ps1`: a temporary folder without room or that cannot be written
  falls back to `%USERPROFILE%\.rafikicode\tmp`; `powershell -c "irm ... |
  iex"` exits 1 on failure and 0 on success.
