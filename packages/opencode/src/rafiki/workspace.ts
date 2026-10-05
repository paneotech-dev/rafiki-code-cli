// The folder doctor, second half: the folder rafikicode starts in.
//
// Why this file exists: on Windows a new terminal opens in C:\Users\<name>,
// and `rafikicode run "say hello"` started there printed its first line and
// then hung, while the same command answered at once from an empty folder. The
// home folder is not a project, and treating it as one means walking a tree of
// unbounded size (the whole profile, AppData included) before the first
// request. The same holds for a drive root, a system folder, the Desktop or
// Downloads folder, the root of a OneDrive, and any folder too big to be a
// project. A folder that was deleted, cannot be written or does not answer (a
// disconnected network drive) cannot be worked in at all.
//
// So when the interface or `run` starts in one of those, it works in
// <home>/RafikiCode instead, created on first use, and says so in one line.
// "Too big" is measured, not guessed: a count of files that stops at
// TOO_MANY_FILES or after PROBE_MS, whichever comes first, and skips the
// folders every project has a lot of (node_modules and the like). Every
// question about the folder is asked with a time limit, so a folder that does
// not answer cannot hang the start either. Once the folder is chosen, a disk
// with less than LOW_DISK free gets one warning.
//
// It never moves a run whose folder the user named (`--dir` for run, the
// project argument for the interface), nor with RAFIKICODE_NO_DEFAULT_WORKSPACE=1.
// A folder that is itself a git repository is a project its owner chose (a
// home folder kept under git, for example) and is kept, unless it cannot be
// used at all.
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import { homeDir } from "./folders"

export const FOLDER = "RafikiCode"
export const OPT_OUT = "RAFIKICODE_NO_DEFAULT_WORKSPACE"
export const TOO_MANY_FILES = 50_000
export const PROBE_MS = 2_000
export const LOW_DISK = 500 * 1024 * 1024
// Folders a project holds many files in that say nothing about whether the
// folder is a project: skipped by the count.
export const SKIPPED = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "vendor",
  ".gradle",
  ".cache",
  "Pods",
  "bin",
  "obj",
])

type Env = Record<string, string | undefined>

function paths(platform: string) {
  return platform === "win32" ? path.win32 : path.posix
}

function norm(value: string, platform: string) {
  const p = paths(platform)
  const resolved = p.resolve(value)
  const root = p.parse(resolved).root
  // Trailing separators off, except the root's own.
  const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, "") : resolved
  return platform === "win32" ? trimmed.toLowerCase() : trimmed
}

