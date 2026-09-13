// Stored credential for the Rafiki gateway, written by `rafikicode login` and
// read by the brand config so the gateway provider appears once a login
// exists. Synchronous on purpose: the brand config is built before any
// service layer runs. Field names follow the device flow token response in
// platform/docs/rafiki-code-contract-v1.md; the file is private to this
// machine and never leaves it.
import fs from "fs"
import path from "path"
import { randomBytes } from "crypto"

export interface StoredOwner {
  id: string
  email?: string
  name?: string
}

export interface StoredCredential {
  version: 1
  // The gateway virtual key. The only secret in the file.
  key: string
  key_id?: string
  key_alias?: string
  // "session" for a browser sign-in, "server" for a key made on the /keys page.
  // A session credential is refused when CI is set (contract, Server keys).
  kind?: "session" | "server"
  gateway_url: string
  console_url: string
  scope?: string
  owner?: StoredOwner
  // RFC 3339, when the key stops working at the gateway.
  expires_at?: string
  created_at: string
  // RFC 3339, last successful rotation, used to keep rotation to once an hour.
  refreshed_at?: string
}

export const FILE_MODE = 0o600
export const DIR_MODE = 0o700
export const FILE_NAME = "credentials"

export function file(dir: string) {
  return path.join(dir, FILE_NAME)
}

// A credential file is refused, the way ssh refuses a private key, when it is
// a symbolic link, is not a regular file, belongs to another user, or can be
// read or written by anyone but its owner. RAFIKICODE_API_KEY keeps working.
export const EXIT_UNSAFE = 2

export class UnsafeCredentialError extends Error {
  override readonly name = "UnsafeCredentialError"
  readonly exitCode = EXIT_UNSAFE
  constructor(
    readonly file: string,
    readonly reason: string,
    readonly fix: string,
  ) {
    super(`The credential file ${file} ${reason}, so it is not used. Fix it with: ${fix}`)
  }
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined
}

function unsafe(target: string, stat: fs.Stats, uid: number | undefined) {
  const mode = stat.mode & 0o777
  const chmod = `chmod ${FILE_MODE.toString(8)} ${target}`
  if (!stat.isFile()) return new UnsafeCredentialError(target, "is not a regular file", `rm -r ${target}, then sign in again`)
  if (uid !== undefined && stat.uid !== uid) {
    return new UnsafeCredentialError(target, `belongs to another user (uid ${stat.uid})`, `chown ${uid} ${target} && ${chmod}`)
  }
  if (mode & 0o077) {
    return new UnsafeCredentialError(target, `can be read or written by other users (mode ${mode.toString(8).padStart(4, "0")})`, chmod)
  }
  return undefined
}

function open(target: string) {
  return fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
}

// The reason the stored file may not be used, or undefined when it is missing
// or safe. uid is the expected owner, the current user by default.
export function check(dir: string, uid: number | undefined = currentUid()): UnsafeCredentialError | undefined {
  if (process.platform === "win32") return undefined
  const target = file(dir)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(target)
  } catch {
    return undefined
  }
  if (stat.isSymbolicLink()) {
    return new UnsafeCredentialError(target, "is a symbolic link", `rm ${target}, then sign in again`)
  }
  return unsafe(target, stat, uid) ?? checkDir(dir, uid)
}

