// What the gateway says about the answer itself, as opposed to what was asked
// for: the tier that answered and the cache writes it reports.
//
// The tier that answered. The gateway moves a request to the next tier when
// the tier asked for fails (rafiki-fast to rafiki-pro, rafiki-pro to
// rafiki-max). A streamed answer then names the tier that answered in the
// `model` field of every chunk; the client library hands that on as the
// response model id of the step. When the gateway's edge sends
// X-Rafiki-Model, that header names the same thing and is preferred. The
// assistant message records the tier that answered, so the context
// percentage, the message footer, the tier path and the cost estimate follow
// it instead of the tier asked for.
//
// Cache writes. For a tier whose provider bills cache writes (rafiki-max),
// the gateway reports them as `cache_creation_input_tokens` and inside
// `prompt_tokens`, which the client library does not read. They are taken
// from the raw usage block so that they are shown as cache writes and taken
// out of plain input once.
import { Brand } from "@opencode-ai/core/brand/brand"
import type { ProviderMetadata } from "@opencode-ai/llm"

// The metadata key the step carries the answer's model under.
export const KEY = "response"

const tiers = Brand.models as readonly string[]

function header(headers: unknown, name: string) {
  if (!headers || typeof headers !== "object") return undefined
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name && typeof value === "string") return value
  }
  return undefined
}

// Step metadata for a step's response (`response` of the client library's
// finish-step event): its model id when it is a Rafiki tier, and the
// X-Rafiki-Model header when sent. Nothing for any other answer, so the
// metadata of other providers is left exactly as it was.
export function metadata(response: unknown): ProviderMetadata | undefined {
  if (!response || typeof response !== "object") return undefined
  const item = response as { modelId?: unknown; headers?: unknown }
  const modelId = typeof item.modelId === "string" && tiers.includes(item.modelId) ? item.modelId : undefined
  const served = header(item.headers, "x-rafiki-model")
  if (!modelId && !served) return undefined
  return { [KEY]: { ...(modelId ? { modelId } : {}), ...(served ? { servedModel: served } : {}) } }
}

// The model to record on the assistant message: the tier that answered when
// it is another Rafiki tier than the one asked for, else the one asked for.
// Only the gateway provider is concerned, and only a tier name is taken: a
// provider's own model name (a non streamed answer after a fallback) says
// nothing this client can map to a tier, so the tier asked for is kept.
// The result has the type of the id asked for (a branded model id).
export function model<T extends string>(input: { providerID: string; requested: T; metadata?: ProviderMetadata }): T {
  if (input.providerID !== Brand.provider.id) return input.requested
  const entry = input.metadata?.[KEY]
  const candidates = [entry?.["servedModel"], entry?.["modelId"]]
  for (const value of candidates) {
    if (typeof value === "string" && tiers.includes(value)) return value as T
  }
  return input.requested
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined)

// Cache writes in a raw OpenAI format usage block, when the gateway reports
// them and they fit inside the input it reports (prompt_tokens includes them,
// as the gateway sends it). Undefined otherwise, so nothing is invented.
export function cacheWrite(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const usage = raw as {
    prompt_tokens?: unknown
    cache_creation_input_tokens?: unknown
    prompt_tokens_details?: { cached_tokens?: unknown; cache_creation_tokens?: unknown } | null
  }
  const written = count(usage.cache_creation_input_tokens) ?? count(usage.prompt_tokens_details?.cache_creation_tokens)
  const prompt = count(usage.prompt_tokens)
  if (written === undefined || prompt === undefined) return undefined
  const read = count(usage.prompt_tokens_details?.cached_tokens) ?? 0
  return written + read <= prompt ? written : undefined
}

// The line rafikicode run prints when the tier answering is not the one its
// header line named: "> build · rafiki-pro (rafiki-fast was asked for, the
// gateway answered on rafiki-pro)", or the plain header again once the tier
// asked for answers again.
export function runLine(agent: string, asked: string, answered: string) {
  if (answered === asked) return `> ${agent} · ${answered}`
  return `> ${agent} · ${answered} (${asked} was asked for, the gateway answered on ${answered})`
}
