// The compaction point and the large request line (src/rafiki/context-size.ts).
//
// Against the mock gateway with rafikicode run:
//   - a session whose next request would pass 150,000 tokens is compacted
//     before that request is sent, and the request sent after the compaction
//     is much smaller than the one it replaces;
//   - with the point turned off, a request over compaction.warn_at
//     (RAFIKICODE_WARN_AT here) shows one line suggesting /compact.
// The rules on their own are checked first.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Context from "../../src/rafiki/context-size"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
// words of 10 characters: 4 words make 10 tokens at 4 characters a token.
const text = (prefix: string, tokens: number) =>
  Array.from({ length: Math.ceil((tokens * 4) / 10) }, (_, index) => `${prefix}${String(index).padStart(5, "0")}`).join(" ")

describe("the rules", () => {
  afterEach(() => Context.reset())

  test("defaults: 150,000 tokens on the Rafiki tiers, none elsewhere; the line at 200,000", () => {
    expect(Context.compactAt({ compaction: undefined, providerID: Brand.provider.id, env: {} })).toBe(150_000)
    expect(Context.compactAt({ compaction: undefined, providerID: "other", env: {} })).toBeUndefined()
    expect(Context.warnAt({ compaction: undefined, env: {} })).toBe(200_000)
  })

  test("the environment wins over the config, and 0 or off turns either off", () => {
    const env = (name: string, value: string) => ({ [name]: value })
    expect(Context.compactAt({ compaction: { threshold: 90_000 }, providerID: "other", env: {} })).toBe(90_000)
    expect(Context.compactAt({ compaction: { threshold: 90_000 }, providerID: "other", env: env(Brand.env.compactAt, "60000") })).toBe(60_000)
    expect(Context.compactAt({ compaction: undefined, providerID: Brand.provider.id, env: env(Brand.env.compactAt, "off") })).toBeUndefined()
    expect(Context.compactAt({ compaction: undefined, providerID: Brand.provider.id, env: env(Brand.env.compactAt, "0") })).toBeUndefined()
    expect(Context.compactAt({ compaction: undefined, providerID: Brand.provider.id, env: env(Brand.env.compactAt, "lots") })).toBe(150_000)
    expect(Context.warnAt({ compaction: { warn_at: 300_000 }, env: {} })).toBe(300_000)
    expect(Context.warnAt({ compaction: { warn_at: 300_000 }, env: env(Brand.env.warnAt, "250,000") })).toBe(250_000)
    expect(Context.warnAt({ compaction: { warn_at: 0 }, env: {} })).toBeUndefined()
    expect(Context.warnAt({ compaction: undefined, env: env(Brand.env.warnAt, "off") })).toBeUndefined()
  })

  test("the line is shown once while a session stays over the threshold, and again after it went under", () => {
    expect(Context.shouldWarn("s", 200_000, 200_000)).toBe(false)
    expect(Context.shouldWarn("s", 200_001, 200_000)).toBe(true)
    expect(Context.shouldWarn("s", 250_000, 200_000)).toBe(false)
    expect(Context.shouldWarn("other", 250_000, 200_000)).toBe(true)
    expect(Context.shouldWarn("s", 60_000, 200_000)).toBe(false)
    expect(Context.shouldWarn("s", 210_000, 200_000)).toBe(true)
    expect(Context.shouldWarn("t", 900_000, undefined)).toBe(false)
    expect(Context.warningLine(212_345)).toBe(
      "Large request: about 212,345 tokens. Run /compact or start a new session to make the next turns cheaper.",
    )
    expect(Context.isWarning(Context.warningLine(1))).toBe(true)
  })
})

type Gateway = ReturnType<typeof createMockGateway>
type Body = { raw: Buffer; json: any; session?: string }

let homes: string[] = []
let gateways: Gateway[] = []

afterEach(async () => {
  await Promise.all(gateways.map((gateway) => gateway.close()))
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true })
  homes = []
  gateways = []
})

async function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-compact-at-"))
  const repo = path.join(home, "repo")
  fs.mkdirSync(repo)
  spawnSync("git", ["init", "-q"], { cwd: repo })
  const gateway = createMockGateway({
    quiet: true,
    bodies: true,
    // The request's own size, the way the gateway reports it.
    usage: (_body: unknown, tokens: number) => ({ prompt_tokens: tokens, completion_tokens: 8, total_tokens: tokens + 8 }),
  })
  await gateway.ready
  homes.push(home)
  gateways.push(gateway)
  return { home, repo, gateway }
}

