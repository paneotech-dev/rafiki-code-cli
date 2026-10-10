// What the Rafiki AI account and the gateway say about the key in use: the
// credits in the account (the Console) and the key's own spend, budget and
// models (the gateway). Read after a response completes, never per streamed
// chunk; the figures shown are these readings, not estimates (meter.ts).
//
//   balance     GET <console>/api/v1/me            wallet.balance_usd
//   key         GET <gateway root>/key/info         spend, max_budget, models
//
// Either reading may be missing (a server key without an account view, a
// gateway that does not answer): the caller shows what it has and says what
// it does not know. Nothing here throws.
import { Brand } from "./brand"

export const TIMEOUT_MS = 5_000

export interface Source {
  key: string
  consoleURL: string
  gatewayURL: string
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>

function loopback(url: string) {
  try {
    const host = new URL(url).hostname
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1"
  } catch {
    return false
  }
}

// A test run never reaches a real service: with the runtime's own fetch, only
// loopback hosts are called under NODE_ENV=test.
function reachable(url: string, injected: boolean) {
  return injected || process.env["NODE_ENV"] !== "test" || loopback(url)
}

async function get(url: string, key: string, f: Fetch | undefined, timeoutMs: number): Promise<unknown> {
  if (!reachable(url, Boolean(f))) return undefined
  try {
    const response = await (f ?? (fetch as Fetch))(url, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json", "X-Rafiki-Surface": Brand.surface() },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

// The gateway base URL without its /v1 suffix.
export function gatewayRoot(url: string) {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "")
}

export async function balance(source: Pick<Source, "key" | "consoleURL">, f?: Fetch, timeoutMs = TIMEOUT_MS) {
  const body = (await get(source.consoleURL.replace(/\/+$/, "") + "/api/v1/me", source.key, f, timeoutMs)) as
    | { wallet?: { balance_usd?: unknown } | null }
    | undefined
  const value = body?.wallet?.balance_usd
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

// The credential this process uses and where it may be sent, or undefined
// when there is none (not signed in, an unsafe credential file, a stored
// browser sign-in under CI).
export function source(): Source | undefined {
  try {
    if (Brand.sessionKeyRefusedInCI()) return undefined
    const envKey = process.env[Brand.env.apiKey]
    const stored = envKey ? undefined : Brand.credential()
    const key = envKey || stored?.key
    if (!key) return undefined
    return { key, consoleURL: Brand.consoleFor(stored?.console_url), gatewayURL: Brand.gatewayURL() }
  } catch {
    return undefined
  }
}

// What the gateway says about the key itself (GET <gateway root>/key/info,
// which the gateway's edge lets a key holder call for their own key): what
// the key has spent, its budget, and the models it may use. These are the
// gateway's own figures, the ones it charges and enforces, not estimates.
export interface KeyInfo {
  // USD spent on this key so far, as the gateway counts it.
  spend: number
  // USD the key may spend in all, or null for no cap.
  maxBudget: number | null
  // The models the key may use; empty when the gateway lists none (every model).
  models: string[]
}

export type KeyInfoResult =
  | { ok: true; info: KeyInfo; at: number }
  // The gateway answered and refused (401, 403) or could not read the key.
  | { ok: false; status: number; at: number }
  // No answer: no key, no network, a timeout.
  | { ok: false; status?: undefined; at: number }

const money = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined)

// The fields this client uses out of a /key/info answer ({ key, info } or the
// info object alone). Undefined when the answer has no spend figure.
export function parseKeyInfo(body: unknown): KeyInfo | undefined {
  if (!body || typeof body !== "object") return undefined
  const raw = body as { info?: unknown }
  const info = (raw.info && typeof raw.info === "object" ? raw.info : raw) as {
    spend?: unknown
    max_budget?: unknown
    models?: unknown
  }
  const spend = money(info.spend ?? 0)
  if (spend === undefined) return undefined
  const cap = info.max_budget == null ? null : money(info.max_budget)
  const models = Array.isArray(info.models) ? info.models.filter((item): item is string => typeof item === "string") : []
  return { spend, maxBudget: cap ?? null, models }
}

export async function keyInfo(
  input: { source?: Pick<Source, "key" | "gatewayURL">; fetch?: Fetch; timeoutMs?: number; now?: () => number } = {},
): Promise<KeyInfoResult> {
  const now = input.now ?? Date.now
  const from = input.source ?? source()
  if (!from) return { ok: false, at: now() }
  const url = gatewayRoot(from.gatewayURL) + "/key/info"
  if (!reachable(url, Boolean(input.fetch))) return { ok: false, at: now() }
  try {
    const response = await (input.fetch ?? (fetch as Fetch))(url, {
      headers: { authorization: `Bearer ${from.key}`, accept: "application/json", "X-Rafiki-Surface": Brand.surface() },
      signal: AbortSignal.timeout(input.timeoutMs ?? TIMEOUT_MS),
    })
    if (!response.ok) return { ok: false, status: response.status, at: now() }
    const info = parseKeyInfo(await response.json())
    return info ? { ok: true, info, at: now() } : { ok: false, status: response.status, at: now() }
  } catch {
    return { ok: false, at: now() }
  }
}
