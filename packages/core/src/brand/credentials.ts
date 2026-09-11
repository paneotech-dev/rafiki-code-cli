// Stored credential for the Rafiki gateway, written by `rafikicode login` and
// read by the brand config so the gateway provider appears once a login
// exists. Synchronous on purpose: the brand config is built before any
// service layer runs. Field names follow the device flow token response in
// platform/docs/rafiki-code-contract-v1.md; the file is private to this
// machine and never leaves it.
import fs from "fs"
import path from "path"

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

export function read(dir: string): StoredCredential | undefined {
  try {
    const raw = fs.readFileSync(file(dir), "utf8")
    const data = JSON.parse(raw)
    if (!data || typeof data !== "object") return undefined
    if (data.version !== 1 || typeof data.key !== "string" || !data.key) return undefined
    return data as StoredCredential
  } catch {
    return undefined
  }
}

export function write(dir: string, credential: StoredCredential) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  // mkdirSync leaves an existing directory's mode alone; the contract wants 0700.
  fs.chmodSync(dir, DIR_MODE)
  const target = file(dir)
  const tmp = target + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(credential, null, 2) + "\n", { mode: FILE_MODE })
  fs.chmodSync(tmp, FILE_MODE)
  fs.renameSync(tmp, target)
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
  return fs.existsSync(file(dir))
}
