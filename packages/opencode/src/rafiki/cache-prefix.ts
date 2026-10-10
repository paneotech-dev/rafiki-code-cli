// A request prefix that stays the same from one request of a task to the
// next, so a provider can reuse its prompt cache instead of reading the same
// text at the full input price every turn.
//
// The stable part, in order: the system prompt, the project instructions, the
// MCP instructions and the skills list, the repository context (model,
// working directory, platform, project references), then the project memory. The tool definitions
// travel in their own field, sorted by name, and are the same on every
// request of a task. Nothing in the stable part changes by itself: the one
// line that does (today's date) goes into a system message of its own, after
// the stable one. A cache marker on the stable system message tells a
// provider that takes one where the reusable prefix ends.
import type { ModelMessage } from "ai"
import { Brand } from "@opencode-ai/core/brand/brand"

export interface SystemParts {
  // The repository context: the environment block and the project references.
  environment: string[]
  // The project instructions (AGENTS.md and configured files), then the house style.
  instructions: string[]
  mcp?: string
  skills?: string
  // The project memory (rafiki/memory.ts), read once per session. Last of the stable parts: it changes from one
  // session to the next, so what comes before it is still reused across sessions of the same project.
  memory?: string
}

// The system text that follows the system prompt, most stable first. The last entry is the volatile line, which
// the request builder takes out again (split) and sends as a message of its own.
export function order(parts: SystemParts, now: Date = new Date()): string[] {
  return [
    ...parts.instructions,
    ...(parts.mcp ? [parts.mcp] : []),
    ...(parts.skills ? [parts.skills] : []),
    ...parts.environment,
    ...(parts.memory ? [parts.memory] : []),
    volatile(now),
  ]
}

// Separates the volatile lines from the stable system text. A request that carries none (a title, a summary) stays as it is.
export function split(system: readonly string[]): { stable: string[]; volatile: string[] } {
  return { stable: system.filter((part) => !isVolatile(part)), volatile: system.filter((part) => isVolatile(part)) }
}

const VOLATILE_PREFIX = "Today's date: "

// What changes by itself between two requests. Sent as its own system message after the stable one.
export function volatile(now: Date = new Date()): string {
  return VOLATILE_PREFIX + now.toDateString()
}

export function isVolatile(content: unknown): boolean {
  return typeof content === "string" && content.startsWith(VOLATILE_PREFIX)
}

// The value of RAFIKICODE_CACHE_MARKERS, or the tiers marked by default.
export function markedModels(raw: string | undefined = process.env[Brand.env.cacheMarkers]): readonly string[] | "all" {
  const value = raw?.trim().toLowerCase()
  if (!value) return Brand.provider.cacheMarkers
  if (value === "all") return "all"
  if (value === "off" || value === "0" || value === "none") return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
}

// True when requests for this model carry cache markers: the gateway provider, on a marked tier.
export function marks(model: { providerID: string; api: { id: string } }, raw?: string): boolean {
  if (model.providerID !== Brand.provider.id) return false
  const list = markedModels(raw)
  return list === "all" || list.includes(model.api.id)
}

const MARKER = { cache_control: { type: "ephemeral" } }

function withMarker(options: Record<string, any> | undefined): Record<string, any> {
  return { ...options, openaiCompatible: { ...options?.openaiCompatible, ...MARKER } }
}

// One message with the marker where the provider package reads it: on the message for a system or assistant
// message and for plain text, on the last part for a user or tool message made of parts.
function markMessage(msg: ModelMessage): ModelMessage {
  if (msg.role !== "system" && msg.role !== "assistant" && Array.isArray(msg.content) && msg.content.length > 0) {
    const last = msg.content[msg.content.length - 1] as { type?: string; providerOptions?: Record<string, any> }
    if (last && typeof last === "object" && last.type !== "tool-approval-request" && last.type !== "tool-approval-response") {
      const content = [...msg.content.slice(0, -1), { ...last, providerOptions: withMarker(last.providerOptions) }]
      return { ...msg, content } as ModelMessage
    }
  }
  return { ...msg, providerOptions: withMarker(msg.providerOptions) } as ModelMessage
}

// Sets the cache markers for a marked tier: one at the end of the stable system text, and one on each of the last
// two conversation messages so the conversation so far is reused on the next request. Other models: unchanged.
export function mark<T extends ModelMessage>(msgs: T[], model: { providerID: string; api: { id: string } }, raw?: string): T[] {
  if (!marks(model, raw)) return msgs
  const stable = msgs.findLast((msg) => msg.role === "system" && !isVolatile(msg.content))
  const tail = msgs.filter((msg) => msg.role !== "system").slice(-2)
  const targets = new Set<ModelMessage>([...(stable ? [stable] : []), ...tail])
  return msgs.map((msg) => (targets.has(msg) ? (markMessage(msg) as T) : msg))
}
