// Send now: a message typed while a turn runs is queued, and the turn takes
// it at its next step, which can be a long time away (a long answer being
// written, a long command, a subagent at work). Sending it now asks the
// running turn to stop at the next safe point instead: once every tool call
// it started has finished (never during one, so a file is never left half
// written), the request being written is cut and the queued message goes
// out as the next user message. What the turn wrote and did so far is kept.
//
// The terminal interface marks the message: a new one carries the mark on
// its text part when it is sent, a message already queued gets it through a
// part update. The server (packages/opencode/src/rafiki/steer.ts) reads the
// mark; nothing else changes on the wire.

// The key of the mark in the metadata of a text part.
export const KEY = "rafikiSendNow"

export function metadata(base?: Record<string, unknown>): Record<string, unknown> {
  return { ...base, [KEY]: true }
}

export function marked(part: unknown): boolean {
  if (typeof part !== "object" || part === null) return false
  const value = part as { type?: unknown; metadata?: unknown }
  if (value.type !== "text") return false
  if (typeof value.metadata !== "object" || value.metadata === null) return false
  return (value.metadata as Record<string, unknown>)[KEY] === true
}

interface MessageLike {
  id: string
  role: string
  time: { created: number; completed?: number }
}

// The user messages waiting for the running turn: those after the answer in
// progress (the same rule as the QUEUED badge of the session view).
export function queued<T extends MessageLike>(messages: readonly T[]): T[] {
  const completed = messages.findLastIndex((item) => item.role === "assistant" && item.time.completed)
  const pending = messages.findLastIndex(
    (item, index) => index > completed && item.role === "assistant" && !item.time.completed,
  )
  if (pending === -1) return []
  return messages.filter((item, index) => index > pending && item.role === "user")
}

// The hint shown with a queued message, short enough for an 80 column terminal.
export function hint(shortcut?: string) {
  return shortcut ? `enter on an empty prompt or ${shortcut} sends it now` : "enter on an empty prompt sends it now"
}
