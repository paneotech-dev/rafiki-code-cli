// The gateway's cap on the input of one request (Brand.context.inputCap,
// 200000 tokens on every Rafiki tier since 2026-10-24). Over it the gateway
// answers HTTP 413 (invalid_request_error, context_length_exceeded), which
// provider/error.ts reads as a context overflow. Normally the session is
// compacted well before (rafiki/context-size.ts); when a request is refused
// anyway:
//
//   first refusal   the session is compacted and the message is sent once
//                   more. It is not an error: one line says so, and
//                   `rafikicode run` still exits 0 when the resent request
//                   is answered.
//   second refusal  after that compaction the message alone is too large;
//                   compacting again cannot help, so the turn stops with a
//                   message that says so instead of compacting in a loop.
//
// The compaction request itself is cut to fit under the cap (fit in
// rafiki/tpm.ts, called from session/compaction.ts).
import { Brand } from "@opencode-ai/core/brand/brand"

const grouped = (value: number) => Math.round(value).toLocaleString("en-US")

// The limit the gateway named ("... limit of 200,000 ..."), or the brand value.
export function limitFrom(text: string | undefined): number {
  const match = /limit(?:\s+is|\s+of|:)?\s*([\d][\d,_]*)/i.exec(text ?? "")
  const value = match ? Number(match[1]!.replace(/[,_]/g, "")) : NaN
  return Number.isFinite(value) && value > 0 ? value : Brand.context.inputCap
}

// Sessions compacted after a refusal and not answered since.
const refused = new Set<string>()
export const mark = (sessionID: string) => void refused.add(sessionID)
export const marked = (sessionID: string) => refused.has(sessionID)
export const clear = (sessionID: string) => void refused.delete(sessionID)

export const PREFIX = "Compacting the session first:"

export const recoveringLine = (cap: number) =>
  `${PREFIX} the request was over the gateway's limit of ${grouped(cap)} input tokens; it is sent once more after compacting.`

export const tooLarge = (cap: number) =>
  `This message alone is larger than the gateway's limit of ${grouped(cap)} input tokens, even after compacting the session. Send a shorter message or fewer attachments (a large text can be saved to a file in the project and read in parts).`

// For tests.
export function reset() {
  refused.clear()
}
