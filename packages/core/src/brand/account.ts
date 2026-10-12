// What the Rafiki AI account and the gateway say about the key in use: the
// credits in the account (the Console) and the key's own spend, budget and
// models (the gateway). Read after a response completes, never per streamed
// chunk; the figures shown are these readings, not estimates (meter.ts).
//
//   balance     GET <console>/api/v1/me            wallet.balance_usd,
//                                                  wallet.billing_enforced
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

// The account's wallet as the Console says it: the balance, and whether the
// organisation's work stops when it reaches zero. `enforced` is false for an
// internal or staff organisation, whose balance falls but stops nothing; it
// is undefined when the Console does not say (one older than the field).
export interface Wallet {
  usd?: number
  enforced?: boolean
}

export function parseWallet(body: unknown): Wallet | undefined {
  const wallet = (body as { wallet?: { balance_usd?: unknown; billing_enforced?: unknown } | null } | undefined)?.wallet
  if (!wallet || typeof wallet !== "object") return undefined
  const value = wallet.balance_usd
  const usd = typeof value === "number" && Number.isFinite(value) ? value : undefined
  const enforced = typeof wallet.billing_enforced === "boolean" ? wallet.billing_enforced : undefined
  if (usd === undefined && enforced === undefined) return undefined
  return { usd, enforced }
}

export async function wallet(source: Pick<Source, "key" | "consoleURL">, f?: Fetch, timeoutMs = TIMEOUT_MS) {
  return parseWallet(await get(source.consoleURL.replace(/\/+$/, "") + "/api/v1/me", source.key, f, timeoutMs))
}

export async function balance(source: Pick<Source, "key" | "consoleURL">, f?: Fetch, timeoutMs = TIMEOUT_MS) {
  return (await wallet(source, f, timeoutMs))?.usd
}

// The key's member's builder projects (GET <console>/api/v1/builder/sessions),
// the raw page for brand/history.ts to read, or undefined when the Console
// does not list them (404 on a Console without the route or the builder
// link, 403 for a key that may not), fails or does not answer.
export async function builderProjects(source: Pick<Source, "key" | "consoleURL">, limit = 5, f?: Fetch, timeoutMs = TIMEOUT_MS) {
  return get(source.consoleURL.replace(/\/+$/, "") + `/api/v1/builder/sessions?limit=${limit}`, source.key, f, timeoutMs)
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
  // Tokens and requests per minute the gateway lets the key use; absent when
  // the key has no such limit or the gateway does not say.
  tpmLimit?: number
  rpmLimit?: number
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
    tpm_limit?: unknown
    rpm_limit?: unknown
  }
  const spend = money(info.spend ?? 0)
  if (spend === undefined) return undefined
  const cap = info.max_budget == null ? null : money(info.max_budget)
  const models = Array.isArray(info.models) ? info.models.filter((item): item is string => typeof item === "string") : []
  const out: KeyInfo = { spend, maxBudget: cap ?? null, models }
  const tpm = perMinute(info.tpm_limit)
  const rpm = perMinute(info.rpm_limit)
  if (tpm !== undefined) out.tpmLimit = tpm
  if (rpm !== undefined) out.rpmLimit = rpm
  return out
}

const perMinute = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined)

// The last good answer of keyInfo in this process, whoever asked: the spend
// figures and the per minute limits come from the same call.
let lastGood: (KeyInfoResult & { ok: true }) | undefined
let lastFailed: KeyInfoResult | undefined
let inflight: Promise<KeyInfoResult> | undefined

// keyInfo, answered from the last good reading when it is younger than
// maxAgeMs; concurrent callers share one request, and a failed reading is not
// asked again for a minute, so a gateway that cannot answer slows nothing.
export async function cachedKeyInfo(
  input: { maxAgeMs?: number; fetch?: Fetch; timeoutMs?: number; now?: () => number } = {},
): Promise<KeyInfoResult> {
  const now = input.now ?? Date.now
  if (lastGood && now() - lastGood.at < (input.maxAgeMs ?? 5 * 60_000)) return lastGood
  if (lastFailed && now() - lastFailed.at < 60_000) return lastGood ?? lastFailed
  if (!inflight) {
    inflight = keyInfo({ fetch: input.fetch, timeoutMs: input.timeoutMs, now })
      .then((result) => {
        lastFailed = result.ok ? undefined : result
        return result.ok ? result : (lastGood ?? result)
      })
      .finally(() => {
        inflight = undefined
      })
  }
  return inflight
}

// For tests: forget the last reading.
export function resetKeyInfoCache() {
  lastGood = undefined
  lastFailed = undefined
  inflight = undefined
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
    if (!info) return { ok: false, status: response.status, at: now() }
    const result = { ok: true as const, info, at: now() }
    // A reading of another key (a test, a source passed in) is not this process's key.
    if (!input.source) lastGood = result
    return result
  } catch {
    return { ok: false, at: now() }
  }
}
