// Workspace trust for rafikicode (docs/security/workspace-trust.md).
//
// A workspace is a directory tree the user starts rafikicode in. Files in it
// may be hostile, so code declared by the workspace (project plugins, custom
// tools, TUI plugins, provider SDK packages) only loads from a trusted
// workspace, and headless runs of an untrusted workspace also get no local
// MCP, formatter or language server commands and no shell permission from it.
//
// A workspace is trusted when:
//   - it is at or under a directory stored with `rafikicode trust <dir>`
//     (in ~/.rafikicode/trusted-workspaces.json), or
//   - RAFIKICODE_TRUST_WORKSPACE is 1 or true (trust this run's workspace), or
//     a list of directories separated by the path delimiter.
//
// The user's own config directory (~/.rafikicode, XDG_CONFIG_HOME/rafikicode,
// or OPENCODE_CONFIG_DIR) is never a workspace, unless the home based one sits
// inside a git checkout (HOME set to a checkout in some CI images).
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { Brand } from "./brand"

// The switch. Change this one value to move the product default:
//   "trusted"      project code loads only from trusted workspaces, in the
//                  terminal interface and in headless runs. Shipped default.
//   "interactive"  upstream behaviour for a person at a terminal (project code
//                  loads without asking); headless runs still require trust.
export type ProjectCode = "trusted" | "interactive"
export const PROJECT_CODE: ProjectCode = "trusted"

export const storeName = "trusted-workspaces.json"

function falsey(value: string | undefined) {
  return value === undefined || value === "" || ["0", "false", "no"].includes(value.toLowerCase())
}

export function real(p: string): string {
  const resolved = path.resolve(p)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    // A path that does not exist (yet): resolve its closest existing parent.
    const parent = path.dirname(resolved)
    if (parent === resolved) return resolved
    return path.join(real(parent), path.basename(resolved))
  }
}

// True when target is root or inside it. Both should already be real paths.
export function inside(root: string, target: string) {
  if (target === root) return true
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return target.startsWith(prefix)
}

// The closest directory at or above dir holding a .git entry, if any.
export function gitRoot(dir: string) {
  let current = real(dir)
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

// True when the home based config directory is part of a git checkout, so its
// content came with the repository rather than from the user.
export function homeConfigInCheckout() {
  if (process.env["XDG_CONFIG_HOME"] || process.env["OPENCODE_CONFIG_DIR"]) return false
  return gitRoot(path.dirname(Brand.configDir())) !== undefined
}

// The user's own config directory: trusted like the user's own files.
export function isUserConfigDir(dir: string) {
  const target = real(dir)
  const explicit = process.env["OPENCODE_CONFIG_DIR"]
  if (explicit && target === real(explicit)) return true
  if (target !== real(Brand.configDir())) return false
  return !homeConfigInCheckout()
}

// Headless: nobody at a terminal can answer a question. CI, GitHub Actions, or
// `rafikicode run` without a terminal on stdin and stdout (marked at start).
export function headless() {
  if (!falsey(process.env["CI"])) return true
  if (process.env["GITHUB_ACTIONS"] === "true") return true
  return process.env[Brand.env.headless] === "1"
}

// Called before every command (src/index.ts). The marker is an env var so the
// worker threads and child processes of this run see it too. It only ever
// makes a run stricter.
export function markHeadless(command: unknown, tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY }) {
  if (command !== "run") return
  if (tty.stdin && tty.stdout) return
  process.env[Brand.env.headless] = "1"
}

function envTrust() {
  const value = process.env[Brand.env.trustWorkspace]
  if (falsey(value)) return { all: false, dirs: [] as string[] }
  if (["1", "true", "yes"].includes(value!.toLowerCase())) return { all: true, dirs: [] as string[] }
  return { all: false, dirs: value!.split(path.delimiter).filter((d) => path.isAbsolute(d)) }
}

export function storeFile() {
  return path.join(Brand.configDir(), storeName)
}

// The stored trusted directories. A store that is a link, belongs to another
// user, can be written by others, or came with a checkout is not used.
export function stored(): string[] {
  if (homeConfigInCheckout()) return []
  const file = storeFile()
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) return []
    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return []
      if (stat.mode & 0o022) return []
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    const list = Array.isArray(raw?.workspaces) ? raw.workspaces : []
    return list.filter((d: unknown): d is string => typeof d === "string" && path.isAbsolute(d))
  } catch {
    return []
  }
}

