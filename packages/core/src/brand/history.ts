// Recent conversations and projects for the terminal interface's History
// panel. Pure, no I/O: the conversations are the sessions the local server
// already lists across projects (GET /experimental/session, the list the
// session commands use), and the projects are the folders those sessions
// were worked in, newest first. No store of its own.
//
// Builder projects of code.rafikiai.io come from the Console
// (GET /api/v1/builder/sessions, read in account.ts with the key in use):
// title, status and time, and the builder page that opens each one. The
// terminal does not resume them; it opens that page in the browser, or shows
// its address when there is no browser.
import os from "os"
import path from "path"

export interface SessionLike {
  id: string
  title: string
  directory: string
  parentID?: string
  time: { created: number; updated: number; archived?: number }
  model?: { id: string; providerID: string }
  cost?: number
}

export interface Conversation {
  id: string
  title: string
  directory: string
  updated: number
  // The tier the conversation last ran on, when it was a Rafiki tier: "fast".
  tier?: string
}

export interface Project {
  directory: string
  updated: number
  conversations: number
}

const TIER = /^rafiki-(fast|pro|max)$/

// Top level conversations, newest activity first, archived ones left out.
export function conversations(sessions: readonly SessionLike[], limit = 50): Conversation[] {
  return sessions
    .filter((item) => !item.parentID && !item.time.archived && item.directory)
    .toSorted((a, b) => b.time.updated - a.time.updated)
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      title: item.title || "Untitled",
      directory: item.directory,
      updated: item.time.updated,
      ...(item.model && TIER.test(item.model.id) ? { tier: TIER.exec(item.model.id)![1] } : {}),
    }))
}

// The folders conversations were worked in, the one worked in last first.
export function projects(list: readonly Conversation[], limit = 20): Project[] {
  const out = new Map<string, Project>()
  for (const item of list) {
    const found = out.get(item.directory)
    if (found) {
      found.conversations++
      found.updated = Math.max(found.updated, item.updated)
      continue
    }
    out.set(item.directory, { directory: item.directory, updated: item.updated, conversations: 1 })
  }
  return [...out.values()].toSorted((a, b) => b.updated - a.updated).slice(0, limit)
}

// "~/work/app" for a folder under the home folder.
export function folder(directory: string, home: string = os.homedir()) {
  if (!home) return directory
  const relative = path.relative(home, directory)
  if (relative === "") return "~"
  if (relative.startsWith("..") || path.isAbsolute(relative)) return directory
  return path.join("~", relative)
}

// "just now", "5 min ago", "3 h ago", "2 days ago", then the date.
export function ago(at: number, now: number = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`
  return new Date(at).toISOString().slice(0, 10)
}

// A title cut to fit, with an ellipsis.
export function clip(text: string, width: number) {
  if (width <= 1) return ""
  return text.length <= width ? text : text.slice(0, width - 1) + "…"
}

// The interface runs in one folder. Opening a conversation or a project in
// another folder ends it and starts it again there: the panel records what
// to open, and the command that started the interface starts it again once
// it has closed (packages/opencode/src/rafiki/history.ts).
export interface Reopen {
  directory: string
  sessionID?: string
}

let pending: Reopen | undefined

export function requestReopen(value: Reopen) {
  pending = value
}

export function takeReopen() {
  const value = pending
  pending = undefined
  return value
}

// The arguments the interface is started again with.
export function reopenArgs(value: Reopen) {
  return value.sessionID ? [value.directory, "--session", value.sessionID] : [value.directory]
}

// A builder project as the History panel shows it.
export interface Build {
  id: string
  title: string
  status: string
  updated: number
  url: string
  // The published app's address, when it is live.
  published?: string
}

const BUILD_ID = /^ses_[0-9a-f-]{36}$/

function webURL(value: unknown) {
  if (typeof value !== "string" || !URL.canParse(value)) return undefined
  const url = new URL(value)
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined
}

// The Console's page of builder projects, newest activity first. An entry
// without an id, a time or a builder page it can open is left out; a body
// that is not a page gives undefined.
export function builds(body: unknown, limit = 5): Build[] | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return undefined
  const out: Build[] = []
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue
    const item = raw as Record<string, unknown>
    if (typeof item.id !== "string" || !BUILD_ID.test(item.id)) continue
    const url = webURL(item.builder_url)
    const updated = Date.parse(String(item.last_activity_at ?? item.created_at ?? ""))
    if (!url || !Number.isFinite(updated)) continue
    const published = webURL(item.published_url)
    out.push({
      id: item.id,
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : "Untitled build",
      status: typeof item.status === "string" && item.status ? item.status : "unknown",
      updated,
      url,
      ...(published ? { published } : {}),
    })
  }
  return out.toSorted((a, b) => b.updated - a.updated).slice(0, limit)
}

// How a builder status reads in the list: "published" when the app is live.
export function buildStatus(item: Build) {
  if (item.published) return "published"
  if (item.status === "ready" || item.status === "running" || item.status === "provisioning") return "open"
  if (item.status === "paused") return "paused"
  if (item.status === "failed") return "failed"
  return "stopped"
}

// Whether a link can be opened in a browser on this machine. No on a Linux
// or BSD without a display (a server, a container, ssh without X
// forwarding), nor over ssh on macOS and Windows, where the browser would
// open on the far side; BROWSER names one explicitly. WSL hands links to
// Windows.
export function browserAvailable(env: Record<string, string | undefined> = process.env, platform: string = process.platform) {
  if (env["BROWSER"]) return true
  const ssh = Boolean(env["SSH_CONNECTION"] || env["SSH_TTY"])
  if (platform === "darwin" || platform === "win32") return !ssh
  if (env["WSL_DISTRO_NAME"]) return true
  return Boolean(env["DISPLAY"] || env["WAYLAND_DISPLAY"])
}
