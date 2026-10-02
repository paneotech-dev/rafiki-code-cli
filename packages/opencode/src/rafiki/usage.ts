// rafikicode usage: what the account was charged over the last days, by tier
// and by day, read from the Rafiki AI console (GET /api/v1/usage). These are
// the console's own figures, the amounts charged, not estimates.
//
// The split by tier comes from the per model rows (a call made on a tier
// alias is recorded under that alias). The split by day needs the `by_day`
// field; a console that does not serve it yet gets the tier table and a plain
// line saying so (docs/plans/cost-display.md, Usage contract).
import type { Argv } from "yargs"
import { Effect } from "effect"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Cost from "@opencode-ai/core/brand/cost"
import { effectCmd, fail } from "@/cli/effect-cmd"
import * as Contract from "./contract"
import * as DeviceFlow from "./device-flow"

export const DEFAULT_DAYS = 30
export const MAX_DAYS = 365
const OTHER = "other"

export interface TierRow {
  tier: string
  calls?: number
  tokens_in?: number
  tokens_out?: number
  cost_usd?: number
}

export interface UsageResponse {
  object?: string
  period?: { days?: number; since?: string }
  totals?: {
    calls?: number
    tokens_in?: number
    tokens_out?: number
    cost_usd?: number
    prompt_cache?: { charged_usd?: number; uncached_usd?: number; saved_usd?: number } | null
  }
  by_model?: { model?: string; calls?: number; tokens_in?: number; tokens_out?: number; cost_usd?: number }[]
  by_day?: { day?: string; calls?: number; cost_usd?: number; by_tier?: TierRow[] }[]
}

export function usagePage(consoleURL: string) {
  return consoleURL + Contract.PATH.usagePage
}

export async function load(c: Pick<DeviceFlow.Client, "consoleURL" | "fetch">, key: string, days: number): Promise<UsageResponse> {
  let response: Response
  try {
    response = await c.fetch(`${c.consoleURL}${Contract.PATH.usage}?days=${days}`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new DeviceFlow.DeviceFlowError(`Could not reach the Rafiki AI console to load usage: ${detail}`, "network", Contract.EXIT.network)
  }
  const text = await response.text()
  const body = (() => {
    try {
      return text ? JSON.parse(text) : undefined
    } catch {
      return undefined
    }
  })()
  if (response.status === 401) {
    throw new DeviceFlow.DeviceFlowError(Contract.MESSAGE[Contract.ERROR.keyRevoked], Contract.ERROR.keyRevoked, Contract.EXIT.usage)
  }
  if (response.status === 404) {
    throw new DeviceFlow.DeviceFlowError(
      `The Rafiki AI console at ${c.consoleURL} does not serve usage to ${Brand.name}. Open ${usagePage(c.consoleURL)} in a browser to see it.`,
      "not_found",
      Contract.EXIT.failed,
    )
  }
  if (!response.ok || !body || typeof body !== "object") {
    const message = typeof body?.error?.message === "string" ? body.error.message : `The Rafiki AI console answered ${response.status}.`
    throw new DeviceFlow.DeviceFlowError(
      `Could not load usage: ${message}`,
      "usage_failed",
      response.status >= 500 ? Contract.EXIT.network : Contract.EXIT.failed,
    )
  }
  return body as UsageResponse
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)
const count = (value: unknown) => Math.round(number(value)).toLocaleString("en-US")
const money = (value: unknown) => number(value).toFixed(4)

// The window's rows by tier: one per tier alias in the per model split, in
// tier order, then every other model of the account together.
export function byTier(body: UsageResponse): TierRow[] {
  const rows = new Map<string, Required<TierRow>>()
  for (const row of body.by_model ?? []) {
    const tier = Cost.tierOf(row.model) ?? OTHER
    const into = rows.get(tier) ?? { tier, calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 }
    into.calls += number(row.calls)
    into.tokens_in += number(row.tokens_in)
    into.tokens_out += number(row.tokens_out)
    into.cost_usd += number(row.cost_usd)
    rows.set(tier, into)
  }
  return [...Cost.TIERS, OTHER].flatMap((tier) => (rows.has(tier) ? [rows.get(tier)!] : []))
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)))
  return rows.map((row) =>
    ("  " + row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("   ")).trimEnd(),
  )
}

