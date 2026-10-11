// The risk check of auto mode: for a shell command the rules cannot classify
// (an unknown program, inline interpreter code, a long script), one small
// request to the rafiki-fast tier asks whether running it unattended is low or
// high risk. The answer must be strict JSON, {"risk": "low" | "high",
// "reason": "..."}; anything else counts as no answer.
//
// High risk, or no answer within 5 seconds, means the person is asked. The
// answer is kept per exact command for the session, so a command is checked
// once. The request is made on the account's key like any other call, so it
// is counted in the spend figures and in `rafikicode usage`, under the fast
// tier. Turned off with "permission": { "auto_check": false }.
import { Brand } from "@opencode-ai/core/brand/brand"

export const TIMEOUT_MS = 5_000
export const MAX_TOKENS = 100
const MAX_COMMAND = 2_000

export interface Answer {
  risk: "low" | "high"
  reason: string
}

const SYSTEM = [
  "You rate one shell command that a coding tool wants to run unattended in a project folder.",
  'Answer with JSON only: {"risk":"low","reason":"..."} or {"risk":"high","reason":"..."}, reason under 15 words.',
  "high: it may delete or overwrite data outside the project, change the system, expose secrets, spend money, publish, or you cannot tell.",
  "low: ordinary development work inside the project.",
].join("\n")

// The answer in a reply, or undefined when it is not the JSON asked for.
export function parse(text: string): Answer | undefined {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    const value = JSON.parse(match[0]) as { risk?: unknown; reason?: unknown }
    if (value.risk !== "low" && value.risk !== "high") return undefined
    const reason = typeof value.reason === "string" ? value.reason.trim().slice(0, 200) : ""
    return { risk: value.risk, reason }
  } catch {
    return undefined
  }
}

export interface Request {
  command: string
  directory: string
  fetch?: typeof fetch
  timeoutMs?: number
  gateway?: string
  key?: string
}

function accountKey() {
  const env = process.env[Brand.env.apiKey]
  if (env) return env
  try {
    return Brand.credential()?.key
  } catch {
    return undefined
  }
}

// One check. Undefined when there is no answer: no key, an error, a reply
// that is not the JSON asked for, or no reply within the time limit.
export async function check(input: Request): Promise<Answer | undefined> {
  const key = input.key ?? accountKey()
  if (!key) return undefined
  const base = (input.gateway ?? Brand.gatewayURL()).replace(/\/+$/, "")
  const command = input.command.length > MAX_COMMAND ? input.command.slice(0, MAX_COMMAND) + "\n[cut]" : input.command
  try {
    const response = await (input.fetch ?? fetch)(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "X-Rafiki-Surface": Brand.surface(),
        "X-Rafiki-Tier": "fast",
        "X-Rafiki-Escalation": "0",
      },
      body: JSON.stringify({
        model: "rafiki-fast",
        stream: false,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        reasoning_effort: "none",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Folder: ${input.directory}\nCommand:\n${command}` },
        ],
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] }
    const content = body.choices?.[0]?.message?.content
    return typeof content === "string" ? parse(content) : undefined
  } catch {
    return undefined
  }
}

// Answers kept per session, per exact command.
const cache = new Map<string, Map<string, Answer>>()

export async function cached(sessionID: string, input: Request): Promise<Answer | undefined> {
  const kept = cache.get(sessionID)?.get(input.command)
  if (kept) return kept
  const answer = await check(input)
  if (!answer) return undefined
  const session = cache.get(sessionID) ?? new Map<string, Answer>()
  session.set(input.command, answer)
  cache.set(sessionID, session)
  return answer
}

export function forget(sessionID?: string) {
  if (sessionID) cache.delete(sessionID)
  else cache.clear()
}
