// Stuck detection: a turn that keeps failing the same way is told so plainly,
// once, instead of spending its time and budget on more of the same.
//
// Two patterns count, within one turn (from the message the user wrote):
// - the same tool call failing three times: a tool that ends in an error with
//   the same input (for edit, write and read: the same file and error), or the
//   same shell command ending with a non-zero exit and the same output;
// - edits that keep reverting each other: a file put back to a content it had
//   before, twice.
//
// On the first match the session gets a note for the model (re-read the error,
// change approach) and the user gets one line. The note is also a signal for
// the tier routing (rafiki/routing.ts, "stuck"): an unpinned turn below
// rafiki-pro moves up to it for the rest of the turn, never to rafiki-max.
// Each pattern is noted once per turn, and a turn gets at most MAX_NOTES notes.
import { createHash } from "crypto"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

// The key of the part metadata that carries a stuck note.
export const METADATA = "stuck"

export const REPEATS = 3
export const REVERTS = 2
export const MAX_NOTES = 2

const ERROR_TAIL = 1500

export interface Finding {
  reason: "repeat" | "revert"
  // What failed or was reverted, as the user reads it: a command, a tool and file, a file.
  subject: string
  // The key that identifies the pattern within a turn.
  key: string
  count: number
  // The last error, for the model to read again (repeat only).
  error?: string
}

export interface Meta extends Finding {
  kind: "stuck"
  // Set when the routing moves the rest of the turn to a stronger tier.
  escalated?: { from: string; to: string }
}

export function metaOf(part: { type: string; metadata?: Record<string, unknown> }): Meta | undefined {
  if (part.type !== "text") return undefined
  const value = part.metadata?.[METADATA]
  if (!value || typeof value !== "object") return undefined
  return (value as { kind?: unknown }).kind === "stuck" ? (value as Meta) : undefined
}

// True for a user message the session added itself: a verify fix round or a stuck note.
export function isNote(msg: SessionV1.WithParts) {
  if (msg.info.role !== "user") return false
  return msg.parts.some((part) => {
    if (metaOf(part)) return true
    const verify = part.type === "text" ? (part.metadata?.verify as { kind?: unknown } | undefined) : undefined
    return verify?.kind === "feedback"
  })
}

