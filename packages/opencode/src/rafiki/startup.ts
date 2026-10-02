// The diagnosis layer for failures that stop rafikicode before it can work.
//
// Why this file exists: the top level handler in src/index.ts printed
// "Error: Unexpected error" followed by the raw error message for anything
// FormatError did not recognise. A user on a shared host whose /tmp is mounted
// noexec saw a dlopen string and a first line telling them nobody had
// anticipated their situation, twice, and gave up. The cause was real and
// fixable; the report was not legible.
//
// So: classify what went wrong, name the probable cause, give one command the
// user can paste, always name the ways out (doctor, and the non interactive
// run command, which needs no render library), and never swallow the original
// error. The original message is always written to stderr, and the full error
// with its stack follows when the run asked for logs (--print-logs,
// --log-level DEBUG, or RAFIKICODE_VERBOSE=1), because an error a user can
// paste to us is worth more than a tidy terminal.
//
// Classification reads the error text only, so a cause nobody anticipated
// still gets the unknown class, which carries the ways out and the original
// error rather than a dead end. One class knows more than the text: the render
// library failing to load is diagnosed by probing the temporary directories
// for real (rafiki/exec-tmp.ts), and that probe's words become the cause here.
// The report around them is this file's either way, for every class alike.
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import { errorFormat, errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { UI } from "@/cli/ui"
import * as Contract from "./contract"
import * as ExecTmp from "./exec-tmp"

export type Kind =
  | "native_library"
  | "illegal_instruction"
  | "libc_mismatch"
  | "no_writable_directory"
  | "terminal"
  | "unknown"

export interface Diagnosis {
  kind: Kind
  // First line, after the red "Error: " prefix.
  headline: string
  // Why this most likely happened, naming the path or value involved.
  cause: string
  // One command the user can paste. Printed on its own line.
  step: string
  // Which ways out to offer below the step. Only the ones that still work for
  // this kind of failure: offering `run` to someone whose binary will not
  // execute at all wastes their time.
  ways: Way[]
  exitCode: number
}

export type Way = "doctor" | "run" | "report"

const INSTALLER = "curl -fsSL https://get.rafikiai.io | bash"

// Directories rafikicode itself writes to. A permission failure under one of
// these is a rafikicode installation problem; the same code on a file inside
// the user's project is not, and stays unknown.
function ours(target: string) {
  const home = os.homedir()
  const marks = [
    Brand.configDirName,
    path.sep + Brand.dir,
    path.join(home, ".config"),
    path.join(home, ".cache"),
    path.join(home, ".local"),
    os.tmpdir(),
  ]
  return marks.some((mark) => target.includes(mark))
}

// The error and everything it was caused by. A wrapped failure keeps the text
// that matters in the cause ("Failed to start X", caused by the dlopen error),
// and errorMessage reads only the outermost message, which is how a diagnosable
// cause ends up looking undiagnosable.
function chain(error: unknown, depth = 0): unknown[] {
  if (error === undefined || error === null || depth > 4) return []
  const cause = isRecord(error) ? error["cause"] : undefined
  return [error, ...chain(cause, depth + 1)]
}

function field(error: unknown, key: string) {
  if (!isRecord(error)) return undefined
  const value = error[key]
  return typeof value === "string" ? value : undefined
}

// Every path-like token in the text, so the cause can name the file that
// actually failed instead of leaving the user to find it in a dlopen string.
function paths(text: string) {
  return text.match(/(?:[A-Za-z]:)?[\\/][^\s"'`:,()]+/g) ?? []
}

function library(text: string) {
  return paths(text).find((item) => /\.(so|dylib|dll)(\.\d+)*$/.test(item))
}

function quoted(text: string) {
  const match = text.match(/['"`]([^'"`]+)['"`]/)
  return match?.[1]
}

export function diagnose(
  error: unknown,
  // What the temporary directory probe makes of a render library failure.
  // Injectable so the report for "no directory on this machine will run a
  // file" can be tested where such a directory cannot be created.
  detail: (input: unknown) => ExecTmp.Detail | undefined = ExecTmp.explain,
): Diagnosis {
  const links = chain(error)
  const text = links
    .flatMap((link) => [errorMessage(link), errorFormat(link), field(link, "code") ?? "", field(link, "path") ?? ""])
    .join("\n")
  const lower = text.toLowerCase()

  // A libc mismatch also produces "cannot open shared object file", so it is
  // tested before the native library class.
  if (
    /glibc_\d|\bglibc\b|\bmusl\b|ld-linux|ld-musl|symbol lookup error|libc\.so/.test(lower) &&
    !/opentui|render library/.test(lower)
  ) {
    const musl = /musl/.test(lower)
    return {
      kind: "libc_mismatch",
      headline: `${Brand.product} cannot start: this build does not match the system C library of this machine.`,
      cause: musl
        ? "Probable cause: this machine uses musl (Alpine Linux and similar), and the installed build needs glibc, or the other way round."
        : `Probable cause: this machine's glibc is older than the installed build needs${
            lower.match(/glibc_[\d.]+/) ? ` (it asks for ${text.match(/GLIBC_[\d.]+/)?.[0]})` : ""
          }.`,
      step: `Reinstall, so the installer picks the build for this machine:${os.EOL}  ${INSTALLER}`,
      ways: ["report"],
      exitCode: Contract.EXIT.machine,
    }
  }

  if (/illegal instruction|sigill|invalid instruction|unsupported cpu|\bavx2?\b|\bsse4/.test(lower)) {
    return {
      kind: "illegal_instruction",
      headline: `${Brand.product} cannot start: it stopped on an instruction this machine's CPU would not run.`,
      // Not a reinstall. The published builds need no AVX or AVX2: this binary
      // has been driven on an emulated 2008 Nehalem with neither, and all four
      // archives labelled "baseline" are byte for byte the sibling they sit
      // beside, so there is no other build for the installer to fetch. An
      // illegal instruction here is a bug in the build, and the CPU it
      // happened on is the thing worth reporting.
      cause:
        "Probable cause: a bug in this build, not the wrong build for this machine. The published builds do not need AVX2 or any other recent instruction, and there is no separate build to install instead, so an illegal instruction here should not happen on any CPU.",
      step: `Note which CPU this is, so the report can name it:${os.EOL}  lscpu || sysctl -n machdep.cpu.brand_string`,
      ways: ["report"],
      exitCode: Contract.EXIT.machine,
    }
  }

  if (
    /failed to map segment from shared object|failed to open library|cannot open shared object|dlopen|exec format error|render library|mmap failed/.test(
      lower,
    )
  ) {
    // What the probe found, when this is the render library failing to load:
    // which directories were tried and why each one refused, that the account
    // is not at fault, and the line to send whoever runs the machine. It knows
    // this machine; the fallback below it knows only the error text. The
    // flattened chain is what it is given, not the error object, because such a
    // failure arrives wrapped as often as not ("Failed to start X", caused by
    // the dlopen error) and the text is where it is recognisable.
    const probed = detail(text)
    if (probed)
      return {
        kind: "native_library",
        headline: `${Brand.product} cannot start: a library it needs could not be loaded on this machine.`,
        cause: probed.cause,
        step: probed.step,
        // The library is the full screen interface's own: the run command
        // needs none of it and keeps working while this is unfixed.
        ways: probed.report ? ["doctor", "run", "report"] : ["doctor", "run"],
        exitCode: Contract.EXIT.machine,
      }
    const file = library(text) ?? quoted(text)
    const dir = file ? path.dirname(file) : os.tmpdir()
    return {
      kind: "native_library",
      headline: `${Brand.product} cannot start: a library it needs could not be loaded on this machine.`,
      cause: `Probable cause: ${dir} does not allow an executable file to be loaded from it (a noexec mount, a common hardening on shared hosts), or it is out of space${
        file ? `, so ${file} could not be mapped` : ""
      }.`,
      step: `Point ${Brand.name} at a temporary directory of your own and run it again:${os.EOL}  mkdir -p ~/${Brand.configDirName}/tmp && TMPDIR=~/${Brand.configDirName}/tmp ${Brand.name}`,
      // The library is the full screen interface's own: the run command needs
      // none of it and keeps working while this is unfixed.
      ways: ["doctor", "run"],
      exitCode: Contract.EXIT.machine,
    }
  }

  const code =
    links.map((link) => field(link, "code")).find((value) => value !== undefined) ??
    text.match(/\b(EACCES|EROFS|ENOSPC|EPERM|ENOTDIR)\b/)?.[1]
  const target =
    links.map((link) => field(link, "path")).find((value) => value !== undefined) ??
    paths(text).find((item) => ours(item))
  if (code && ["EACCES", "EROFS", "ENOSPC", "EPERM", "ENOTDIR"].includes(code) && target && ours(target)) {
    const full = code === "ENOSPC"
    // ENOTDIR means a directory above the target is not a directory at all,
    // which no mkdir will fix: HOME is the usual culprit.
    const notDir = code === "ENOTDIR"
    const where = `${Brand.name} keeps its configuration, logs and session history there`
    return {
      kind: "no_writable_directory",
      headline: `${Brand.product} cannot start: it has no directory it can write to.`,
      cause: full
        ? `Probable cause: the disk holding ${target} is full, and ${where}.`
        : notDir
          ? `Probable cause: something on the way to ${target} is not a directory (${code}), usually because HOME points at a file or at nothing, and ${where}.`
          : `Probable cause: ${target} cannot be created or written (${code}), and ${where}.`,
      step: full
        ? `Free some space on that disk, then run ${Brand.name} again. To keep its files on another disk:${os.EOL}  XDG_DATA_HOME=/path/with/space ${Brand.name}`
        : notDir
          ? `Check where HOME points (echo $HOME), then run ${Brand.name} again. To use another directory for this run:${os.EOL}  HOME=/path/you/own ${Brand.name}`
          : `Give yourself that directory, then run ${Brand.name} again:${os.EOL}  mkdir -p ${target} && chmod 700 ${target}`,
      // Every command needs somewhere to write, so run is not a way out here.
      ways: ["doctor"],
      exitCode: Contract.EXIT.machine,
    }
  }

  if (
    /not a tty|no tty|inappropriate ioctl for device|controlling terminal|tcsetattr|raw mode|terminal size/.test(lower)
  ) {
    return {
      kind: "terminal",
      headline: `${Brand.product} cannot start its full screen interface in this terminal.`,
      cause:
        "Probable cause: this terminal cannot be put into the mode the full screen interface needs (it is not an interactive terminal, or its output is redirected).",
      step: `Give ${Brand.name} the task directly instead:${os.EOL}  ${Brand.name} run "your task"`,
      ways: ["doctor", "run"],
      exitCode: Contract.EXIT.terminal,
    }
  }

  return {
    kind: "unknown",
    headline: `${Brand.product} stopped with a failure it has no diagnosis for.`,
    cause: `Probable cause: unknown. The original error below is the whole of what ${Brand.name} was told, so it is worth reporting.`,
    step: `Start with the self check, in case it names the problem:${os.EOL}  ${Brand.name} doctor`,
    ways: ["doctor", "run", "report"],
    exitCode: Contract.EXIT.failed,
  }
}

// The size drawn at when a terminal does not say how large it is. The render
// library falls back to the same figures on its own.
export const DEFAULT_SIZE = { columns: 80, rows: 24 } as const

// Terminal checks that run before the full screen interface is loaded. The
// renderer's own failure in this case is a native library or ioctl error,
// which reads as a bug rather than as "this terminal cannot do it", so the
// condition is named here while it can still be named plainly.
export function terminal(
  env: Record<string, string | undefined> = process.env,
  out: { isTTY?: boolean; columns?: number; rows?: number } = process.stdout,
): Diagnosis | undefined {
  if (env["RAFIKICODE_TEST_TTY"]) return undefined
  const ways = `Give ${Brand.name} the task directly instead:${os.EOL}  ${Brand.name} run "your task"`

  if (!out.isTTY)
    return {
      kind: "terminal",
      headline: `${Brand.product} cannot start its full screen interface here: standard output is not a terminal.`,
      cause:
        "Probable cause: the output is redirected to a file or a pipe, or this is a job with no terminal attached (CI, cron, a container, ssh with a command). The full screen interface needs a terminal to draw on.",
      step: ways,
      ways: ["doctor", "run"],
      exitCode: Contract.EXIT.terminal,
    }

  const term = env["TERM"]?.toLowerCase()
  if (term === "dumb")
    return {
      kind: "terminal",
      headline: `${Brand.product} cannot start its full screen interface in this terminal.`,
      cause:
        'Probable cause: TERM is "dumb", which means the terminal cannot move the cursor, so nothing can be drawn.',
      step: `Set a terminal type this machine has, or give ${Brand.name} the task directly:${os.EOL}  TERM=xterm-256color ${Brand.name}${os.EOL}  ${Brand.name} run "your task"`,
      ways: ["doctor", "run"],
      exitCode: Contract.EXIT.terminal,
    }

  // A dimension reported as 0, or not reported, means the size is not known,
  // not that there is no room: `docker run -t` with no terminal on the client
  // side, some CI runners and a terminal that has only just been attached all
  // report 0 by 0 on a terminal that draws perfectly well. The render library
  // draws at the default size in that case, so the same figures are assumed
  // here and the start carries on.
  const columns = out.columns || DEFAULT_SIZE.columns
  const rows = out.rows || DEFAULT_SIZE.rows
  // Deliberately far below any usable window: the point is to name a terminal
  // that says it is too small to draw in, not to pick a minimum for people.
  if (columns < 20 || rows < 6)
    return {
      kind: "terminal",
      headline: `${Brand.product} cannot start its full screen interface in a terminal this size.`,
      cause: `Probable cause: this terminal reports ${columns} columns by ${rows} rows, which is too small to draw in.`,
      step: `Make the window larger and run ${Brand.name} again, or give it the task directly:${os.EOL}  ${Brand.name} run "your task"`,
      ways: ["doctor", "run"],
      exitCode: Contract.EXIT.terminal,
    }

  return undefined
}

function verbose(argv: readonly string[] = process.argv, env: Record<string, string | undefined> = process.env) {
  if (env["RAFIKICODE_VERBOSE"] === "1" || env["OPENCODE_PRINT_LOGS"] === "1") return true
  return argv.some(
    (arg, index) =>
      arg === "--print-logs" ||
      arg === "--verbose" ||
      arg === "--log-level=DEBUG" ||
      (arg === "--log-level" && argv[index + 1]?.toUpperCase() === "DEBUG"),
  )
}

// The whole report, as the user sees it, minus the red "Error: " prefix on the
// headline. Kept as one pure function so the tests can read it and so the two
// callers (the top level handler and the terminal preflight) print the same
// shape.
export function render(
  diagnosis: Diagnosis,
  error?: unknown,
  options: { argv?: readonly string[]; env?: Record<string, string | undefined> } = {},
): string {
  const full = verbose(options.argv, options.env)
  const commands: Record<Way, [string, string]> = {
    // Named for what doctor actually checks (configuration, credential,
    // gateway, key, tiers, version), so the offer is not a promise it cannot
    // keep on a machine with a broken library.
    doctor: [`${Brand.name} doctor`, "checks the configuration, the key and the gateway"],
    run: [`${Brand.name} run "your task"`, "does the work without the full screen interface"],
    report: ["", ""],
  }
  // Offered unless the next step above is already that command: a user reads a
  // repeated line as filler.
  const offers = diagnosis.ways
    .filter((way) => way !== "report")
    .map((way) => commands[way])
    .filter(([command]) => !diagnosis.step.includes(command))

  const lines = [diagnosis.headline, "", diagnosis.cause, "", diagnosis.step]
  if (offers.length) {
    lines.push("", offers.length > 1 ? "Ways out, whatever the cause:" : "Also:")
    lines.push(...offers.map(([command, what]) => `  ${command.padEnd(30)}${what}`))
  }
  if (diagnosis.ways.includes("report")) {
    lines.push("", `If that does not help, report it at ${Brand.issues} with the original error below.`)
  }

  if (error !== undefined) {
    const links = chain(error)
    lines.push("", `Original error: ${errorMessage(links[0])}`)
    // Every cause behind it, because the one that names the real problem is
    // often the innermost.
    for (const link of links.slice(1)) lines.push(`Caused by: ${errorMessage(link)}`)
    if (full) lines.push("", ...links.map((link) => errorFormat(link)))
    else lines.push("For the full error and its stack, run the same command with --print-logs.")
  }

  return lines.join(os.EOL) + os.EOL
}

// Print the report and set the exit code. Used by the top level handler and by
// the terminal preflight.
export function report(
  diagnosis: Diagnosis,
  error?: unknown,
  options: { argv?: readonly string[]; env?: Record<string, string | undefined> } = {},
) {
  const text = render(diagnosis, error, options)
  const [headline, ...rest] = text.split(os.EOL)
  UI.error(headline)
  process.stderr.write(rest.join(os.EOL) + os.EOL)
  process.exitCode = diagnosis.exitCode
  return diagnosis
}
