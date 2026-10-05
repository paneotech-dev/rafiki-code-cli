// The folder doctor, first half: the folders rafikicode itself needs, fixed
// before anything else is loaded.
//
// Why this file exists: every one of these used to stop rafikicode, or hang it,
// with a message about a path the user never chose. A home folder that is not
// set or cannot be written (some shared hosts and containers), a temporary
// folder with 0 MB free (/tmp on shared hosting), or a data folder that is a
// file or belongs to someone else. None of them needs the user: there is always
// a folder this account can write to, so the fix is to use it, say so in one
// plain line, and carry on. Nothing here asks a question.
//
// It runs as the first import of src/index.ts (rafiki/folders-early.ts), before
// any module that reads these locations is evaluated: global.ts creates the
// data, config, state and cache folders as it loads, and xdg-basedir reads the
// XDG variables once, when it loads. So this module may import nothing that
// does either: node built ins and the brand constants only.
//
// The checks, in order, each with its fix:
//   home    unset, missing or not writable: a private folder under the
//           temporary folder, then under the current folder; HOME (and
//           USERPROFILE on Windows) point there for this process.
//   temp    missing, not writable or with too little room: <home>/.rafikicode/tmp;
//           TMPDIR, TEMP and TMP point there for this process.
//   config  a file where the folder should be: moved aside and recreated. Not
//           creatable: a fallback under the home folder, then the temporary
//           folder. Present but read only: kept, since a stored sign in is read
//           from it, with one line saying changes are not saved.
//   data, cache, state
//           a file where the folder should be: moved aside and recreated. Not
//           writable: the same fallback, through XDG_DATA_HOME, XDG_CACHE_HOME
//           and XDG_STATE_HOME.
//
// Every result, fixed or not, is kept in report() for `rafikicode doctor`.
//
// Two rules about what is printed and what is believed:
//   - A line about a fix goes to stderr, never to stdout, and not at all when
//     the command's output is read by a program (--version, --help, shell
//     completion): there only what could not be repaired is said. An installer,
//     a release gate or a script that compares the output of --version must
//     get the version and nothing else.
//   - A measurement that cannot be trusted is not a finding. Free space that
//     the system reports with a block size of 0, no blocks at all, or more
//     free blocks than the disk has is "unknown", and an unknown is skipped:
//     it never replaces a folder and never prints a line.
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"

export type Status = "ok" | "fixed" | "warn" | "fail"

export interface Check {
  name: "home" | "temp" | "config" | "data" | "cache" | "state" | "folder" | "disk"
  status: Status
  detail: string
  // The one line printed when something was done or is wrong.
  line?: string
}

export type Env = Record<string, string | undefined>

// The file system calls the checks make, so every case can be driven with fake
// folders in tests: a full disk, a folder that is a file, an unwritable home.
export interface IO {
  // "dir", "file", or undefined when nothing is there (or it cannot be read).
  kind(target: string): "dir" | "file" | undefined
  // Creates the folder (and its parents) and proves a file can be written in
  // it. False when either fails.
  writable(target: string): boolean
  // Free bytes on the disk holding target, or undefined when unknown.
  free(target: string): number | undefined
  // Moves a file out of the way. Returns where it went, or undefined.
  aside(target: string): string | undefined
}

// Room the temporary folder needs: the render library unpacked at every start
// of the interface is a few MB, and tools write there too.
export const TEMP_NEEDS = 64 * 1024 * 1024

export const realIO: IO = {
  kind(target) {
    try {
      const stat = fs.statSync(target)
      return stat.isDirectory() ? "dir" : "file"
    } catch {
      return undefined
    }
  },
  writable(target) {
    const probe = path.join(target, `.${Brand.name}-write-probe-${process.pid}`)
    try {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      fs.writeFileSync(probe, "")
      fs.unlinkSync(probe)
      return true
    } catch {
      try {
        fs.unlinkSync(probe)
      } catch {}
      return false
    }
  },
  free(target) {
    return freeBytes(target)
  },
  aside(target) {
    const moved = `${target}.broken-${Date.now()}`
    try {
      fs.renameSync(target, moved)
      return moved
    } catch {
      return undefined
    }
  },
}

// Free bytes from what statfs answered, or undefined when the answer cannot be
// right: a block size of 0, a disk of no blocks, a negative count, or more free
// blocks than the disk holds. Some file systems (network, FUSE, a few virtual
// ones) and some builds of the runtime answer like that, and "0 MB free" read
// from such an answer replaced a healthy temporary folder at every start.
export function plausibleFree(stat: { bavail: unknown; bsize: unknown; blocks: unknown }): number | undefined {
  const bavail = Number(stat.bavail)
  const bsize = Number(stat.bsize)
  const blocks = Number(stat.blocks)
  if (!Number.isFinite(bavail) || !Number.isFinite(bsize) || !Number.isFinite(blocks)) return undefined
  if (bsize <= 0 || blocks <= 0 || bavail < 0 || bavail > blocks) return undefined
  return bavail * bsize
}

