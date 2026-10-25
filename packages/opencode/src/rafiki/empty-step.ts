// A gateway step that finished with no text and no tool call: the stream
// carried nothing the user can see or a tool can run, only reasoning or not
// even that, yet it ended on "stop". The loop used to take such a step as the
// end of the task, so a task in the middle of its work ended there without a
// word. Seen on 25 Oct 2026 on rafiki-pro: the gateway answered a step with a
// 381 byte stream (a role chunk and a finish chunk, no content, no usage, no
// spend logged), after the upstream stream ended without a finish reason.
//
// For the Rafiki provider such a step is tried again once, with the same
// messages; when the retry is empty too the task stops with a plain error.
// A step that ends on its output limit has its own retry (rafiki/reasoning.ts).
import { Brand } from "@opencode-ai/core/brand/brand"
import { NamedError } from "@opencode-ai/core/util/error"

// The one line that announces the retry, in the interface (on the empty step)
// and in rafikicode run.
export const RETRY_LINE = "The model sent an empty answer (no text and no tool call); trying the step again once."

const SAVED = `The session is saved: send a message to continue, or run ${Brand.name} --resume later.`

export const EMPTY_MESSAGE = `The model sent an empty answer (no text and no tool call), also when the step was tried again, so the task stopped before it was finished. ${SAVED}`

interface StepInfo {
  providerID: string
  finish?: string
  error?: unknown
  summary?: boolean
}

interface PartInfo {
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
}

// Finish reasons that already mean "not done" (the loop goes on) or have
// their own handling: an output limit, a filter, an error.
const HANDLED = new Set(["tool-calls", "unknown", "length", "content-filter", "error"])

// True when a finished step has nothing the user can see or a tool can run.
export function isEmptyStep(finish: string | undefined, parts: readonly PartInfo[]) {
  if (!finish || HANDLED.has(finish)) return false
  return !parts.some(
    (part) =>
      part.type === "tool" ||
      part.type === "file" ||
      (part.type === "text" && !part.synthetic && !part.ignored && (part.text ?? "").trim() !== ""),
  )
}

// Whether this step, on the gateway, is an empty one that has to be dealt with.
export function applies(message: StepInfo | undefined, parts: readonly PartInfo[] | undefined) {
  if (!message || message.error || message.summary || message.providerID !== Brand.provider.id) return false
  return isEmptyStep(message.finish, parts ?? [])
}

// The note left on the empty step that is being tried again. It is recorded
// as the step's error so the empty step is not sent back to the model, and
// the interface shows the line under it; it is not published as a session
// error, so rafikicode run does not fail on it.
export function retryNote() {
  return new NamedError.Unknown({ message: RETRY_LINE }).toObject()
}

export function isRetryLine(message: unknown) {
  return message === RETRY_LINE
}

function noteOf(error: unknown) {
  const data = (error as { data?: { message?: unknown } } | undefined)?.data
  return data?.message
}

// True when the step before this one, in the same turn, is an empty step that
// was already tried again: the retry is spent and this empty step is final.
export function retried(previous: { error?: unknown; parentID?: string } | undefined, parentID: string) {
  return previous?.parentID === parentID && isRetryLine(noteOf(previous?.error))
}

export function error() {
  return new NamedError.Unknown({ message: EMPTY_MESSAGE }).toObject()
}
