// rafikicode usage against the mock console: the by tier and by day tables,
// a console that does not serve the daily split yet, a console without the
// route, a dead key, and the option checks.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as Contract from "../../src/rafiki/contract"
import { DeviceFlowError } from "../../src/rafiki/device-flow"
import * as Usage from "../../src/rafiki/usage"
import { createMockConsole, mockUsage } from "../brand/mock-console.mjs"
import { spawnCli } from "./spawn"

const KEY = "sk-test-not-a-real-key"

let home: string
let console_: ReturnType<typeof createMockConsole> | undefined

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-usage-"))
})

afterEach(async () => {
  await console_?.close()
  console_ = undefined
  fs.rmSync(home, { recursive: true, force: true })
})

async function mock(options: Record<string, unknown> = {}) {
  console_ = createMockConsole({ quiet: true, anyKey: true, ...options })
  await console_.ready
  return { consoleURL: console_.url, fetch: (input: string, init?: RequestInit) => fetch(input, init) }
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (cause) {
    return cause as DeviceFlowError
  }
  throw new Error("expected a failure")
}

describe("loading usage", () => {
  test("asks the usage route for the window with the key", async () => {
    const client = await mock()
    const body = await Usage.load(client, KEY, 7)
    expect(body.period?.days).toBe(7)
    expect(body.by_day).toHaveLength(2)
    expect(console_!.requests.at(-1)).toMatchObject({ path: Contract.PATH.usage, days: 7, authorization: "present" })
  })

  test("a console without the route fails with a plain line and exit 1", async () => {
    const client = await mock({ usage: "absent" })
    const error = await failure(Usage.load(client, KEY, 30))
    expect(error).toBeInstanceOf(DeviceFlowError)
    expect(error.exitCode).toBe(Contract.EXIT.failed)
    expect(error.message).toBe(
      `The Rafiki AI console at ${client.consoleURL} does not serve usage to rafikicode. Open ${client.consoleURL}/usage in a browser to see it.`,
    )
  })

  test("a dead key is told to sign in again, exit 2", async () => {
    const client = await mock({ anyKey: false })
    const error = await failure(Usage.load(client, KEY, 30))
    expect(error.exitCode).toBe(Contract.EXIT.usage)
    expect(error.message).toBe(Contract.MESSAGE[Contract.ERROR.keyRevoked])
  })

  test("a console that cannot be reached is a network failure, exit 4", async () => {
    const error = await failure(
      Usage.load({ consoleURL: "http://127.0.0.1:9", fetch: async () => Promise.reject(new Error("connection refused")) }, KEY, 30),
    )
    expect(error.exitCode).toBe(Contract.EXIT.network)
    expect(error.message).toContain("Could not reach the Rafiki AI console to load usage: connection refused")
  })

  test("an answer that is not the usage shape is reported with the console's own message", async () => {
    const error = await failure(
      Usage.load(
        { consoleURL: "http://127.0.0.1:9", fetch: async () => new Response(JSON.stringify({ error: { message: "`days` must be a whole number between 1 and 365." } }), { status: 400 }) },
        KEY,
        30,
      ),
    )
    expect(error.exitCode).toBe(Contract.EXIT.failed)
    expect(error.message).toBe("Could not load usage: `days` must be a whole number between 1 and 365.")
  })
})

