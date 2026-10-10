// Recent conversations and projects for the terminal interface's History
// panel. Pure, no I/O: the conversations are the sessions the local server
// already lists across projects (GET /experimental/session, the list the
// session commands use), and the projects are the folders those sessions
// were worked in, newest first. No store of its own.
//
// Builder projects of code.rafikiai.io are not listed: the builder's
// orchestrator answers only to a service token signed by the Console or the
// builder web, and has no route that lists an owner's sessions, so a Rafiki
// Code key cannot list them.
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