// Free bytes on the disk holding target, or undefined when it is not known.
export function freeBytes(
  target: string,
  statfs: (target: string) => { bavail: unknown; bsize: unknown; blocks: unknown } = fs.statfsSync,
): number | undefined {
  try {
    return plausibleFree(statfs(target))
  } catch {
    return undefined
  }
}

function mb(bytes: number) {
  return Math.floor(bytes / (1024 * 1024))
}

export interface Input {
  env: Env
  platform: string
  cwd: string
  // The temporary folder the platform falls back to with no variable set.
  systemTemp: string
  // Who runs this, for a private fallback folder name.
  user: string
  io: IO
}

export interface Result {
  checks: Check[]
  // Variables to set on this process (and on a restarted one).
  env: Env
}

function homeOf(env: Env, platform: string) {
  return (platform === "win32" ? env["USERPROFILE"] || env["HOME"] : env["HOME"]) || ""
}

function tempOf(env: Env, platform: string, systemTemp: string) {
  return (platform === "win32" ? env["TEMP"] || env["TMP"] : env["TMPDIR"]) || systemTemp
}

export function check(input: Input): Result {
  const { platform, io } = input
  const env: Env = { ...input.env }
  const set: Env = {}
  const checks: Check[] = []
  const assign = (key: string, value: string) => {
    env[key] = value
    set[key] = value
  }

  // home
  let home = homeOf(env, platform)
  if (home && io.kind(home) === "dir" && io.writable(home)) {
    checks.push({ name: "home", status: "ok", detail: `${home} is writable` })
  } else {
    const why = !home ? "is not set" : io.kind(home) === undefined ? `(${home}) does not exist` : `(${home}) cannot be written`
    const candidates = [
      ...new Set([
        path.join(tempOf(env, platform, input.systemTemp), `${Brand.name}-home-${input.user}`),
        path.join(input.systemTemp, `${Brand.name}-home-${input.user}`),
      ]),
      path.join(input.cwd, `.${Brand.name}-home`),
    ]
    const usable = candidates.find((dir) => io.writable(dir))
    if (usable) {
      home = usable
      assign("HOME", usable)
      if (platform === "win32") assign("USERPROFILE", usable)
      // The runtime reads the home folder once, at start (os.homedir() does
      // not follow HOME afterwards), and xdg-basedir and the brand module ask
      // os.homedir(). So the folders below it are named outright: the XDG
      // variables, and the home override global.ts and Brand.configDir read.
      assign("OPENCODE_TEST_HOME", usable)
      for (const [variable, below] of [
        ["XDG_DATA_HOME", [".local", "share"]],
        ["XDG_CACHE_HOME", [".cache"]],
        ["XDG_STATE_HOME", [".local", "state"]],
      ] as const)
        if (!env[variable]) assign(variable, path.join(usable, ...below))
      checks.push({
        name: "home",
        status: "fixed",
        detail: `the home folder ${why}; using ${usable}`,
        line: `Your home folder ${why}, so ${Brand.name} keeps its files in ${usable}.`,
      })
    } else {
      checks.push({
        name: "home",
        status: "fail",
        detail: `the home folder ${why}, and none of ${candidates.join(", ")} can be written`,
        line: `Your home folder ${why}, and no folder this account can write to was found (tried ${candidates.join(", ")}). Set HOME to a folder you own.`,
      })
    }
  }

  // temp
  const temp = tempOf(env, platform, input.systemTemp)
  const tempProblem = (dir: string) => {
    if (io.kind(dir) === "file") return "is a file, not a folder"
    if (!io.writable(dir)) return "cannot be written"
    const free = io.free(dir)
    if (free !== undefined && free < TEMP_NEEDS) return `has ${mb(free)} MB free`
    return undefined
  }
  const tempWhy = tempProblem(temp)
  if (!tempWhy) {
    checks.push({ name: "temp", status: "ok", detail: `${temp} is writable and has room` })
  } else {
    const fallback = path.join(home, Brand.configDirName, "tmp")
    if (home && !tempProblem(fallback)) {
      assign("TMPDIR", fallback)
      assign("TEMP", fallback)
      assign("TMP", fallback)
      checks.push({
        name: "temp",
        status: "fixed",
        detail: `${temp} ${tempWhy}; using ${fallback}`,
        line: `The temporary folder ${temp} ${tempWhy}, so ${Brand.name} uses ${fallback} instead.`,
      })
    } else {
      checks.push({
        name: "temp",
        status: "warn",
        detail: `${temp} ${tempWhy}, and ${fallback} cannot be used either`,
        line: `The temporary folder ${temp} ${tempWhy}, and ${fallback} cannot be used either. Free some space, or set TMPDIR to a folder with room.`,
      })
    }
  }

  // config, data, cache, state
  const fallbackRoots = [
    path.join(home, Brand.configDirName, "fallback"),
    path.join(env["TMPDIR"] ?? temp, `${Brand.name}-${input.user}`),
  ]
  const xdg = (variable: string, below: string[]) => env[variable] || path.join(home, ...below)
  const folders: { name: Check["name"]; dir: string; variable: string; readOnlyOk: boolean }[] = [
    {
      name: "config",
      dir: env["XDG_CONFIG_HOME"] ? path.join(env["XDG_CONFIG_HOME"], Brand.dir) : path.join(home, Brand.configDirName),
      variable: "XDG_CONFIG_HOME",
      readOnlyOk: true,
    },
    { name: "data", dir: path.join(xdg("XDG_DATA_HOME", [".local", "share"]), Brand.dir), variable: "XDG_DATA_HOME", readOnlyOk: false },
    { name: "cache", dir: path.join(xdg("XDG_CACHE_HOME", [".cache"]), Brand.dir), variable: "XDG_CACHE_HOME", readOnlyOk: false },
    { name: "state", dir: path.join(xdg("XDG_STATE_HOME", [".local", "state"]), Brand.dir), variable: "XDG_STATE_HOME", readOnlyOk: false },
  ]
  for (const folder of folders) {
    const label = `the ${folder.name} folder ${folder.dir}`
    if (io.kind(folder.dir) === "file") {
      const moved = io.aside(folder.dir)
      if (moved && io.writable(folder.dir)) {
        checks.push({
          name: folder.name,
          status: "fixed",
          detail: `${folder.dir} was a file; moved to ${moved} and recreated`,
          line: `${folder.dir} was a file, not a folder: moved it to ${moved} and made a new folder.`,
        })
        continue
      }
    }
    if (io.writable(folder.dir)) {
      checks.push({ name: folder.name, status: "ok", detail: `${folder.dir} is writable` })
      continue
    }
    if (folder.readOnlyOk && io.kind(folder.dir) === "dir") {
      checks.push({
        name: folder.name,
        status: "warn",
        detail: `${folder.dir} is read only`,
        line: `${label} is read only: ${Brand.name} reads its settings and sign in from it, but cannot save changes there.`,
      })
      continue
    }
    const root = fallbackRoots.find((dir) => io.writable(path.join(dir, folder.name)))
    if (root) {
      const base = path.join(root, folder.name)
      assign(folder.variable, base)
      const now = path.join(base, Brand.dir)
      checks.push({
        name: folder.name,
        status: "fixed",
        detail: `${folder.dir} cannot be written; using ${now}`,
        line: `${label} cannot be written, so ${Brand.name} uses ${now} instead.`,
      })
      continue
    }
    checks.push({
      name: folder.name,
      status: "fail",
      detail: `${folder.dir} cannot be written, and no fallback can be either`,
      line: `${label} cannot be written, and no other folder this account can write to was found.`,
    })
  }

  return { checks, env: set }
}

