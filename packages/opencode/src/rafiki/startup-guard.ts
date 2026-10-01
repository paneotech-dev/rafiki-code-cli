// Installed as the very first import of src/index.ts, before any module that
// touches the filesystem is evaluated.
//
// Why: the worst startup failures happen while the module graph is still being
// evaluated, so the try/catch around the parser never sees them. A machine with
// no writable home directory crashed with a raw runtime dump
// (`ENOTDIR: not a directory, mkdir '/.../.local/share/rafikicode'`, a syscall
// table, and the runtime's own version footer) and exit code 1, which tells the
// user nothing they can act on. These handlers send that crash through the same
// diagnosis layer as every other startup failure, so the cause, the next step
// and the original error all reach the terminal.
//
// Nothing here is allowed to be expensive or to touch the filesystem on import:
// it must be loadable on the broken machine it exists to report.
import * as Startup from "./startup"

let reported = false

function handle(error: unknown) {
  if (reported) return
  reported = true
  const diagnosis = Startup.report(Startup.diagnose(error), error)
  process.exit(diagnosis.exitCode)
}

export function install() {
  process.on("uncaughtException", handle)
  process.on("unhandledRejection", handle)
}

install()
