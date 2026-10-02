// Picking a task up again after the connection or the process was lost.
//
// A stream cut by a connection failure: instead of sending the same request
// again from the start, the stored message is closed at the last boundary
// (a dispatched tool call, or the text received so far) and the session loop
// sends the next request from there. The gateway's chat completions interface
// cannot resume a response by id, so the partial output goes back as history.
//
// A process that died in the middle of a step: the message it left open is
// closed, its unfinished tool calls are marked interrupted and the files the
// step changed are recorded, so undo and the next request see a whole step.
//
// Both apply to the Rafiki gateway provider only.
import { Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionStatus } from "@/session/status"
import type { Snapshot } from "@/snapshot"
import * as RafikiGateway from "./gateway-errors"
import * as RafikiResilience from "./resilience"

export const CONTINUE_PROMPT =
  "The connection dropped while you were answering, so your message above is incomplete. Continue it from exactly where it stopped. Do not repeat anything you already wrote and do not mention the interruption."

type WithParts = SessionV1.WithParts

export type Boundary = "tools" | "text" | "none"

function dispatched(part: SessionV1.Part) {
  return part.type === "tool" && part.state.status !== "pending" && !part.metadata?.providerExecuted
}

// What a cut stream left that is worth keeping. `pending` is text that has
// arrived but is not stored yet (text is stored when its block ends).
export function boundary(parts: readonly SessionV1.Part[], pending?: string): Boundary {
  if (parts.some(dispatched)) return "tools"
  if (pending?.trim()) return "text"
  if (parts.some((part) => part.type === "text" && part.text.trim())) return "text"
  return "none"
}

// A step whose stream was cut and that was closed at a boundary: it started,
// never reported its end, and carries no error.
function isCut(message: WithParts) {
  if (message.info.role !== "assistant") return false
  if (message.info.error || message.info.finish || message.info.summary) return false
  if (!message.info.time.completed) return false
  if (!RafikiGateway.isRafikiProvider(message.info.providerID)) return false
  return (
    message.parts.some((part) => part.type === "step-start") && !message.parts.some((part) => part.type === "step-finish")
  )
}

// A cut step that holds text and no tool call: the model has to be asked to
// go on, because nothing else in the history tells it the text is unfinished.
export function isCutText(message: WithParts) {
  return (
    isCut(message) &&
    !message.parts.some((part) => part.type === "tool") &&
    message.parts.some((part) => part.type === "text" && part.text.trim())
  )
}

// How many cut steps in a row precede the end of `messages`.
export function streak(messages: readonly WithParts[]) {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isCut(messages[i]!)) break
    count++
  }
  return count
}

// The stored history with one instruction to continue after every cut text
// step. The instruction is not stored: it is added each time the history is
// turned into a request, in the same place, so later requests keep the same
// prefix and never show two assistant messages in a row.
export function withContinuations<T extends WithParts>(messages: T[]): (T | WithParts)[] {
  if (!messages.some(isCutText)) return messages
  const out: (T | WithParts)[] = []
  let user: SessionV1.User | undefined
  for (const message of messages) {
    out.push(message)
    if (message.info.role === "user") user = message.info
    if (!user || !isCutText(message)) continue
    const id = MessageID.ascending()
    out.push({
      info: { ...user, id, time: { created: message.info.time.created } },
      parts: [
        {
          id: PartID.ascending(),
          sessionID: message.info.sessionID,
          messageID: id,
          type: "text",
          text: CONTINUE_PROMPT,
          synthetic: true,
        },
      ],
    })
  }
  return out
}