// The report, one string per line.
export function render(body: UsageResponse, input: { days: number; consoleURL: string }): string[] {
  const days = body.period?.days ?? input.days
  const since = typeof body.period?.since === "string" ? body.period.since.slice(0, 10) : undefined
  const lines = [`Usage of your Rafiki AI account, last ${days} ${days === 1 ? "day" : "days"}${since ? ` (since ${since})` : ""}. Amounts are USD charged.`, ""]
  const tiers = byTier(body)
  if (number(body.totals?.calls) === 0 && tiers.length === 0 && !(body.by_day ?? []).length) {
    lines.push("No usage in this period.")
    return lines
  }

  lines.push("By tier")
  lines.push(
    ...table([
      ["Tier", "Calls", "Input tokens", "Output tokens", "Charged"],
      ...tiers.map((row) => [row.tier, count(row.calls), count(row.tokens_in), count(row.tokens_out), money(row.cost_usd)]),
      ["total", count(body.totals?.calls), count(body.totals?.tokens_in), count(body.totals?.tokens_out), money(body.totals?.cost_usd)],
    ]),
  )
  if (tiers.some((row) => row.tier === OTHER)) {
    lines.push(`  "${OTHER}" is every call of the account that was not made on a ${Brand.product} tier.`)
  }
  const cache = body.totals?.prompt_cache
  if (cache && number(cache.saved_usd) > 0) {
    lines.push(`  Prompt caching saved ${money(cache.saved_usd)} USD (${money(cache.charged_usd)} charged instead of ${money(cache.uncached_usd)}).`)
  }
  lines.push("")

  if (!Array.isArray(body.by_day)) {
    lines.push(`Daily figures are not served by this Rafiki AI console yet. Open ${usagePage(input.consoleURL)} in a browser to see them.`)
    return lines
  }
  const columns = [...Cost.TIERS, OTHER].filter((tier) => body.by_day!.some((day) => (day.by_tier ?? []).some((row) => row.tier === tier)))
  lines.push("By day (UTC)")
  lines.push(
    ...table([
      ["Day", "Calls", ...columns, "Charged"],
      ...body.by_day.map((day) => [
        day.day ?? "?",
        count(day.calls),
        ...columns.map((tier) => {
          const row = (day.by_tier ?? []).find((item) => item.tier === tier)
          return row ? money(row.cost_usd) : "-"
        }),
        money(day.cost_usd),
      ]),
    ]),
  )
  if (!body.by_day.length) lines.push("  No usage in this period.")
  return lines
}

export const UsageCommand = effectCmd({
  command: "usage",
  describe: `show what your Rafiki AI account was charged over the last ${DEFAULT_DAYS} days, by day and by tier`,
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("days", {
        type: "number",
        default: DEFAULT_DAYS,
        describe: `how many days back to report (1 to ${MAX_DAYS})`,
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "print the answer of the Rafiki AI console as JSON",
      }),
  handler: Effect.fn("Cli.rafiki.usage")(function* (args) {
    const days = args.days
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return yield* fail(`--days must be a whole number between 1 and ${MAX_DAYS}.`, Contract.EXIT.usage)
    }
    const envKey = process.env[Brand.env.apiKey]
    const stored = Brand.credential()
    const key = envKey || stored?.key
    if (!key) return yield* fail(Contract.MESSAGE[Contract.ERROR.unauthenticated], Contract.EXIT.usage)
    const consoleURL = Brand.consoleFor(envKey ? undefined : stored?.console_url)

    const body = yield* Effect.tryPromise({
      try: () => load(DeviceFlow.client({ consoleURL }), key, days),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        cause instanceof DeviceFlow.DeviceFlowError
          ? fail(cause.message, cause.exitCode)
          : fail(cause instanceof Error ? cause.message : String(cause), Contract.EXIT.internal),
      ),
    )
    if (args.json) {
      process.stdout.write(JSON.stringify(body, null, 2) + "\n")
      return
    }
    process.stdout.write(render(body, { days, consoleURL }).join("\n") + "\n")
  }),
})
