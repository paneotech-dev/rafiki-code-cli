// A gateway turn that stops on its output limit with no visible text and no
// tool call spent its whole budget reasoning (every tier reasons). Upstream
// treats that turn as finished and goes idle with nothing on screen; for the
// Rafiki provider the turn is tried again once with a larger output budget
// (up to the tier's upstream maximum) and, on a tier that takes an effort
// setting, one step less reasoning. Only when that retry is empty too does it
// become a plain error the user can act on. The orchestrator classifies the
// same turn as reasoning_exhausted.
import { Brand } from "@opencode-ai/core/brand/brand"
import { NamedError } from "@opencode-ai/core/util/error"

const VARIANT_HINT = ` Try again with reasoning off: the none variant (--variant none, or ${Brand.env.reasoningEffort}=none).`
const OUTPUT_HINT = ` A shorter request or a higher ${Brand.env.maxOutputTokens} also helps.`

export const EMPTY_LENGTH_MESSAGE = `The model used its whole output budget reasoning and wrote no answer.${VARIANT_HINT}${OUTPUT_HINT}`

// The first words of the one line that announces a retry, in the interface
// (on the empty turn) and in rafikicode run (on stderr).
export const RETRY_PREFIX = "The model used its whole output budget reasoning; trying again once with"

const efforts = Brand.provider.reasoningEfforts as readonly string[]

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

export interface RetryPlan {
  // Output tokens the retry asks for.
  output: number
  // Reasoning effort the retry sends, when the tier takes one.
  effort?: string
  // The line that tells the user.
  line: string
}

// True when the turn ended on its output limit with nothing the user can see or a tool can run.
export function isEmptyLengthTurn(finish: string | undefined, parts: readonly PartInfo[]) {
  if (finish !== "length") return false
  return !parts.some(
    (part) => part.type === "tool" || (part.type === "text" && !part.synthetic && !part.ignored && (part.text ?? "").trim() !== ""),
  )
}

// The message for a turn that ran out, worded for the tier: pro takes no
// effort setting, so it is not told to pick the none variant. After a retry
// it says what the retry asked for.
export function emptyLengthMessage(modelID?: string, retried?: RetryPlan) {
  const variants = modelID === undefined || Brand.provider.takesEffort(modelID)
  const first = retried
    ? `The model used its whole output budget reasoning and wrote no answer, also when tried again with ${retried.output} output tokens${retried.effort ? ` and reasoning effort ${retried.effort}` : ""}.`
    : "The model used its whole output budget reasoning and wrote no answer."
  return first + (variants ? VARIANT_HINT : "") + (retried ? " A shorter request, or one step at a time, also helps." : OUTPUT_HINT)
}

// The error to record on such a turn, or undefined when the turn is fine, already failed, or not on the gateway.
export function emptyLengthError(
  message: (TurnInfo & { modelID?: string }) | undefined,
  parts: readonly PartInfo[] | undefined,
  retried?: RetryPlan,
) {
  if (!message || message.error || message.providerID !== Brand.provider.id) return undefined
  if (!isEmptyLengthTurn(message.finish, parts ?? [])) return undefined
  return new NamedError.Unknown({ message: emptyLengthMessage(message.modelID, retried) }).toObject()
}

// One step less reasoning: high to medium, medium to low, low to none. No
// effort sent (the model decides) counts as medium.
function lower(effort: string | undefined) {
  const index = efforts.indexOf(effort ?? "medium")
  if (index <= 0) return effort
  return efforts[index - 1]
}

// What the one retry of an empty turn asks for, or undefined when there is
// nothing more to give: twice the output the turn had, up to the tier's
// upstream maximum, and on a tier that takes an effort setting one step less
// reasoning than the turn used.
export function retryPlan(input: { providerID: string; modelID: string; output: number; effort?: string }): RetryPlan | undefined {
  if (input.providerID !== Brand.provider.id) return undefined
  const max = Brand.provider.maxOutput(input.modelID)
  if (!max) return undefined
  const output = Math.max(input.output, Math.min(max, input.output * 2))
  const lowered = Brand.provider.takesEffort(input.modelID) ? lower(input.effort) : undefined
  const effort = lowered !== undefined && lowered !== input.effort ? lowered : undefined
  if (output <= input.output && !effort) return undefined
  const line = `${RETRY_PREFIX} ${output} output tokens${effort ? ` and reasoning effort ${effort}` : ""}.`
  return { output, effort, line }
}

// The note left on the empty turn that is being retried. It is recorded as
// the turn's error so the empty turn is not sent back to the model, and so
// the interface shows the line under it; it is not published as a session
// error, so rafikicode run does not fail on it.
export function retryNote(plan: RetryPlan) {
  return new NamedError.Unknown({ message: plan.line }).toObject()
}

export function isRetryLine(message: unknown) {
  return typeof message === "string" && message.startsWith(RETRY_PREFIX)
}

interface ModelLike {
  limit: { context: number; output: number; input?: number }
  options: Record<string, any>
  variants?: Record<string, Record<string, any>>
}

// The model as the retry request uses it: the larger output limit, and the
// lower effort over whatever the model or a chosen variant would send.
export function boosted<M extends ModelLike>(model: M, plan: RetryPlan): M {
  const limit = { ...model.limit, output: plan.output }
  if (!plan.effort) return { ...model, limit }
  const effort = { reasoningEffort: plan.effort }
  return {
    ...model,
    limit,
    options: { ...model.options, ...effort },
    variants: model.variants
      ? Object.fromEntries(Object.entries(model.variants).map(([name, value]) => [name, { ...value, ...effort }]))
      : model.variants,
  }
}