// The messages of the turn: from the last message the user wrote to the end.
export function turnMessages(messages: SessionV1.WithParts[]) {
  const start = messages.findLastIndex((msg) => msg.info.role === "user" && !isNote(msg))
  return start === -1 ? [] : messages.slice(start)
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

function hash(text: string) {
  return createHash("sha1").update(text).digest("hex").slice(0, 16)
}

// Output with what changes from one run to the next taken out: timings,
// addresses, temporary paths and process ids.
export function normalize(output: string) {
  return output
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds|m|min)\b/g, "#t")
    .replace(/\b0x[0-9a-f]+\b/gi, "0x#")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?\b/g, "#date")
    .replace(/\/tmp\/[^\s'"]+/g, "/tmp/#")
    .replace(/\bpid[ =:]\d+\b/gi, "pid #")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(-2000)
}

const FILE_TOOLS = new Set(["edit", "write", "read", "apply_patch"])

function firstLine(text: string) {
  return text.trim().split("\n")[0]?.slice(0, 300) ?? ""
}

function tail(text: string) {
  const clean = text.trim()
  return clean.length <= ERROR_TAIL ? clean : "...\n" + clean.slice(clean.length - ERROR_TAIL)
}

interface Failure {
  key: string
  subject: string
  error: string
}

function failure(part: SessionV1.ToolPart): Failure | undefined {
  const state = part.state
  if (state.status === "error") {
    const input = state.input ?? {}
    const file = typeof input.filePath === "string" ? input.filePath : undefined
    if (part.tool === "bash" && typeof input.command === "string")
      return { key: `bash:${input.command}:${hash(normalize(state.error))}`, subject: input.command, error: state.error }
    // A file tool that fails the same way on the same file, whatever the exact
    // text it was given (a string to replace that is never found, for example).
    if (file && FILE_TOOLS.has(part.tool))
      return {
        key: `${part.tool}:${file}:${hash(normalize(firstLine(state.error)))}`,
        subject: `${part.tool} ${file}`,
        error: state.error,
      }
    return {
      key: `${part.tool}:${hash(stable(input))}:${hash(normalize(firstLine(state.error)))}`,
      subject: part.tool,
      error: state.error,
    }
  }
  if (state.status !== "completed" || part.tool !== "bash") return undefined
  const exit = state.metadata?.exit
  const command = state.input?.command
  if (typeof exit !== "number" || exit === 0 || typeof command !== "string") return undefined
  return { key: `bash:${command}:${exit}:${hash(normalize(state.output))}`, subject: command, error: state.output }
}

// Reverts per file: an edit that swaps back a change made earlier, or a write
// of a content the file had before (not the one right before it).
function reverts(parts: SessionV1.ToolPart[]) {
  const pairs = new Map<string, string[]>()
  const contents = new Map<string, string[]>()
  const counts = new Map<string, number>()
  const bump = (file: string) => counts.set(file, (counts.get(file) ?? 0) + 1)
  for (const part of parts) {
    if (part.state.status !== "completed") continue
    const input = part.state.input ?? {}
    const file = typeof input.filePath === "string" ? input.filePath : undefined
    if (!file) continue
    if (part.tool === "edit" && typeof input.oldString === "string" && typeof input.newString === "string") {
      const seen = pairs.get(file) ?? []
      if (seen.includes(hash(`${input.newString}\u0000${input.oldString}`))) bump(file)
      seen.push(hash(`${input.oldString}\u0000${input.newString}`))
      pairs.set(file, seen)
    }
    if (part.tool === "write" && typeof input.content === "string") {
      const seen = contents.get(file) ?? []
      const current = hash(input.content)
      if (seen.slice(0, -1).includes(current) && seen.at(-1) !== current) bump(file)
      seen.push(current)
      contents.set(file, seen)
    }
  }
  return counts
}

// The first pattern of the turn that has not been noted yet, if any.
export function scan(messages: SessionV1.WithParts[]): Finding | undefined {
  const turn = turnMessages(messages)
  const noted = turn.flatMap((msg) => (msg.info.role === "user" ? msg.parts.map(metaOf) : [])).filter(Boolean) as Meta[]
  if (noted.length >= MAX_NOTES) return undefined
  const done = new Set(noted.map((meta) => meta.key))
  const parts = turn.flatMap((msg) =>
    msg.info.role === "assistant" ? msg.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool") : [],
  )

  const seen = new Map<string, { failure: Failure; count: number }>()
  for (const part of parts) {
    const item = failure(part)
    if (!item) continue
    const entry = seen.get(item.key) ?? { failure: item, count: 0 }
    entry.count++
    entry.failure = item
    seen.set(item.key, entry)
    if (entry.count >= REPEATS && !done.has(item.key))
      return { reason: "repeat", subject: item.subject, key: item.key, count: entry.count, error: tail(item.error) }
  }

  for (const [file, count] of reverts(parts)) {
    const key = `revert:${file}`
    if (count >= REVERTS && !done.has(key)) return { reason: "revert", subject: file, key, count }
  }
  return undefined
}

// True when the turn has a stuck note: the routing signal.
export function noted(messages: SessionV1.WithParts[]) {
  return turnMessages(messages).some((msg) => msg.info.role === "user" && msg.parts.some((part) => Boolean(metaOf(part))))
}

function quoteSubject(subject: string) {
  const short = subject.length > 80 ? subject.slice(0, 77) + "..." : subject
  return `\`${short.replaceAll("\n", " ")}\``
}

// The note for the model.
export function note(finding: Finding, escalatedTo?: string) {
  const head =
    finding.reason === "repeat"
      ? `You are stuck: ${quoteSubject(finding.subject)} has failed the same way ${finding.count} times in this task. Running it again unchanged will not help.`
      : `You are stuck: your edits to ${finding.subject} keep undoing each other (the file went back to an earlier content ${finding.count} times).`
  const body =
    finding.reason === "repeat"
      ? [
          "Stop and read the last error again, slowly, line by line:",
          "",
          finding.error || "(no output)",
          "",
          "Then change approach: say in one sentence what the error actually means, question the assumption behind the failing step, and read the code, configuration or documentation it points to before trying something different. If it cannot work in this environment (a missing tool, no network access), say so and find another way or stop.",
        ]
      : [
          "Stop editing this file. Read it as it is now, and the tests or the code that use it, and decide which version is right before you change it again. Then make one deliberate change.",
        ]
  return [head, "", ...body, ...(escalatedTo ? ["", `(This task now continues on ${escalatedTo}.)`] : [])].join("\n")
}

// The one line the user reads.
export function userLine(meta: Meta) {
  const what =
    meta.reason === "repeat"
      ? `${quoteSubject(meta.subject)} failed the same way ${meta.count} times`
      : `edits to ${meta.subject} keep undoing each other`
  return `Stuck: ${what}; changing approach${meta.escalated ? `, now on ${meta.escalated.to}` : ""}.`
}
