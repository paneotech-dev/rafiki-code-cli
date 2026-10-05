// The default workspace: where rafikicode works when it is started from the
// home folder or from the root of a filesystem or drive.
//
// Why this file exists: on Windows a new terminal opens in C:\Users\<name>,
// and `rafikicode run "say hello"` started there printed its first line and
// then hung, while the same command answered at once from an empty folder.
// Neither the home folder nor a root is a project, and treating one as the
// project means walking a tree of unbounded size (the whole profile, AppData
// included) before the first request. So when the interface or `run` starts in
// one of those, and it is not itself a git repository, it works in
// <home>/RafikiCode instead, created on first use, and says so in one line.
//
// It never applies when the user named a directory (`--dir` for run, the
// project argument for the interface), nor with RAFIKICODE_NO_DEFAULT_WORKSPACE=1.
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"

export const FOLDER = "RafikiCode"
export const OPT_OUT = "RAFIKICODE_NO_DEFAULT_WORKSPACE"

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

// "home" for the home folder, "root" for the root of a filesystem or drive
// (`/`, `C:\`, `\\server\share\`), undefined for anything else.
export function where(dir: string, home = os.homedir(), platform: string = process.platform): "home" | "root" | undefined {
  const target = norm(dir, platform)
  if (target === norm(paths(platform).parse(paths(platform).resolve(dir)).root, platform)) return "root"
  if (home && target === norm(home, platform)) return "home"
  return undefined
}

export function homeOrRoot(dir: string, home = os.homedir(), platform: string = process.platform) {
  return where(dir, home, platform) !== undefined
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
  // Is this directory itself a git repository? A home folder kept under git
  // (dotfiles) is a project its owner chose.
  repository: (dir: string) => boolean
}

export interface Decision {
  directory: string
  message: string
}

// Which directory to work in instead of the current one, or undefined to stay.
export function decide(input: Input): Decision | undefined {
  if (input.command !== undefined && input.command !== "run") return undefined
  if (input.explicit !== undefined && input.explicit !== "") return undefined
  if (input.attach) return undefined
  if (input.env[OPT_OUT] === "1") return undefined
  if (!input.home) return undefined
  const kind = where(input.cwd, input.home, input.platform)
  if (!kind) return undefined
  if (input.repository(input.cwd)) return undefined
  const directory = paths(input.platform).join(input.home, FOLDER)
  const from =
    kind === "home"
      ? "started from your home folder"
      : `started from ${input.cwd}, the root of ${input.platform === "win32" ? "a drive" : "the file system"}`
  return {
    directory,
    message: `Working in ${directory} (${from}). Run ${Brand.name} inside a project folder to work on it.`,
  }
}

function repository(dir: string) {
  try {
    return fs.existsSync(path.join(dir, ".git"))
  } catch {
    return false
  }
}

// Called from the command line middleware before any command runs. Moves the
// process into the default workspace when the rules above say so, creating it
// on first use, and prints the one line on stderr so a script reading the
// answer on stdout is not disturbed.
export function apply(opts: { _: (string | number)[]; dir?: unknown; project?: unknown; attach?: unknown; help?: unknown }) {
  // Help prints and exits; it works on no directory.
  if (opts.help) return undefined
  const command = opts._[0] === undefined ? undefined : String(opts._[0])
  const explicit = command === "run" ? opts.dir : opts.project
  const decision = decide({
    command,
    explicit: typeof explicit === "string" ? explicit : undefined,
    attach: Boolean(opts.attach),
    cwd: process.cwd(),
    home: os.homedir(),
    env: process.env,
    platform: process.platform,
    repository,
  })
  if (!decision) return undefined
  try {
    fs.mkdirSync(decision.directory, { recursive: true, mode: 0o700 })
    process.chdir(decision.directory)
  } catch (error) {
    // Nowhere to go: stay where the user is, as before.
    process.stderr.write(
      `Could not use ${decision.directory} (${error instanceof Error ? error.message : String(error)}); working in ${process.cwd()}.\n`,
    )
    return undefined
  }
  process.env["PWD"] = decision.directory
  process.stderr.write(decision.message + "\n")
  return decision
}
