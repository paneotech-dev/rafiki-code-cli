// rafikicode run against the mock gateway playing the key's tokens per minute
// limit (src/rafiki/tpm.ts). A session whose next request is larger than the
// limit used to be refused with the same 429 on every retry; now:
//
//   - a refusal of a request larger than the limit compacts the session and
//     sends the request once more, and the run ends normally;
//   - with the limit known from /key/info, the session compacts before the
//     request is sent, and the gateway never refuses anything;
//   - a 429 because earlier requests used the minute still waits and sends
//     the same request again, without compacting.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
// About 50,000 tokens at 4 characters a token: far more than the tail a
// compaction keeps, so compacting really makes the next request smaller.
const BIG = Array.from({ length: 20_000 }, (_, index) => `line${String(index).padStart(5, "0")}`).join(" ")

type Gateway = ReturnType<typeof createMockGateway>
type Body = { raw: Buffer; json: any; session?: string }

const refusal = (limit: number, remaining: number) => ({
  status: 429,
  type: "None",
  message: `Rate limit exceeded for api_key: hashed-1234. Limit type: tokens. Current limit: ${limit}, Remaining: ${remaining}. Limit resets at: 2026-10-12 10:01:00 UTC`,
  headers: { "retry-after": "1" },
})

let homes: string[] = []
let gateways: Gateway[] = []

afterEach(async () => {
  await Promise.all(gateways.map((gateway) => gateway.close()))
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true })
  homes = []
  gateways = []
})

async function setup(options: Record<string, unknown> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-tpm-"))
  const repo = path.join(home, "repo")
  fs.mkdirSync(repo)
  spawnSync("git", ["init", "-q"], { cwd: repo })
  const gateway = createMockGateway({
    quiet: true,
    bodies: true,
    // The request's own size, the way the gateway reports it.
    usage: (_body: unknown, tokens: number) => ({ prompt_tokens: tokens, completion_tokens: 8, total_tokens: tokens + 8 }),
    ...options,
  })
  await gateway.ready
  homes.push(home)
  gateways.push(gateway)
  return { home, repo, gateway }
}

type Side = Awaited<ReturnType<typeof setup>>

async function run(side: Side, key: string, message: string, input?: string) {
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
    RAFIKICODE_API_KEY: key,
  }
  for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_DB", "RAFIKICODE_CONSOLE_URL", Brand.env.headless, Brand.env.trustWorkspace])
    delete env[name]
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

describe("the key's tokens per minute limit", () => {
  test(
    "a refusal of a request larger than the limit compacts the session and sends it once more",
    async () => {
      const side = await setup()
      const first = await run(side, "sk-tpm-stub", "Keep the log below for later, then answer ok.", BIG)
      expect(first.exitCode, first.all).toBe(0)
      const size = task(side.gateway).at(-1)!.tokens as number
      // The session is now well over the limit the gateway is about to apply,
      // and a fresh request is well under it.
      const limit = size - 20_000
      side.gateway.options.refuse = (_body: unknown, tokens: number) => (tokens > limit ? refusal(limit, limit) : undefined)
      const before = chats(side.gateway).length

      const second = await run(side, "sk-tpm-stub", "What was the first line of the log?")
      expect(second.exitCode, second.all).toBe(0)
      expect(second.all).toContain("Compacting the session first: the gateway refused a request larger than this key's limit")
      expect(second.all).toContain("Mock gateway reply")
      expect(second.all).not.toContain("Too many requests")

      const after = chats(side.gateway).slice(before)
      const refused = after.filter((entry) => entry.status === 429)
      expect(refused.length).toBe(1)
      expect(compactions(side.gateway).length).toBe(1)
      // The compaction request itself fits under the limit, and so does the
      // request sent once more after it.
      for (const entry of after.filter((entry) => entry.status === 200)) expect(entry.tokens).toBeLessThanOrEqual(limit)
      const last = task(side.gateway).at(-1)!
      expect(last.status).toBe(200)
      expect(last.last_user ?? "").not.toContain("line00000")
    },
    240_000,
  )

  test(
    "with the limit read from /key/info, the session compacts before sending and nothing is refused",
    async () => {
      const side = await setup()
      const key = "sk-tpm-known-limit"
      await fetch(side.gateway.url + "/__test/register", {
        method: "POST",
        body: JSON.stringify({ key, key_alias: "rafikicode-tpm", tpm_limit: null }),
      })
      const first = await run(side, key, "Keep the log below for later, then answer ok.", BIG)
      expect(first.exitCode, first.all).toBe(0)
      const size = task(side.gateway).at(-1)!.tokens as number
      // The last request took 95% of the limit: the next one, a little
      // larger, is over the 90% the session allows itself.
      const limit = Math.ceil(size / 0.95)
      side.gateway.keys.get(key)!.tpm_limit = limit
      side.gateway.options.refuse = (_body: unknown, tokens: number) => (tokens > limit ? refusal(limit, limit) : undefined)
      const before = chats(side.gateway).length

      const second = await run(side, key, "What was the first line of the log?")
      expect(second.exitCode, second.all).toBe(0)
      expect(second.all).toMatch(
        /Compacting the session first: the next request is about [\d,]+ tokens, near this key's limit of [\d,]+ tokens per minute\./,
      )
      expect(second.all).toContain(limit.toLocaleString("en-US"))
      expect(second.all).toContain("Mock gateway reply")

      const after = chats(side.gateway).slice(before)
      expect(after.filter((entry) => entry.status !== 200)).toEqual([])
      expect(compactions(side.gateway).length).toBe(1)
      const sent = task(side.gateway).at(-1)!
      expect(sent.tokens).toBeLessThan(size / 2)
    },
    240_000,
  )

  test(
    "a 429 because earlier requests used the minute still waits and sends the same request again",
    async () => {
      let refused = 0
      const side = await setup({
        refuse: (body: any) => {
          if (!Array.isArray(body.tools) || body.tools.length === 0 || refused > 0) return undefined
          refused++
          return refusal(200_000, 500)
        },
      })
      const started = Date.now()
      const result = await run(side, "sk-tpm-stub", "Answer ok.")
      expect(result.exitCode, result.all).toBe(0)
      expect(result.all).toContain("Mock gateway reply")
      expect(result.all).not.toContain("Compacting the session first")
      const sent = task(side.gateway)
      expect(sent.map((entry) => entry.status)).toEqual([429, 200])
      expect(Math.abs(sent[0].tokens - sent[1].tokens)).toBeLessThan(50)
      expect(compactions(side.gateway)).toEqual([])
      // The retry waited for the second the gateway asked for.
      expect(Date.now() - started).toBeGreaterThan(1_000)
    },
    120_000,
  )
})
