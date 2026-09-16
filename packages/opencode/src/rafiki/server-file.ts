// rafikicode serve and web on 127.0.0.1 without a password (UU finding 4).
//
// A local server with no password lets any program or user on the machine
// read files as the user (the credentials file included) and open a terminal.
// So when serve or web start on a loopback address and no password is set,
// they make a random one for that server, require it, and write it to a file
// only the user can read:
//
//   <config dir>/servers/<port>.json   (config dir: ~/.rafikicode by default)
//   directory 0700, file 0600, written through an exclusive temp file and a
//   rename, removed when the server exits.
//
// rafikicode attach and run --attach read that file when they are given a
// loopback URL and no password. The file is used only when it and its
// directory belong to this user and nobody else can read them, and when the
// PID in it is a live process of this user. A file whose process is gone is
// stale: it is ignored and removed.
//
// A password the person set (RAFIKICODE_SERVER_PASSWORD, OPENCODE_SERVER_PASSWORD
// or --password) keeps the earlier behaviour: no file is written or read. An
// address other machines can reach still needs a password the person chose.
//
// The password is never printed. The notice names the file only.
import fs from "fs"
import path from "path"
import { randomBytes } from "crypto"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as BrandServe from "@opencode-ai/core/brand/serve"

export const DIR_NAME = "servers"
export const DIR_MODE = 0o700
export const FILE_MODE = 0o600
// The contract's usage exit code, as for the other refusals of the server.
export const EXIT_UNSAFE = BrandServe.EXIT_REFUSED

export interface ServerFile {
  version: 1
  port: number
  pid: number
  hostname: string
  username: string
  password: string
  created_at: string
}

export interface Secret {
  password: string
  generated: boolean
}

type Env = Record<string, string | undefined>

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined
}

export function dir(configDir: string = Brand.configDir()) {
  return path.join(configDir, DIR_NAME)
}

export function file(port: number, directory: string = dir()) {
  return path.join(directory, `${port}.json`)
}

export class UnsafeServerDirError extends Error {
  override readonly name = "UnsafeServerDirError"
  constructor(
    readonly target: string,
    readonly reason: string,
  ) {
    super(
      `The server directory ${target} ${reason}, so the server password cannot be stored safely. Fix the directory, or set ${BrandServe.passwordEnv} to choose a password.`,
    )
  }
}

// Why a directory may not hold a server file, or undefined when it is fine.
// strict: nobody else may read it either (the servers directory itself).
function dirProblem(target: string, uid: number | undefined, strict: boolean) {
  if (process.platform === "win32") return undefined
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(target)
  } catch {
    return undefined
  }
  if (stat.isSymbolicLink()) return new UnsafeServerDirError(target, "is a symbolic link")
  if (!stat.isDirectory()) return new UnsafeServerDirError(target, "is not a directory")
  if (uid !== undefined && stat.uid !== uid) return new UnsafeServerDirError(target, `belongs to another user (uid ${stat.uid})`)
  const mode = stat.mode & 0o777
  if (mode & (strict ? 0o077 : 0o022)) {
    return new UnsafeServerDirError(target, `can be ${strict ? "read or changed" : "changed"} by other users (mode ${mode.toString(8).padStart(4, "0")})`)
  }
  return undefined
}

// Creates the servers directory (0700) under the config directory and checks
// both. Throws UnsafeServerDirError when either is not safe to use.
export function ensureDir(directory: string = dir(), uid: number | undefined = currentUid()) {
  const parent = path.dirname(directory)
  fs.mkdirSync(parent, { recursive: true, mode: DIR_MODE })
  const parentProblem = dirProblem(parent, uid, false)
  if (parentProblem) throw parentProblem
  try {
    fs.mkdirSync(directory, { mode: DIR_MODE })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause
  }
  if (process.platform !== "win32") {
    const stat = fs.lstatSync(directory)
    // Only a real directory of this user is tightened; anything else is refused below.
    if (stat.isDirectory() && !stat.isSymbolicLink() && (uid === undefined || stat.uid === uid)) fs.chmodSync(directory, DIR_MODE)
  }
  const problem = dirProblem(directory, uid, true)
  if (problem) throw problem
  return directory
}

