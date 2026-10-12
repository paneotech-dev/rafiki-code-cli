// The key's tokens per minute limit as a safety net for long sessions. A
// session compacts only near the model's context window, which can be far
// above what the gateway lets one key send in a minute; a single request over
// that limit is refused with a 429 that no wait can cure. Two guards:
//
//   before sending  the next request is estimated (the tokens of the previous
//                   request plus what was added since); over SHARE of the
//                   key's tpm limit (GET /key/info, account.ts cachedKeyInfo)
//                   the session is compacted first.
//   on a refusal    a 429 "Limit type: tokens" whose Remaining is at or near the
//                   full limit means the request alone is too large: it is
//                   reported as a context overflow, so the session compacts and
//                   sends it once more instead of waiting. A second refusal
//                   after that compaction stops with a message that says so.
//
// Every other 429 keeps the usual backoff (session/retry.ts).
import * as Account from "@opencode-ai/core/brand/account"
import { Token } from "@/util/token"

// Share of the limit a request may use before the session is compacted first.
export const SHARE = 0.9

// What a refusal said about the limit, newer than the key reading it beats.
let learned: { limit: number; at: number } | undefined

type Read = () => Promise<Account.KeyInfoResult>

// The key's tokens per minute limit, or undefined when it has none or the
// gateway cannot say. Read through the shared /key/info cache.
export async function limit(read: Read = () => Account.cachedKeyInfo({ timeoutMs: 4_000 })): Promise<number | undefined> {
  if (learned && Date.now() - learned.at < 60_000) return learned.limit
  const result = await read().catch(() => undefined)
  if (learned && (!result?.ok || learned.at >= result.at)) return learned.limit
  return result?.ok ? result.info.tpmLimit : undefined
}

export function learn(value: number, at = Date.now()) {
  learned = { limit: value, at }
}

const number = (text: string, pattern: RegExp) => {
  const match = pattern.exec(text)
  if (!match) return undefined
  const value = Number(match[1]!.replace(/[,_]/g, ""))
  return Number.isFinite(value) ? value : undefined
}

// The limit named by a 429 that refused a request larger than the key's
// tokens per minute limit, or undefined for any other answer (a limit reached
// by earlier requests, a request limit, a budget).
export function oversized(input: { statusCode?: number; message?: string; responseBody?: string }): number | undefined {
  if (input.statusCode !== 429) return undefined
  const text = `${input.message ?? ""}\n${input.responseBody ?? ""}`
  if (!/Limit type:\s*tokens/i.test(text)) return undefined
  const cap = number(text, /Current limit:\s*([\d,_.]+)/i)
  const remaining = number(text, /Remaining:\s*([\d,_.]+)/i)
  if (cap === undefined || remaining === undefined || cap <= 0) return undefined
  return remaining >= cap * SHARE ? cap : undefined
}

// The message of the context overflow a refused request turns into.
export const OVERFLOW = "Request larger than this key's limit of tokens per minute"
export const overflowMessage = (cap: number) => `${OVERFLOW} (${grouped(cap)}).`
export const isOverflow = (message: unknown) => typeof message === "string" && message.startsWith(OVERFLOW)

type Tokens = { total?: number; input: number; output: number; cache: { read: number; write: number } }

const count = (tokens: Tokens) => tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write

type PartLike = { type: string; text?: string; synthetic?: boolean; ignored?: boolean; state?: { status?: string; output?: unknown } }
type MessageLike = { info: { id: string }; parts: readonly PartLike[] }

const toolOutput = (part: PartLike) =>
  part.type === "tool" && part.state?.status === "completed" && typeof part.state.output === "string" ? part.state.output : ""

// The next request in tokens: the previous request and its answer, the tool
// results added to that answer, and every message after it.
export function estimate(messages: readonly MessageLike[], previous: { id: string; tokens: Tokens }): number {
  const index = messages.findIndex((message) => message.info.id === previous.id)
  let added = ""
  for (const message of index < 0 ? [] : messages.slice(index)) {
    for (const part of message.parts) {
      added += toolOutput(part)
      if (message.info.id !== previous.id && part.type === "text" && !part.ignored) added += part.text ?? ""
    }
  }
  return count(previous.tokens) + Token.estimate(added)
}

export const over = (tokens: number, cap: number | undefined) => cap !== undefined && tokens > cap * SHARE

// Sessions compacted because of the limit and not answered since: a refusal
// there is not cured by compacting again.
const compacted = new Set<string>()
export const mark = (sessionID: string) => void compacted.add(sessionID)
export const marked = (sessionID: string) => compacted.has(sessionID)
export const clear = (sessionID: string) => void compacted.delete(sessionID)

// The conversation given to the compaction request, cut from the start so the
// request itself fits under the limit, with room for the prompt around it.
export function fit(text: string, cap: number | undefined, reserve = 8_000): string {
  if (!cap) return text
  const room = Math.max(1_000, Math.floor(cap * SHARE) - reserve) * 4
  if (text.length <= room) return text
  return `[Earlier conversation omitted: it is larger than this key's limit of tokens per minute]\n\n${text.slice(text.length - room)}`
}

const grouped = (value: number) => Math.round(value).toLocaleString("en-US")

// The one line shown when the session is compacted because of the limit.
export const PREFIX = "Compacting the session first:"
export const isNotice = (message: unknown) => typeof message === "string" && message.startsWith(PREFIX)

export const beforeLine = (tokens: number, cap: number) =>
  `${PREFIX} the next request is about ${grouped(tokens)} tokens, near this key's limit of ${grouped(cap)} tokens per minute.`

export const refusedLine = (cap?: number) =>
  `${PREFIX} the gateway refused a request larger than this key's limit of ${cap ? grouped(cap) + " " : ""}tokens per minute; it is sent once more after compacting.`

export const stillTooLarge = (cap?: number) =>
  `This request is larger than this key's limit of ${cap ? grouped(cap) + " " : ""}tokens per minute, even after compacting the session. Ask for a higher limit on this key in the Rafiki AI console, or start a new session.`

// For tests.
export function reset() {
  learned = undefined
  compacted.clear()
}