function inside(dir: string, parent: string, platform: string) {
  const a = norm(dir, platform)
  const b = norm(parent, platform)
  const sep = platform === "win32" ? "\\" : "/"
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

// Folders of the operating system: never a project, and often huge.
function systemFolders(env: Env, platform: string) {
  if (platform === "win32") {
    const list = [env["SystemRoot"] || env["windir"] || "C:\\Windows"]
    for (const key of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"]) {
      if (env[key]) list.push(env[key]!)
    }
    if (list.length === 1) list.push("C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData")
    return { under: list, exact: [] as string[] }
  }
  const under = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/boot", "/proc", "/sys", "/dev", "/run"]
  if (platform === "darwin") under.push("/System", "/Library", "/private/etc", "/private/var")
  return { under, exact: ["/root", "/var", "/opt", "/home", "/Users", "/Applications", "/Volumes", "/mnt", "/media"] }
}

export type Kind = "home" | "root" | "system" | "personal" | "onedrive"

// What kind of folder this is, when it is one that is never a project.
export function where(
  dir: string,
  home = os.homedir(),
  platform: string = process.platform,
  env: Env = process.env,
): { kind: Kind; label: string } | undefined {
  const p = paths(platform)
  const target = norm(dir, platform)
  if (target === norm(p.parse(p.resolve(dir)).root, platform))
    return { kind: "root", label: `the root of ${platform === "win32" ? "a drive" : "the file system"}` }
  if (home && target === norm(home, platform)) return { kind: "home", label: "your home folder" }
  const system = systemFolders(env, platform)
  if (system.under.some((item) => inside(dir, item, platform)) || system.exact.some((item) => target === norm(item, platform)))
    return { kind: "system", label: "a system folder" }
  const onedrive = [env["OneDrive"], env["OneDriveConsumer"], env["OneDriveCommercial"]].filter(Boolean) as string[]
  if (onedrive.some((item) => target === norm(item, platform))) return { kind: "onedrive", label: "the root of your OneDrive" }
  if (home && /^onedrive( - .+)?$/i.test(p.basename(target)) && norm(p.dirname(dir), platform) === norm(home, platform))
    return { kind: "onedrive", label: "the root of your OneDrive" }
  const personal = home
    ? [
        [p.join(home, "Desktop"), "your Desktop folder"],
        [p.join(home, "Downloads"), "your Downloads folder"],
        ...onedrive.map((item) => [p.join(item, "Desktop"), "your Desktop folder"]),
      ]
    : []
  for (const [folder, label] of personal) if (target === norm(folder!, platform)) return { kind: "personal", label: label! }
  return undefined
}

export function homeOrRoot(dir: string, home = os.homedir(), platform: string = process.platform) {
  const found = where(dir, home, platform, {})
  return found?.kind === "home" || found?.kind === "root"
}

// What the start needs to know about a folder, each answer within a time limit.
export interface Probe {
  // "ok", "missing" (deleted), "unwritable", or "unreachable" (no answer in time).
  access(dir: string): Promise<"ok" | "missing" | "unwritable" | "unreachable">
  // Is this folder the top of a git repository?
  repository(dir: string): boolean
  // Is it anywhere inside a git work tree?
  inRepository(dir: string): boolean
  // Files counted, stopping at limit or after ms; done is false when it stopped early.
  count(dir: string, limit: number, ms: number): Promise<{ files: number; done: boolean }>
  // Free bytes on the disk holding dir.
  free(dir: string): number | undefined
}

function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

export const realProbe: Probe = {
  access(dir) {
    const check = (async () => {
      try {
        const stat = await fs.promises.stat(dir)
        if (!stat.isDirectory()) return "missing" as const
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return code === "ENOENT" || code === "ENOTDIR" ? ("missing" as const) : ("unwritable" as const)
      }
      try {
        await fs.promises.access(dir, fs.constants.W_OK)
        return "ok" as const
      } catch {
        return "unwritable" as const
      }
    })()
    return within(check, PROBE_MS, "unreachable" as const)
  },
  repository(dir) {
    try {
      return fs.existsSync(path.join(dir, ".git"))
    } catch {
      return false
    }
  },
  inRepository(dir) {
    let current = path.resolve(dir)
    while (true) {
      if (realProbe.repository(current)) return true
      const up = path.dirname(current)
      if (up === current) return false
      current = up
    }
  },
  async count(dir, limit, ms) {
    const deadline = Date.now() + ms
    const queue = [dir]
    let files = 0
    while (queue.length) {
      if (Date.now() > deadline) return { files, done: false }
      const next = queue.shift()!
      let entries: fs.Dirent[]
      try {
        entries = await within(fs.promises.readdir(next, { withFileTypes: true }), Math.max(1, deadline - Date.now()), [])
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIPPED.has(entry.name)) queue.push(path.join(next, entry.name))
          continue
        }
        files++
        if (files >= limit) return { files, done: false }
      }
    }
    return { files, done: true }
  },
  free(dir) {
    try {
      const stat = fs.statfsSync(dir)
      return Number(stat.bavail) * Number(stat.bsize)
    } catch {
      return undefined
    }
  },
}

export interface Input {
  // The command yargs is about to run: undefined for the interface.
  command: string | undefined
  // A directory the user named: --dir for run, the project argument for the
  // interface. Either one wins over the default workspace.
  explicit?: string
  // run --attach works on a remote server, where this machine's folders mean
  // nothing.
  attach?: boolean
  cwd: string
  home: string
  env: Env
  platform: string
  probe: Probe
}

export interface Decision {
  // The folder to work in instead, or undefined to stay.
  directory?: string
  // What was found, for doctor: "ok", or the reason for the move.
  finding: string
  message?: string
}