// Reads the stored credential. Throws UnsafeCredentialError for an unsafe file
// (see check); returns undefined when there is no usable credential.
export function read(dir: string, uid: number | undefined = currentUid()): StoredCredential | undefined {
  const target = file(dir)
  let raw: string
  if (process.platform === "win32") {
    try {
      raw = fs.readFileSync(target, "utf8")
    } catch {
      return undefined
    }
  } else {
    let fd: number
    try {
      // O_NOFOLLOW: a link swapped in after check() still fails here (ELOOP).
      fd = open(target)
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === "ELOOP" || code === "EMLINK") {
        throw new UnsafeCredentialError(target, "is a symbolic link", `rm ${target}, then sign in again`)
      }
      return undefined
    }
    try {
      // The checks run on the open descriptor, so they describe the bytes read;
      // the directory check refuses a file others could have swapped in.
      const problem = unsafe(target, fs.fstatSync(fd), uid) ?? checkDir(dir, uid)
      if (problem) throw problem
      raw = fs.readFileSync(fd, "utf8")
    } catch (cause) {
      if (cause instanceof UnsafeCredentialError) throw cause
      return undefined
    } finally {
      fs.closeSync(fd)
    }
  }
  try {
    const data = JSON.parse(raw)
    if (!data || typeof data !== "object") return undefined
    if (data.version !== 1 || typeof data.key !== "string" || !data.key) return undefined
    return data as StoredCredential
  } catch {
    return undefined
  }
}

// The directory must be a real directory owned by the current user. A symbolic
// link or a foreign owner could redirect the write.
function ownDir(dir: string, stat: fs.Stats, uid: number | undefined) {
  if (stat.isSymbolicLink()) {
    return new UnsafeCredentialError(dir, "is a symbolic link", `rm ${dir}, then sign in again`)
  }
  if (!stat.isDirectory()) return new UnsafeCredentialError(dir, "is not a directory", `rm ${dir}, then sign in again`)
  if (uid !== undefined && stat.uid !== uid) {
    return new UnsafeCredentialError(dir, `belongs to another user (uid ${stat.uid})`, `chown ${uid} ${dir} && chmod ${DIR_MODE.toString(8)} ${dir}`)
  }
  return undefined
}

// The directory the credential lives in must be a real directory owned by the
// current user that nobody else can write to: in a directory other users can
// write, they could replace the credential file between the checks and the
// read, whatever the file's own mode. On Windows the ACL decides; not checked.
export function checkDir(dir: string, uid: number | undefined = currentUid()): UnsafeCredentialError | undefined {
  if (process.platform === "win32") return undefined
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(dir)
  } catch {
    return undefined
  }
  const problem = ownDir(dir, stat, uid)
  if (problem) return problem
  const mode = stat.mode & 0o777
  if (mode & 0o022) {
    return new UnsafeCredentialError(dir, `can be changed by other users (mode ${mode.toString(8).padStart(4, "0")})`, `chmod ${DIR_MODE.toString(8)} ${dir}`)
  }
  return undefined
}

// Writes through a new temp file with a random name, created exclusively
// (O_EXCL does not follow a planted link) and then renamed over the target.
export function write(dir: string, credential: StoredCredential, uid: number | undefined = currentUid()) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  if (process.platform !== "win32") {
    const problem = ownDir(dir, fs.lstatSync(dir), uid)
    if (problem) throw problem
    // mkdirSync leaves an existing directory's mode alone (an installer's
    // mkdir -p under umask 002 gives 0775); the contract wants 0700, and the
    // directory is ours, so it is tightened before the checks below.
    fs.chmodSync(dir, DIR_MODE)
    const after = checkDir(dir, uid)
    if (after) throw after
  } else {
    fs.chmodSync(dir, DIR_MODE)
  }
  const target = file(dir)
  const tmp = `${target}.${randomBytes(8).toString("hex")}.tmp`
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), FILE_MODE)
  try {
    try {
      if (process.platform !== "win32") fs.fchmodSync(fd, FILE_MODE)
      fs.writeFileSync(fd, JSON.stringify(credential, null, 2) + "\n")
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, target)
  } catch (cause) {
    fs.rmSync(tmp, { force: true })
    throw cause
  }
}

export function remove(dir: string) {
  try {
    fs.unlinkSync(file(dir))
    return true
  } catch {
    return false
  }
}

export function exists(dir: string) {
  try {
    fs.lstatSync(file(dir))
    return true
  } catch {
    return false
  }
}
