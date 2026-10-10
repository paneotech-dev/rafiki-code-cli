// Project memory in a session (core/brand/memory.ts holds the files and the
// rules). The memory text is read once per session and kept: every request of
// the session sends the same bytes in the stable system prefix, so a write in
// the middle of a session never breaks the prompt cache. The next session, or
// this one after it is compacted, reads the files again.
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Memory from "@opencode-ai/core/brand/memory"

export { Memory }

export interface Settings {
  enabled?: boolean
  max_bytes?: number
}

export function enabled(settings: Settings | undefined, env: Record<string, string | undefined> = process.env) {
  return Memory.enabled(settings, env[Brand.env.memory])
}

export function limit(settings: Settings | undefined) {
  return Memory.cap(settings)
}

// Sessions alive in this process are few; the oldest snapshots go first past this many.
const KEEP = 200
const snapshots = new Map<string, string>()

// The memory text for a session's system prompt, the same on every request of
// the session. Empty when the memory is off.
export function forSession(input: {
  sessionID: string
  directory: string
  worktree: string
  settings: Settings | undefined
  env?: Record<string, string | undefined>
}): string {
  // Nothing is read from the working tree when project files are not trusted.
  if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG || !enabled(input.settings, input.env)) return ""
  const known = snapshots.get(input.sessionID)
  if (known !== undefined) return known
  const text = Memory.prompt({ project: Memory.root(input.directory, input.worktree), limit: limit(input.settings) })
  snapshots.set(input.sessionID, text)
  while (snapshots.size > KEEP) snapshots.delete(snapshots.keys().next().value!)
  return text
}

// Forgets a session's snapshot, so its next request reads the files again (after compaction).
export function refresh(sessionID: string) {
  snapshots.delete(sessionID)
}

// The line added to the message that resumes work after an automatic compaction.
export const AFTER_COMPACTION =
  "The conversation was just compacted. If the summary holds decisions or progress that the project memory does not have yet, record them with memory_update first, in a few short entries."

// True when a path is one of the memory files (or in their folder).
export function isMemoryPath(file: string): boolean {
  const parts = path.resolve(file).split(path.sep)
  const fold = process.platform === "win32" || process.platform === "darwin"
  const norm = (value: string) => (fold ? value.toLowerCase() : value)
  for (let i = 0; i < parts.length - 1; i++) {
    if (norm(parts[i]) === Memory.FOLDER && norm(parts[i + 1]) === "memory") return true
  }
  return false
}

// File tools call this before they write: the memory changes only through memory_update.
export function refuseEdit(file: string | undefined) {
  if (!file || !isMemoryPath(file)) return
  throw new Error(
    `${Memory.DIR_POSIX}/ is the project memory: change it with the memory_update tool (section, operation, text), not with file edits. The user edits it with /memory.`,
  )
}