// Writes the file through an exclusive temp file (O_EXCL does not follow a
// planted link) and renames it over the target.
export function write(info: ServerFile, directory: string = dir(), uid: number | undefined = currentUid()) {
  ensureDir(directory, uid)
  const target = file(info.port, directory)
  const tmp = `${target}.${randomBytes(8).toString("hex")}.tmp`
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), FILE_MODE)
  try {
    try {
      if (process.platform !== "win32") fs.fchmodSync(fd, FILE_MODE)
      fs.writeFileSync(fd, JSON.stringify(info, null, 2) + "\n")
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, target)
  } catch (cause) {
    fs.rmSync(tmp, { force: true })
    throw cause
  }
  return target
}

function parse(raw: string): ServerFile | undefined {
  try {
    const data = JSON.parse(raw)
    if (!data || typeof data !== "object" || data.version !== 1) return undefined
    if (typeof data.password !== "string" || !data.password) return undefined
    if (!Number.isInteger(data.port) || !Number.isInteger(data.pid) || data.pid <= 0) return undefined
    if (typeof data.username !== "string" || !data.username) return undefined
    return data as ServerFile
  } catch {
    return undefined
  }
}

// Removes the file of this process only (a newer server on the same port keeps its own).
export function remove(port: number, pid: number = process.pid, directory: string = dir()) {
  const target = file(port, directory)
  try {
    const stat = fs.lstatSync(target)
    if (!stat.isFile()) return false
    const data = parse(fs.readFileSync(target, "utf8"))
    if (data && data.pid !== pid) return false
    fs.unlinkSync(target)
    return true
  } catch {
    return false
  }
}

// True when pid is a running process of this user. On Linux the owner of
// /proc/<pid> is compared, which also covers root (kill(pid, 0) always
// succeeds for root); elsewhere EPERM from kill(pid, 0) means another user.
export function liveProcessOf(pid: number, uid: number | undefined = currentUid()) {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (uid === undefined || process.platform !== "linux") return true
  try {
    return fs.statSync(`/proc/${pid}`).uid === uid
  } catch {
    return false
  }
}

export type Lookup =
  | { status: "none" }
  | { status: "found"; file: string; info: ServerFile }
  | { status: "stale"; file: string }
  | { status: "rejected"; file: string; reason: string }

export interface LookupOptions {
  directory?: string
  uid?: number
  alive?: (pid: number, uid: number | undefined) => boolean
}

function portOf(url: URL) {
  if (url.port) return Number(url.port)
  if (url.protocol === "http:") return 80
  if (url.protocol === "https:") return 443
  return undefined
}

// Finds the server file for a loopback URL. Only "found" carries a password.
export function lookup(address: string, options: LookupOptions = {}): Lookup {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return { status: "none" }
  }
  if (!BrandServe.loopback(url.hostname)) return { status: "none" }
  const port = portOf(url)
  if (port === undefined) return { status: "none" }
  const uid = "uid" in options ? options.uid : currentUid()
  const alive = options.alive ?? liveProcessOf
  const directory = options.directory ?? dir()
  const target = file(port, directory)
  if (process.platform === "win32") {
    let raw: string
    try {
      raw = fs.readFileSync(target, "utf8")
    } catch {
      return { status: "none" }
    }
    const info = parse(raw)
    if (!info || info.port !== port) return { status: "rejected", file: target, reason: "is not a valid server file" }
    if (!alive(info.pid, uid)) {
      fs.rmSync(target, { force: true })
      return { status: "stale", file: target }
    }
    return { status: "found", file: target, info }
  }
  let fd: number
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code === "ELOOP" || code === "EMLINK") return { status: "rejected", file: target, reason: "is a symbolic link" }
    if (code === "EACCES") return { status: "rejected", file: target, reason: "cannot be read by this user" }
    return { status: "none" }
  }
  let info: ServerFile | undefined
  try {
    const stat = fs.fstatSync(fd)
    const dirIssue = dirProblem(directory, uid, true)
    if (dirIssue) return { status: "rejected", file: target, reason: `is in a directory that ${dirIssue.reason}` }
    if (!stat.isFile()) return { status: "rejected", file: target, reason: "is not a regular file" }
    if (uid !== undefined && stat.uid !== uid) return { status: "rejected", file: target, reason: `belongs to another user (uid ${stat.uid})` }
    const mode = stat.mode & 0o777
    if (mode & 0o077) {
      return { status: "rejected", file: target, reason: `can be read or written by other users (mode ${mode.toString(8).padStart(4, "0")})` }
    }
    info = parse(fs.readFileSync(fd, "utf8"))
  } finally {
    fs.closeSync(fd)
  }
  if (!info || info.port !== port) return { status: "rejected", file: target, reason: "is not a valid server file" }
  if (!alive(info.pid, uid)) {
    // The file is this user's and its server is gone: clean it up.
    remove(port, info.pid, directory)
    return { status: "stale", file: target }
  }
  return { status: "found", file: target, info }
}