function save(list: string[]) {
  const dir = Brand.configDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = storeFile()
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
  try {
    fs.writeSync(fd, JSON.stringify({ workspaces: list }, null, 2) + "\n")
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temp, file)
}

export class TrustError extends Error {
  override readonly name = "RafikiTrustError"
}

// Stores dir (its real path) as trusted. Returns the stored path.
export function add(dir: string) {
  const target = real(dir)
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new TrustError(`${target} is not a directory.`)
  if (target === path.parse(target).root) throw new TrustError(`Refusing to trust the whole file system (${target}).`)
  if (homeConfigInCheckout()) {
    throw new TrustError(`${Brand.configDir()} is inside a git checkout, so trust cannot be stored there. Set ${Brand.env.trustWorkspace} instead.`)
  }
  const list = stored()
  if (!list.includes(target)) save([...list, target])
  return target
}

// Removes dir from the store. Returns true when it was there.
export function remove(dir: string) {
  const target = real(dir)
  const list = stored()
  if (!list.includes(target)) return false
  save(list.filter((d) => d !== target))
  return true
}

// Where a directory's trust comes from, or undefined when it is not trusted.
export function trustedBy(dir: string): "env" | "store" | undefined {
  const target = real(dir)
  const fromEnv = envTrust()
  if (fromEnv.all) return "env"
  if (fromEnv.dirs.some((root) => inside(real(root), target))) return "env"
  if (stored().some((root) => inside(real(root), target))) return "store"
  return undefined
}

export function isTrusted(dir: string) {
  return trustedBy(dir) !== undefined
}

// May code declared in this project directory load? Pure core for tests.
export function allowsCode(input: { trusted: boolean; headless: boolean; mode?: ProjectCode }) {
  if (input.trusted) return true
  if (input.headless) return false
  return (input.mode ?? PROJECT_CODE) === "interactive"
}

export function allowsProjectCode(dir: string) {
  return allowsCode({ trusted: isTrusted(dir), headless: headless() })
}

// For a directory of plugins or tools: the user's config dir always loads,
// a project directory only when its code is allowed.
export function allowsCodeDir(dir: string) {
  return isUserConfigDir(dir) || allowsProjectCode(dir)
}

// Set by tests to capture warnings instead of writing to stderr.
let warn: (message: string) => void = (message) => process.stderr.write(message + "\n")
export function setWarn(fn: (message: string) => void) {
  const previous = warn
  warn = fn
  return previous
}
const warned = new Set<string>()
export function resetWarnings() {
  warned.clear()
}
export function warnOnce(key: string, message: string) {
  if (warned.has(key)) return
  warned.add(key)
  warn(message)
}

export function untrustedHint(dir: string) {
  return `this workspace is not trusted. Run ${Brand.name} trust ${gitRoot(dir) ?? dir} to trust it, or set ${Brand.env.trustWorkspace}=1 for one run`
}

// Filters plugin specs found in a directory or declared by a project file.
export function plugins<L extends readonly unknown[]>(where: string, list: L | undefined): L | undefined {
  if (!list?.length) return list
  if (allowsCodeDir(where)) return list
  warnOnce(`plugins:${where}`, `Warning: not loading ${list.length} project plugin${list.length === 1 ? "" : "s"} from ${where}: ${untrustedHint(where)}.`)
  return [] as unknown as L
}

// Runs self only when code may load from dir: the background dependency
// install into a project .rafikicode or .opencode directory is skipped for an
// untrusted one, since nothing it installs would be imported.
export function whenCodeDir(dir: string) {
  return <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | void, E, R> => (allowsCodeDir(dir) ? self : Effect.void)
}

// Filters the plugin and tool directories a registry scans.
export function codeDirs(dirs: readonly string[]) {
  return dirs.filter((dir) => {
    if (allowsCodeDir(dir)) return true
    const hasCode = ["tool", "tools"].some((sub) => {
      try {
        return fs.readdirSync(path.join(dir, sub)).some((f) => /\.(js|ts)$/.test(f))
      } catch {
        return false
      }
    })
    if (hasCode) warnOnce(`tools:${dir}`, `Warning: not loading project tools from ${dir}: ${untrustedHint(dir)}.`)
    return false
  })
}

// Permission defaults for headless runs: the shell asks, and `rafikicode run`
// rejects a question nobody can answer. Global config, OPENCODE_PERMISSION,
// a trusted workspace's config or `run --auto` still allow it.
export function headlessPermission(): { bash?: "ask" } {
  return headless() ? { bash: "ask" } : {}
}