// The one question every case shares: should this start leave the folder it is in?
export async function decide(input: Input): Promise<Decision | undefined> {
  if (input.command !== undefined && input.command !== "run") return undefined
  if (input.explicit !== undefined && input.explicit !== "") return undefined
  if (input.attach) return undefined
  if (input.env[OPT_OUT] === "1") return undefined
  return inspect(input)
}

// The same verdict without the rules about commands and flags, for doctor.
export async function inspect(input: Omit<Input, "command" | "explicit" | "attach">): Promise<Decision> {
  if (!input.home) return { finding: "no home folder to fall back to" }
  const p = paths(input.platform)
  const directory = p.join(input.home, FOLDER)
  const move = (why: string, finding: string): Decision => ({
    directory,
    finding,
    message: `Working in ${directory} (${why}). Run ${Brand.name} inside a project folder to work on it.`,
  })
  if (norm(input.cwd, input.platform) === norm(directory, input.platform)) return { finding: "the default workspace" }

  const access = await input.probe.access(input.cwd)
  if (access === "missing") return move("the folder you started in no longer exists", "the start folder no longer exists")
  if (access === "unreachable")
    return move(
      `started from ${input.cwd}, which did not answer within ${PROBE_MS / 1000} seconds, perhaps a disconnected network drive`,
      "the start folder did not answer",
    )

  const kind = where(input.cwd, input.home, input.platform, input.env)
  if (kind && !input.probe.repository(input.cwd)) {
    const why = kind.kind === "home" ? "started from your home folder" : `started from ${input.cwd}, ${kind.label}`
    return move(why, `the start folder is ${kind.label}`)
  }
  if (access === "unwritable")
    return move(`started from ${input.cwd}, which this account cannot write to`, "the start folder cannot be written")
  if (!kind && !input.probe.inRepository(input.cwd)) {
    const counted = await input.probe.count(input.cwd, TOO_MANY_FILES, PROBE_MS)
    if (!counted.done)
      return move(
        `started from ${input.cwd}, which holds more than ${counted.files.toLocaleString("en-US")} files and is not a git repository`,
        "the start folder is too big to be a project",
      )
  }
  return { finding: "ok" }
}

// One warning when the disk under the folder is nearly full.
export function diskWarning(dir: string, probe: Probe): string | undefined {
  const free = probe.free(dir)
  if (free === undefined || free >= LOW_DISK) return undefined
  return `Only ${Math.floor(free / (1024 * 1024))} MB free on the disk holding ${dir}. ${Brand.name} saves sessions and checkpoints there; free some space so they do not fail.`
}

function current() {
  try {
    return process.cwd()
  } catch {
    // The folder was deleted under the shell; PWD still names it.
    return process.env["PWD"] || os.homedir()
  }
}

// Called from the command line middleware before any command runs. Moves the
// process into the default workspace when the rules above say so, creating it
// on first use, and prints the one line on stderr so a script reading the
// answer on stdout is not disturbed.
export async function apply(
  opts: { _: (string | number)[]; dir?: unknown; project?: unknown; attach?: unknown; help?: unknown },
  probe: Probe = realProbe,
) {
  // Help prints and exits; it works on no directory.
  if (opts.help) return undefined
  const command = opts._[0] === undefined ? undefined : String(opts._[0])
  const explicit = command === "run" ? opts.dir : opts.project
  const decision = await decide({
    command,
    explicit: typeof explicit === "string" ? explicit : undefined,
    attach: Boolean(opts.attach),
    cwd: current(),
    home: homeDir(),
    env: process.env,
    platform: process.platform,
    probe,
  })
  if (decision?.directory) {
    try {
      fs.mkdirSync(decision.directory, { recursive: true, mode: 0o700 })
      process.chdir(decision.directory)
      process.env["PWD"] = decision.directory
      process.stderr.write(decision.message + "\n")
    } catch (error) {
      // Nowhere to go: stay where the user is, as before.
      process.stderr.write(
        `Could not use ${decision.directory} (${error instanceof Error ? error.message : String(error)}); working in ${current()}.\n`,
      )
    }
  }
  if (decision) {
    const warning = diskWarning(current(), probe)
    if (warning) process.stderr.write(warning + "\n")
  }
  return decision
}