export interface Credentials {
  password?: string
  username?: string
}

// The credentials a client (attach, run --attach) sends: a password given
// with --password or in the environment wins; otherwise the server file of a
// loopback URL. warn receives one line when a file exists but is not used.
export function credentials(
  address: string,
  given: Credentials,
  env: Env = process.env,
  options: LookupOptions = {},
  warn: (line: string) => void = (line) => process.stderr.write(line + "\n"),
): Credentials {
  if (given.password || Brand.server.password(env)) return given
  const found = lookup(address, options)
  if (found.status === "rejected") warn(`Warning: not using the server file ${found.file}: it ${found.reason}.`)
  if (found.status !== "found") return given
  return { password: found.info.password, username: given.username ?? Brand.server.username(env) ?? found.info.username }
}

// serve and web, before listening. Applies the listen rule (an address other
// machines can reach needs a password the person chose) and, for a loopback
// address without a password, makes one and puts it in the environment for
// the listener to read. undefined means the command must stop (the exit code
// is set and the reason printed).
export function prepare(
  opts: { hostname: string },
  env: Env = process.env,
  print: (line: string) => void = (line) => process.stderr.write(line + "\n"),
): Secret | undefined {
  const existing = Brand.server.password(env)
  if (existing) return { password: existing, generated: false }
  if (!BrandServe.loopback(opts.hostname)) {
    print(BrandServe.check({ hostname: opts.hostname }).refuse!)
    process.exitCode = BrandServe.EXIT_REFUSED
    return undefined
  }
  try {
    ensureDir()
  } catch (cause) {
    print(`Error: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exitCode = EXIT_UNSAFE
    return undefined
  }
  const password = randomBytes(32).toString("base64url")
  env[Brand.server.env.password] = password
  return { password, generated: true }
}

export function notice(target: string, username: string) {
  return `Server password: stored in ${target} (user name ${username}). ${Brand.name} attach and run --attach on this machine read it from there; other programs must send it. Set ${BrandServe.passwordEnv} to choose your own.`
}

const SIGNALS: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }

// serve and web, once listening. With a generated password: writes the
// server file, prints the notice, removes the password from the environment
// (tools, terminals and MCP servers started later do not inherit it) and
// removes the file when the process exits. A file that cannot be written
// stops the server (exit 2): nobody could attach to it.
export function publish(
  secret: Secret,
  server: { hostname: string; port: number },
  env: Env = process.env,
  print: (line: string) => void = (line) => process.stderr.write(line + "\n"),
) {
  if (!secret.generated) return undefined
  const username = Brand.server.username(env) ?? Brand.name
  let target: string
  try {
    target = write({
      version: 1,
      port: server.port,
      pid: process.pid,
      hostname: server.hostname,
      username,
      password: secret.password,
      created_at: new Date().toISOString(),
    })
  } catch (cause) {
    print(`Error: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exit(EXIT_UNSAFE)
  }
  forget(secret, env)
  const cleanup = () => {
    remove(server.port)
  }
  process.on("exit", cleanup)
  for (const [signal, number] of Object.entries(SIGNALS)) {
    process.once(signal as NodeJS.Signals, () => {
      cleanup()
      process.exit(128 + number)
    })
  }
  print(notice(target, username))
  return target
}

export function forget(secret: Secret, env: Env = process.env) {
  if (secret.generated && env[Brand.server.env.password] === secret.password) delete env[Brand.server.env.password]
}
