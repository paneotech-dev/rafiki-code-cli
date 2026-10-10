// Pruning of old tool output: a long session sends less on every request
// without compacting it. The rule is conservative:
//
// - the latest turn is never touched, and the most recent PROTECT_TOKENS of
//   tool output before it stay in full;
// - only large outputs (LARGE_TOKENS or more) are replaced;
// - errors, shell commands that exited with a non-zero code, file edits,
//   skills and the todo list are never replaced;
// - nothing happens until at least MINIMUM_TOKENS can be freed, so the
//   conversation is rewritten in rare batches (each batch moves the point up
//   to which a provider can reuse its prompt cache).
//
// A replaced output becomes a short marker naming the call and how to get
// the text back. The marker is built only from the call itself (tool, input,
// size), so once an output is replaced its bytes never change again and the
// provider can cache them like any other part of the conversation.
//
// On by default for the Rafiki tiers. RAFIKICODE_PRUNE (1/on/true or
// 0/off/false) wins over `compaction.prune` in the config.
import { Brand } from "@opencode-ai/core/brand/brand"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Token } from "@/util/token"

export const PROTECT_TOKENS = 40_000
export const MINIMUM_TOKENS = 20_000
export const LARGE_TOKENS = 500

// Tools whose output the model must keep seeing, whatever its size.
export const KEPT_TOOLS: ReadonlySet<string> = new Set([
  "skill",
  "edit",
  "write",
  "apply_patch",
  "multiedit",
  "patch",
  "todowrite",
  "todoread",
])

const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "shell"])

// The env override: true, false, or undefined when unset or unreadable.
export function envSetting(env: Record<string, string | undefined> = process.env): boolean | undefined {
  const value = env[Brand.env.prune]?.trim().toLowerCase()
  if (!value) return undefined
  if (["1", "on", "true", "yes"].includes(value)) return true
  if (["0", "off", "false", "no"].includes(value)) return false
  return undefined
}

// Whether pruning runs for a session: the env var, then the config, then on
// for the Rafiki provider only.
export function enabled(input: {
  configured: boolean | undefined
  providerID: string | undefined
  env?: Record<string, string | undefined>
}): boolean {
  const fromEnv = envSetting(input.env)
  if (fromEnv !== undefined) return fromEnv
  if (input.configured !== undefined) return input.configured
  return input.providerID === Brand.provider.id
}

const SUMMARY_KEYS = ["command", "filePath", "path", "pattern", "url", "query"] as const
const SUMMARY_MAX = 160

function summary(input: unknown) {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  for (const key of SUMMARY_KEYS) {
    const value = record[key]
    if (typeof value !== "string" || !value.trim()) continue
    const flat = value.replace(/\s+/g, " ").trim()
    const clipped = flat.length > SUMMARY_MAX ? flat.slice(0, SUMMARY_MAX) + "..." : flat
    return `${key}: ${clipped}`
  }
  return undefined
}

// Thousands separated by commas whatever the locale, so the bytes are the same everywhere.
function count(value: number) {
  return String(Math.max(0, Math.floor(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

// The text sent in place of a replaced output.
export function marker(part: { tool: string; state: { input: unknown; output?: string } }) {
  const about = summary(part.state.input)
  const size = count(part.state.output?.length ?? 0)
  return `[Output of an earlier ${part.tool} call${about ? ` (${about})` : ""} removed to keep the conversation short: ${size} characters. Run the call again if you need it.]`
}

function failedShell(part: SessionV1.ToolPart) {
  if (!SHELL_TOOLS.has(part.tool) || part.state.status !== "completed") return false
  const exit = (part.state.metadata as Record<string, unknown> | undefined)?.exit
  return typeof exit === "number" ? exit !== 0 : exit !== undefined && exit !== null && exit !== "0"
}

// Whether a part may ever be replaced, whatever its age.
export function prunable(part: SessionV1.ToolPart) {
  if (part.state.status !== "completed") return false
  if (KEPT_TOOLS.has(part.tool)) return false
  if (failedShell(part)) return false
  return true
}

// The parts to replace now, newest first; empty when the batch would free
// less than MINIMUM_TOKENS. Walks back from the end: the latest turn is
// skipped, then the newest PROTECT_TOKENS of output are kept, and stops at a
// compaction summary or at an output already replaced.
export function select(
  messages: SessionV1.WithParts[],
  limits: { protect?: number; minimum?: number; large?: number } = {},
) {
  const protect = limits.protect ?? PROTECT_TOKENS
  const minimum = limits.minimum ?? MINIMUM_TOKENS
  const large = limits.large ?? LARGE_TOKENS
  let total = 0
  let pruned = 0
  let turns = 0
  const parts: SessionV1.ToolPart[] = []
  loop: for (let msgIndex = messages.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = messages[msgIndex]
    if (msg.info.role === "user") turns++
    if (turns < 2) continue
    if (msg.info.role === "assistant" && msg.info.summary) break loop
    for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = msg.parts[partIndex]
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      if (part.state.time.compacted) break loop
      if (!prunable(part)) continue
      const estimate = Token.estimate(part.state.output)
      total += estimate
      if (total <= protect) continue
      if (estimate < large) continue
      pruned += estimate
      parts.push(part)
    }
  }
  return { parts: pruned > minimum ? parts : [], pruned, total }
}
