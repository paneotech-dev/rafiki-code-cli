// Pruning of old tool output: a long session sends less on every request
// without compacting it. The rule is conservative:
//
// - the latest turn is never touched, and the most recent PROTECT_TOKENS of
//   tool output before it stay in full;
// - only large outputs (LARGE_TOKENS or more) are replaced;
// - errors, shell commands that exited with a non-zero code, file edits,
//   skills and the todo list are never replaced;
// - the newest run of each test command (the last test run) and the newest
//   read of each file the session edits (the file being edited) stay in
//   full, whatever their age;
// - nothing happens until at least MINIMUM_TOKENS can be freed, and not
//   before the session's context reaches two thirds of its compaction point
//   (from), so the conversation is rewritten in rare batches. Each batch
//   sends the conversation after the first replaced output again at the full
//   input price instead of the cached one (about 50 times as much on
//   rafiki-fast), which costs more than the replaced text saves until the
//   session is close to compacting anyway.
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

export const PROTECT_TOKENS = 20_000
export const MINIMUM_TOKENS = 20_000
export const LARGE_TOKENS = 500
// The share of the compaction point (rafiki/context-size.ts) a session reaches before its first batch.
export const FROM_SHARE = 2 / 3

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
// A command that runs checks: its newest output is what the model compares the next change against.
const TEST_COMMAND =
  /\b(test|tests|pytest|jest|vitest|mocha|phpunit|pest|rspec|tox|nox|ctest|check|typecheck|tsc|lint|eslint|ruff|mypy|clippy)\b/i

const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "multiedit", "patch"])

// The files the session edits or writes.
function editedFiles(messages: SessionV1.WithParts[]) {
  const files = new Set<string>()
  for (const msg of messages)
    for (const part of msg.parts) {
      if (part.type !== "tool" || !EDIT_TOOLS.has(part.tool)) continue
      const filePath = (part.state.input as Record<string, unknown> | undefined)?.filePath
      if (typeof filePath === "string") files.add(filePath)
    }
  return files
}

// What a part is the newest output of, when only the newest must stay: a test command, or a read of a file the
// session edits. A read of another part of the file is another key, so a later partial read leaves the older
// full one in place.
function newestKey(part: SessionV1.ToolPart, edited: ReadonlySet<string>) {
  const input = (part.state.input ?? {}) as Record<string, unknown>
  if (SHELL_TOOLS.has(part.tool) && typeof input.command === "string" && TEST_COMMAND.test(input.command))
    return `test:${input.command.trim()}`
  if (part.tool === "read" && typeof input.filePath === "string" && edited.has(input.filePath))
    return `read:${input.filePath}:${input.offset ?? ""}:${input.limit ?? ""}`
  return undefined
}

// The context of the session's latest finished request, in tokens.
export function contextTokens(messages: SessionV1.WithParts[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (info.role !== "assistant" || info.summary) continue
    const t = info.tokens
    const total = t.total || t.input + t.output + t.cache.read + t.cache.write
    if (total > 0) return total
  }
  return 0
}

export function select(
  messages: SessionV1.WithParts[],
  limits: { protect?: number; minimum?: number; large?: number; from?: number } = {},
) {
  const protect = limits.protect ?? PROTECT_TOKENS
  const minimum = limits.minimum ?? MINIMUM_TOKENS
  const large = limits.large ?? LARGE_TOKENS
  const from = limits.from ?? 0
  let total = 0
  let pruned = 0
  let turns = 0
  const parts: SessionV1.ToolPart[] = []
  const seen = new Set<string>()
  const edited = editedFiles(messages)
  if (from > 0 && contextTokens(messages) < from) return { parts, pruned, total }
  loop: for (let msgIndex = messages.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = messages[msgIndex]
    if (msg.info.role === "user") turns++
    if (turns < 2) {
      // The latest turn is kept whole; a command or a file it ran or read again makes the older output prunable.
      for (const part of msg.parts) {
        const key = part.type === "tool" ? newestKey(part, edited) : undefined
        if (key !== undefined) seen.add(key)
      }
      continue
    }
    if (msg.info.role === "assistant" && msg.info.summary) break loop
    for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = msg.parts[partIndex]
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      if (part.state.time.compacted) break loop
      if (!prunable(part)) continue
      const key = newestKey(part, edited)
      const newest = key !== undefined && !seen.has(key)
      if (key !== undefined) seen.add(key)
      const estimate = Token.estimate(part.state.output)
      if (newest) {
        total += estimate
        continue
      }
      total += estimate
      if (total <= protect) continue
      if (estimate < large) continue
      pruned += estimate
      parts.push(part)
    }
  }
  return { parts: pruned > minimum ? parts : [], pruned, total }
}
