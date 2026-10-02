// The two readings a task's cost display starts from: the credits in the
// Rafiki AI account and the gateway's price list. Read once when a task
// starts, never per request; what the task spends afterwards is worked out
// from the token counts of each answer (cost.ts).
//
//   balance     GET <console>/api/v1/me            wallet.balance_usd
//   price list  GET <gateway root>/v1/model/info   per token prices per alias
//
// Either reading may be missing (a server key without an account view, a
// gateway that does not serve its price list): the caller shows what it has
// and says what it does not know. Nothing here throws.
import { Brand } from "./brand"
import { tierOf, type Prices, type TierPrice } from "./cost"

export const TIMEOUT_MS = 5_000

export interface Snapshot {
  // USD of credits in the account when the snapshot was taken.
  balance?: number
  prices?: Prices
  at: number
}

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

// USD per token to USD per million tokens, without the binary fraction noise
// (0.0000001 times a million is not exactly 0.1).
const perMillion = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 1e12) / 1e6 : undefined

// The price list out of the gateway's model info answer: one entry per tier
// alias the key may use. Prices given with the deployment win over the
// gateway's general price map. A tier without an input or an output price is
// left out, so it is shown as unknown instead of free.
export function parsePrices(body: unknown): Prices | undefined {
  const data = (body as { data?: unknown } | undefined)?.data
  if (!Array.isArray(data)) return undefined
  const out: Prices = {}
  for (const row of data) {
    if (!row || typeof row !== "object") continue
    const entry = row as { model_name?: unknown; litellm_params?: Record<string, unknown>; model_info?: Record<string, unknown> }
    const tier = typeof entry.model_name === "string" ? tierOf(entry.model_name) : undefined
    if (!tier || out[tier]) continue
    const read = (name: string) => perMillion(entry.litellm_params?.[name]) ?? perMillion(entry.model_info?.[name])
    const input = read("input_cost_per_token")
    const output = read("output_cost_per_token")
    if (input === undefined || output === undefined) continue
    // A tier listed at zero is one the gateway has no price for.
    if (input === 0 && output === 0) continue
    const rate: TierPrice = { input, output }
    const cacheRead = read("cache_read_input_token_cost")
    const cacheWrite = read("cache_creation_input_token_cost")
    if (cacheRead !== undefined) rate.cacheRead = cacheRead
    if (cacheWrite !== undefined) rate.cacheWrite = cacheWrite
    out[tier] = rate
  }
  return Object.keys(out).length ? out : undefined
}

export async function prices(source: Pick<Source, "key" | "gatewayURL">, f?: Fetch, timeoutMs = TIMEOUT_MS) {
  return parsePrices(await get(gatewayRoot(source.gatewayURL) + "/v1/model/info", source.key, f, timeoutMs))
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

export async function snapshot(input: { source?: Source; fetch?: Fetch; timeoutMs?: number; now?: () => number } = {}): Promise<Snapshot> {
  const now = input.now ?? Date.now
  const from = input.source ?? source()
  if (!from) return { at: now() }
  const [credit, list] = await Promise.all([
    balance(from, input.fetch, input.timeoutMs),
    prices(from, input.fetch, input.timeoutMs),
  ])
  return { ...(credit !== undefined ? { balance: credit } : {}), ...(list ? { prices: list } : {}), at: now() }
}