type Side = Awaited<ReturnType<typeof setup>>

async function run(side: Side, message: string, input?: string, extra: Record<string, string> = {}) {
  const { home, repo, gateway } = side
  const env: Record<string, string | undefined> = {
    ...process.env,
    COLUMNS: "120",
    PWD: repo,
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    RAFIKICODE_GATEWAY_URL: gateway.url + "/v1",
    RAFIKICODE_API_KEY: "sk-compact-at-stub",
  }
  for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_DB", "RAFIKICODE_CONSOLE_URL", Brand.env.headless, Brand.env.trustWorkspace, Brand.env.compactAt, Brand.env.warnAt])
    delete env[name]
  Object.assign(env, extra)
  const session = (gateway.bodies as Body[]).find((body) => body.session)?.session
  const args = ["run", "--model", "rafiki/rafiki-fast", ...(session ? ["--session", session] : []), message]
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args], {
    cwd: repo,
    // A message this large does not fit on a command line: it goes in on standard input.
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { exitCode: await proc.exited, all: stdout + stderr }
}

const chats = (gateway: Gateway) => (gateway.requests as any[]).filter((entry) => entry.path === "/v1/chat/completions")
// The requests of the task itself: they carry the tools.
const task = (gateway: Gateway) => chats(gateway).filter((entry) => entry.tools > 0)
const compactions = (gateway: Gateway) =>
  (gateway.bodies as Body[]).filter((body) => JSON.stringify(body.json.messages).includes("Here is the conversation so far"))

describe("against the mock gateway", () => {
  test(
    "a session growing past 150,000 tokens compacts before sending, and the next request is much smaller",
    async () => {
      const side = await setup()
      const first = await run(side, "Keep the log below for later, then answer ok.", text("line", 100_000))
      expect(first.exitCode, first.all).toBe(0)
      const size = task(side.gateway).at(-1)!.tokens as number
      expect(size).toBeGreaterThan(100_000)
      expect(size).toBeLessThan(150_000)
      expect(compactions(side.gateway)).toEqual([])

      // About 60,000 more tokens: the next request would be over 150,000.
      const added = text("item", 60_000)
      const second = await run(side, "Keep this second log too, then answer ok.", added)
      expect(second.exitCode, second.all).toBe(0)
      expect(second.all).toContain("Mock gateway reply")
      expect(compactions(side.gateway).length).toBe(1)

      // No task request carried the whole conversation of about 160,000 tokens.
      for (const entry of task(side.gateway)) expect(entry.tokens).toBeLessThan(150_000)
      const sent = task(side.gateway).at(-1)!
      expect(sent.status).toBe(200)
      // The request after the compaction carries the summary, not the logs.
      // It would have been size + 60,000 tokens.
      expect(sent.tokens).toBeLessThan((size + 60_000) / 2)
      const body = (side.gateway.bodies as Body[]).filter((item) => Array.isArray(item.json.tools) && item.json.tools.length > 0).at(-1)!
      expect(body.raw.toString()).not.toContain("line00000")
      // The new message went into the summary request, not lost.
      expect(compactions(side.gateway)[0].raw.toString()).toContain("item00000")
    },
    240_000,
  )

  test(
    "a request over the warning threshold shows one line suggesting /compact",
    async () => {
      const side = await setup()
      const extra = { [Brand.env.compactAt]: "off", [Brand.env.warnAt]: "40000" }
      const first = await run(side, "Keep the log below for later, then answer ok.", text("line", 50_000), extra)
      expect(first.exitCode, first.all).toBe(0)
      expect(first.all).not.toContain("Large request:")

      const second = await run(side, "What was the first line of the log?", undefined, extra)
      expect(second.exitCode, second.all).toBe(0)
      expect(second.all).toMatch(/Large request: about [\d,]+ tokens\. Run \/compact or start a new session/)
      expect(second.all.split("Large request:").length - 1).toBe(1)
      expect(compactions(side.gateway)).toEqual([])

      // 0 turns the line off.
      const third = await run(side, "And the second line?", undefined, { [Brand.env.compactAt]: "off", [Brand.env.warnAt]: "0" })
      expect(third.exitCode, third.all).toBe(0)
      expect(third.all).not.toContain("Large request:")
    },
    240_000,
  )
})
