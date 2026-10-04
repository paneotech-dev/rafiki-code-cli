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

## Results

To be filled in when the work is done.
