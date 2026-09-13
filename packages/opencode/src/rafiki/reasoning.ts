// A gateway turn that stops on its output limit with no visible text and no
// tool call spent its whole budget reasoning (rafiki-fast is a reasoning
// model). Upstream treats that turn as finished and goes idle with nothing on
// screen; for the Rafiki provider it becomes a plain error the user can act on.
// The orchestrator classifies the same turn as reasoning_exhausted.
import { Brand } from "@opencode-ai/core/brand/brand"
import { NamedError } from "@opencode-ai/core/util/error"

export const EMPTY_LENGTH_MESSAGE = `The model used its whole output budget reasoning and wrote no answer. Try again with reasoning off: the none variant (--variant none, or ${Brand.env.reasoningEffort}=none). A shorter request or a higher ${Brand.env.maxOutputTokens} also helps.`

interface TurnInfo {
  providerID: string
  finish?: string
  error?: unknown
}

interface PartInfo {
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
}

// True when the turn ended on its output limit with nothing the user can see or a tool can run.
export function isEmptyLengthTurn(finish: string | undefined, parts: readonly PartInfo[]) {
  if (finish !== "length") return false
  return !parts.some(
    (part) => part.type === "tool" || (part.type === "text" && !part.synthetic && !part.ignored && (part.text ?? "").trim() !== ""),
  )
}

// The error to record on such a turn, or undefined when the turn is fine, already failed, or not on the gateway.
export function emptyLengthError(message: TurnInfo | undefined, parts: readonly PartInfo[] | undefined) {
  if (!message || message.error || message.providerID !== Brand.provider.id) return undefined
  if (!isEmptyLengthTurn(message.finish, parts ?? [])) return undefined
  return new NamedError.Unknown({ message: EMPTY_LENGTH_MESSAGE }).toObject()
}