// Called with the failure of a model stream, before the retry policy. Succeeds
// when the stored message was closed at a boundary and the loop should send
// the next request; fails with the same failure when the request should be
// sent again as it was (nothing usable arrived, or not a connection failure).
export const atBoundary = Effect.fnUntraced(function* (
  cause: unknown,
  error: unknown,
  step: { assistantMessage: SessionV1.Assistant; currentText?: { text: string } },
  session: Pick<Session.Interface, "messages" | "removePart">,
  status: Pick<SessionStatus.Interface, "set">,
) {
  const input = { cause, error, message: step.assistantMessage, text: step.currentText?.text, session, status }
  const again = Effect.fail(input.cause)
  if (input.message.summary) return yield* again
  if (!RafikiResilience.isConnectionError(input.message.providerID, input.error)) return yield* again

  const sessionID = input.message.sessionID
  const recent = yield* input.session
    .messages({ sessionID, limit: RafikiResilience.MAX_CONSECUTIVE_CUTS + 2 })
    .pipe(Effect.catch(() => Effect.succeed([] as WithParts[])))
  const index = recent.findIndex((message) => message.info.id === input.message.id)
  if (index === -1) return yield* again
  const parts = recent[index]!.parts
  const kind = boundary(parts, input.text)
  if (kind === "none") return yield* again

  // A connection that keeps dropping after a little output: wait longer each
  // time, and stop after a few in a row. Every continuation sends the whole
  // conversation again, so this must not go on for ever.
  const earlier = streak(recent.slice(0, index))
  if (earlier + 1 >= RafikiResilience.MAX_CONSECUTIVE_CUTS) {
    RafikiResilience.exhaust(input.cause, RafikiResilience.cutsMessage(earlier + 1))
    return yield* again
  }
  if (earlier > 0) {
    const wait = SessionRetry.delay(earlier)
    yield* input.status.set(sessionID, {
      type: "retry",
      attempt: earlier,
      message: RafikiResilience.RECONNECTING,
      next: Date.now() + wait,
    })
    yield* Effect.sleep(wait)
  }

  // A tool call whose arguments were still arriving is not a call: remove it
  // so it is neither run nor sent back to the model as one.
  for (const part of parts) {
    if (part.type !== "tool" || part.state.status !== "pending") continue
    yield* input.session.removePart({ sessionID, messageID: input.message.id, partID: part.id })
  }
  yield* Effect.logInfo("stream cut, resuming at boundary", {
    "session.id": sessionID,
    messageID: input.message.id,
    boundary: kind,
    consecutive: earlier + 1,
  })
})

// Sessions repaired in this process. A step can only have been left open by
// a process that is gone, so one look per session is enough.
const repaired = new Set<string>()

// Closes the step a dead process left open in this session, if any. `current`
// is the message of the step that is starting now, which is open by design.
export const recover = Effect.fnUntraced(function* (input: {
  sessionID: SessionID
  current?: string
  session: Pick<Session.Interface, "messages" | "updatePart" | "updateMessage">
  snapshot: Pick<Snapshot.Interface, "patch">
}) {
  if (repaired.has(input.sessionID)) return
  repaired.add(input.sessionID)
  const recent = yield* input.session
    .messages({ sessionID: input.sessionID, limit: 6 })
    .pipe(Effect.catch(() => Effect.succeed([] as WithParts[])))
  for (const message of recent) {
    const info = message.info
    if (info.role !== "assistant" || info.id === input.current || info.time.completed) continue
    if (!RafikiGateway.isRafikiProvider(info.providerID)) continue
    // Only a message that shows a step in progress: an unfinished tool call,
    // or a step that started and never reported its end.
    const open = message.parts.findLast((part) => part.type === "step-start" || part.type === "step-finish")
    const unfinished = message.parts.some(
      (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
    )
    if (open?.type !== "step-start" && !unfinished) continue
    const now = Date.now()
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.state.status !== "pending" && part.state.status !== "running") continue
      const metadata = "metadata" in part.state && part.state.metadata ? part.state.metadata : {}
      yield* input.session.updatePart({
        ...part,
        state: {
          status: "error",
          input: part.state.input,
          error: "Tool execution aborted",
          metadata: { ...metadata, interrupted: true },
          time: { start: "time" in part.state ? part.state.time.start : now, end: now },
        },
      })
    }
    // The files changed since the snapshot of the step that never finished,
    // so undo restores them. Without this the step has a snapshot and no
    // record of what it touched.
    if (open?.type === "step-start" && open.snapshot) {
      const patch = yield* input.snapshot.patch(open.snapshot)
      if (patch.files.length) {
        yield* input.session.updatePart({
          id: PartID.ascending(),
          messageID: info.id,
          sessionID: info.sessionID,
          type: "patch",
          hash: patch.hash,
          files: patch.files,
        })
      }
    }
    info.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
      providerID: info.providerID,
      aborted: true,
    })
    info.time.completed = now
    yield* input.session.updateMessage(info)
    yield* Effect.logInfo("closed a step left open by an earlier process", {
      "session.id": input.sessionID,
      messageID: info.id,
    })
  }
})

// For tests: forget which sessions were looked at.
export function forgetRepaired() {
  repaired.clear()
}