// What this process found, for `rafikicode doctor`.
let last: Check[] = []

// The home folder this process uses: the replacement when there was one.
export function homeDir() {
  return process.env["OPENCODE_TEST_HOME"] ?? os.homedir()
}

export function report(): readonly Check[] {
  return last
}

export function remember(checks: Check[]) {
  last = [...last.filter((item) => !checks.some((next) => next.name === item.name)), ...checks]
}

function user(env: Env) {
  try {
    return os.userInfo().username || env["USER"] || env["USERNAME"] || String(process.getuid?.() ?? "user")
  } catch {
    return env["USER"] || env["USERNAME"] || "user"
  }
}

function systemTemp(platform: string) {
  if (platform === "win32") return path.join(process.env["SystemRoot"] || "C:\\Windows", "Temp")
  return "/tmp"
}

function cwd() {
  try {
    return process.cwd()
  } catch {
    return os.tmpdir()
  }
}

// Is the output of this command line read by a program rather than a person?
// --version and --help (and their short forms) anywhere before a bare "--",
// and the shell completion commands. For these the lines about a fix are not
// printed: `rafikicode --version` prints the version and nothing else.
export function machineRead(args: readonly string[]): boolean {
  const own = args.includes("--") ? args.slice(0, args.indexOf("--")) : args
  if (own.some((item) => item === "--version" || item === "-v" || item === "--help" || item === "-h")) return true
  if (own.includes("--get-yargs-completions")) return true
  return own.find((item) => !item.startsWith("-")) === "completion"
}

// The lines to print for these checks. Everything that was done or is wrong,
// or, with quiet, only what could not be repaired (a warning or a failure).
export function lines(checks: readonly Check[], quiet = false): string[] {
  return checks
    .filter((item) => item.line && (!quiet || item.status === "warn" || item.status === "fail"))
    .map((item) => item.line!)
}

// Runs the checks for this process, sets what they changed, and prints one line
// for each fix on stderr (with quiet, only what could not be repaired). Returns
// the variables that were changed, so the caller can decide whether the process
// has to start again with them.
export function apply(
  options: { env?: Env; platform?: string; io?: IO; print?: boolean; quiet?: boolean } = {},
) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const io = options.io ?? realIO
  const result = check({ env, platform, cwd: cwd(), systemTemp: systemTemp(platform), user: user(env), io })
  for (const [key, value] of Object.entries(result.env)) process.env[key] = value
  remember(result.checks)
  if (options.print !== false) for (const line of lines(result.checks, options.quiet)) process.stderr.write(line + "\n")
  return result
}
