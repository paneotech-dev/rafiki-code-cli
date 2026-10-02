// Connection failures to the Rafiki gateway in the middle of a task: how long
// they are retried, what the user is told when the retries run out, and the
// idempotency key every task step carries (docs/contracts/idempotency-key.md).
// Other providers keep the upstream behaviour.
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Contract from "./contract"
import * as RafikiGateway from "./gateway-errors"

// Seconds. 0 restores the single retry of a gateway that was never reached.
export const WINDOW_ENV = "RAFIKICODE_RETRY_WINDOW"
export const DEFAULT_WINDOW_MS = 120_000
const MAX_WINDOW_MS = 3_600_000

export const IDEMPOTENCY_HEADER = "Idempotency-Key"

// A stream that keeps being cut after some output is not retried forever:
// every continuation sends the conversation again.
export const MAX_CONSECUTIVE_CUTS = 5

export const RECONNECTING = "Connection lost, reconnecting"

export function windowMs(env: Record<string, string | undefined> = process.env) {
  const raw = env[WINDOW_ENV]?.trim()
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return DEFAULT_WINDOW_MS
  return Math.min(Math.round(Number(raw) * 1000), MAX_WINDOW_MS)
}

// True once the gateway has sent any part of a response in this process. A
// connection failure after that is a drop in the middle of a task, which is
// worth waiting for; before it, the address or the network was never good and
// the single retry reports that in seconds.
let answered = false

export function hasAnswered() {
  return answered
}

export function markAnswered(value = true) {
  answered = value
}

// The model stream of one task step: the request carries the step's
// idempotency key, and the first event of the response marks the gateway as
// having answered.
export function request<I extends Stamped, A, E, R>(
  llm: { stream: (input: I) => Stream.Stream<A, E, R> },
  input: I,
  stepID: string,
): Stream.Stream<A, E, R> {
  const stream = llm.stream(stamp(input, stepID))
  if (!RafikiGateway.isRafikiProvider(input.model.providerID)) return stream
  return stream.pipe(
    Stream.tap(() =>
      Effect.sync(() => {
        answered = true
      }),
    ),
  )
}

type SessionError = { name?: string; data?: Record<string, unknown> }
type Stamped = { model: { providerID: string; headers?: Record<string, string> } }

// A failure that never produced an HTTP answer: refused, reset, timed out or
// cut in the middle of the body. An answer with a status (429, 5xx) is not one.
export function isConnectionError(providerID: string, error: unknown): boolean {
  if (!RafikiGateway.isRafikiProvider(providerID)) return false
  const item = error as SessionError | undefined
  if (!item || item.name !== "APIError" || !item.data) return false
  if (item.data["statusCode"] !== undefined) return false
  return RafikiGateway.exitCodeFor(error) === Contract.EXIT.network
}

function windowApplies(providerID: string, error: unknown) {
  return answered && windowMs() > 0 && isConnectionError(providerID, error)
}

// Raw failures the retries gave up on, with the reason shown to the user. Keyed
// on the thrown object so nothing has to be threaded through the retry policy.
const exhausted = new WeakMap<object, string>()

function minutes(ms: number) {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000))
    return `${seconds} second${seconds === 1 ? "" : "s"}`
  }
  const value = Math.round(ms / 60_000)
  return `${value} minute${value === 1 ? "" : "s"}`
}

const OFFLINE = /getaddrinfo|could not resolve|dns lookup|ENOTFOUND|EAI_AGAIN|ENETDOWN|ENETUNREACH|EHOSTUNREACH/i

function textOf(cause: unknown, depth = 0): string {
  if (typeof cause === "string") return cause
  if (!cause || typeof cause !== "object" || depth > 5) return ""
  const item = cause as { message?: unknown; code?: unknown; cause?: unknown }
  return [item.code, item.message, textOf(item.cause, depth + 1)].filter((x) => typeof x === "string" && x).join(" ")
}

const SAVED = `The session is saved: send a message to continue, or run ${Brand.name} --resume later.`

export function windowMessage(cause: unknown, ms = windowMs()) {
  // The same reading as rafikicode doctor: with no name resolution and no
  // route, nothing about the gateway or the key is at fault.
  const what = OFFLINE.test(textOf(cause))
    ? "There has been no network connection from this machine"
    : "The connection to the model gateway was lost and did not come back"
  return `${what} for ${minutes(ms)}. ${SAVED}`
}

export function cutsMessage(count: number) {
  return `The connection to the model gateway dropped ${count} times in a row while it was answering. ${SAVED}`
}

export function exhaust(cause: unknown, message: string) {
  if (cause && typeof cause === "object") exhausted.set(cause, message)
}

export function isExhausted(cause: unknown) {
  return Boolean(cause && typeof cause === "object" && exhausted.has(cause))
}

// The session error for a raw failure, with the message replaced when the
// retries gave up on it. Classification fields (status, metadata) are kept,
// so the exit code stays the network one.
export function describe<T extends { data?: unknown }>(error: T, cause: unknown): T {
  const message = cause && typeof cause === "object" ? exhausted.get(cause) : undefined
  if (!message || !error.data || typeof error.data !== "object") return error
  return { ...error, data: { ...error.data, message } }
}

type Attempt = { attempt: number; elapsed: number; input: unknown }

// Whether the retry policy tries again. Connection failures in the middle of
// a task are retried until the window has passed since the first one; every
// other failure keeps the attempt limit it had.
export function keepRetrying(providerID: string, error: unknown, meta: Attempt, upstream: number) {
  if (isExhausted(meta.input)) return false
  if (windowApplies(providerID, error)) {
    if (meta.elapsed < windowMs()) return true
    exhaust(meta.input, windowMessage(meta.input))
    return false
  }
  return meta.attempt <= RafikiGateway.retryLimit(providerID, error, upstream)
}

// The wait before the next attempt: the upstream backoff with jitter, cut
// short so the last attempt lands at the end of the window and not after it.
export function wait(providerID: string, error: unknown, meta: Attempt, upstream: number) {
  if (!windowApplies(providerID, error)) return upstream
  return Math.max(0, Math.min(upstream, windowMs() - meta.elapsed))
}

// One key per task step. The step id is the id of the stored message the step
// writes into: an identical request sent again after a failure repeats it, the
// next step and a continuation after a cut stream get a new one.
export function stamp<T extends Stamped>(input: T, stepID: string): T {
  if (!RafikiGateway.isRafikiProvider(input.model.providerID)) return input
  return {
    ...input,
    model: { ...input.model, headers: { ...input.model.headers, [IDEMPOTENCY_HEADER]: stepID } },
  }
}
