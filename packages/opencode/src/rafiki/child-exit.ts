// How a binary that started itself again passes on the way its child ended.
//
// rafikicode starts itself a second time in a few places: with a fixed
// temporary folder (rafiki/folders-early.ts, rafiki/exec-tmp.ts), after an
// update (rafiki/autoupdate.ts), and to reopen another folder
// (rafiki/history.ts). The parent waits and exits with the child's code. When
// the child was killed instead, there is no code, and `process.exit(status ??
// 1)` returned to the prompt with nothing on screen: the shell prints "Killed"
// only for its own child, which is the parent. On a shared host whose memory
// limit ends the child, that was the whole report: a line about the start
// folder, then the prompt.
//
// So a child that was ended by a signal the user did not send is reported here,
// in one plain line with the cause and the fix, and the exit code is non-zero
// (128 plus the signal number, as a shell reports it).
//
// Imported by rafiki/folders-early.ts, so node built ins and the brand
// constants only.
import os from "os"
import { Brand } from "@opencode-ai/core/brand/brand"

// Signals a person sends from the terminal or a supervisor sends to stop a
// program: the child stopping for one of these is what was asked for.
const asked = new Set(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGPIPE"])

export function code(signal: string) {
  const number = (os.constants.signals as Record<string, number>)[signal]
  return 128 + (number ?? 1)
}

// The one line for a child that ended on signal, or undefined when the signal
// is one the user sent.
export function line(signal: string): string | undefined {
  if (asked.has(signal)) return undefined
  if (signal === "SIGKILL")
    return `${Brand.name} was stopped by the system (${signal}), most often because this account reached its memory limit. Close other programs and try again, use ${Brand.name} run "your task", which needs less memory, or ask your host to raise the memory limit.`
  return `${Brand.name} stopped unexpectedly (${signal}). Run ${Brand.name} doctor, try ${Brand.name} run "your task", and if it happens again report it at ${Brand.issues}.`
}

// Puts the terminal back the way the interface found it: a child killed while
// drawing leaves the alternate screen, mouse reporting and a hidden cursor on.
function restoreTerminal() {
  if (!process.stdout.isTTY) return
  try {
    process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1049l\x1b[?25h\x1b[0m")
  } catch {}
}

// Exits with the way the child ended. A status is passed on as it is; a signal
// is reported, when the user did not send it, and becomes 128 plus its number.
export function passOn(
  run: { status: number | null; signal: NodeJS.Signals | string | null },
  exit: (code: number) => never = process.exit,
  write: (text: string) => void = (text) => process.stderr.write(text),
): never {
  if (run.status !== null && run.status !== undefined) return exit(run.status)
  if (run.signal) {
    const said = line(run.signal)
    if (said) {
      restoreTerminal()
      write(said + "\n")
    }
    return exit(code(run.signal))
  }
  write(`${Brand.name} stopped while starting, and the reason could not be read. Run ${Brand.name} doctor, then try again.\n`)
  return exit(1)
}