describe("the report", () => {
  const input = { days: 30, consoleURL: "https://console.example" }

  test("by tier from the per model rows, then by day and by tier", () => {
    expect(Usage.render(mockUsage(30), input)).toEqual([
      "Usage of your Rafiki AI account, last 30 days (since 2026-09-02). Amounts are USD charged.",
      "",
      "By tier",
      "  Tier    Calls   Input tokens   Output tokens   Charged",
      "  fast        9        120,000           8,000    0.0101",
      "  pro         3         40,000           6,000    0.2000",
      "  other       3          8,000           1,500    0.0420",
      "  total      15        168,000          15,500    0.2521",
      '  "other" is every call of the account that was not made on a Rafiki Code tier.',
      "  Prompt caching saved 0.0750 USD (0.0200 charged instead of 0.0950).",
      "",
      "By day (UTC)",
      "  Day          Calls     fast      pro    other   Charged",
      "  2026-09-30       7   0.0051        -   0.0420    0.0471",
      "  2026-10-01       8   0.0050   0.2000        -    0.2050",
    ])
  })

  test("a console that does not serve the daily split yet: the tier table and a plain line", () => {
    const body = mockUsage(30)
    delete (body as { by_day?: unknown }).by_day
    const lines = Usage.render(body, input)
    expect(lines).toContain("  fast        9        120,000           8,000    0.0101")
    expect(lines.at(-1)).toBe(
      "Daily figures are not served by this Rafiki AI console yet. Open https://console.example/usage in a browser to see them.",
    )
    expect(lines.join("\n")).not.toContain("By day")
  })

  test("no usage in the window", () => {
    expect(Usage.render({ object: "usage", period: { days: 1 }, totals: { calls: 0, cost_usd: 0 }, by_model: [], by_day: [] }, { ...input, days: 1 })).toEqual([
      "Usage of your Rafiki AI account, last 1 day. Amounts are USD charged.",
      "",
      "No usage in this period.",
    ])
  })

  test("tier rows are summed per tier and listed in tier order", () => {
    expect(
      Usage.byTier({
        by_model: [
          { model: "gpt-5", calls: 1, cost_usd: 1 },
          { model: "rafiki-max", calls: 2, cost_usd: 2 },
          { model: "claude-opus", calls: 3, cost_usd: 3 },
          { model: "rafiki-fast", calls: 4, cost_usd: 4 },
        ],
      }).map((row) => [row.tier, row.calls, row.cost_usd]),
    ).toEqual([
      ["fast", 4, 4],
      ["max", 2, 2],
      ["other", 4, 4],
    ])
  })
})

describe("rafikicode usage", () => {
  const run = (args: string[], extra: Record<string, string | undefined> = {}) =>
    spawnCli(home, ["usage", ...args], { RAFIKICODE_API_KEY: KEY, RAFIKICODE_CONSOLE_URL: console_?.url, ...extra })

  test("prints both tables on standard output", async () => {
    await mock()
    const result = await run([])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Usage of your Rafiki AI account, last 30 days (since 2026-09-02). Amounts are USD charged.")
    expect(result.stdout).toContain("  pro         3         40,000           6,000    0.2000")
    expect(result.stdout).toContain("  2026-10-01       8   0.0050   0.2000        -    0.2050")
    expect(console_!.requests.at(-1)).toMatchObject({ path: "/api/v1/usage", days: 30 })
  }, 60_000)

  test("--days and --json pass the window through and print the console's answer", async () => {
    await mock()
    const result = await run(["--days", "7", "--json"])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(mockUsage(7))
  }, 60_000)

  test("a console without the route: one plain line, exit 1", async () => {
    await mock({ usage: "absent" })
    const result = await run([])
    expect(result.exitCode).toBe(Contract.EXIT.failed)
    expect(result.stderr).toContain(`does not serve usage to rafikicode. Open ${console_!.url}/usage in a browser to see it.`)
    expect(result.stdout).toBe("")
  }, 60_000)

  test("an out of range window and a missing key are refused before any request, exit 2", async () => {
    await mock()
    const range = await run(["--days", "0"])
    expect(range.exitCode).toBe(Contract.EXIT.usage)
    expect(range.stderr).toContain("--days must be a whole number between 1 and 365.")
    const signedOut = await run([], { RAFIKICODE_API_KEY: undefined })
    expect(signedOut.exitCode).toBe(Contract.EXIT.usage)
    expect(signedOut.stderr).toContain("Missing API key. Run rafikicode login, or set RAFIKICODE_API_KEY.")
    expect(console_!.requests.filter((r: any) => r.path === "/api/v1/usage")).toHaveLength(0)
  }, 60_000)
})
