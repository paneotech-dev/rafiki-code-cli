// The gateway's cap on the input of one request (src/rafiki/input-cap.ts):
// 200000 tokens on every tier since 2026-10-24, refused with HTTP 413,
// invalid_request_error, context_length_exceeded.
//
//   - a refused request compacts the session and is sent once more; the run
//     ends with exit code 0 and no error line;
//   - a message that is refused again after that compaction stops the turn
//     with one plain message, without compacting in a loop;
//   - the compaction request is cut to fit under the cap;
//   - a status code in a retry check is only read where a message gives one,
//     never from digits inside a token count.
// The registered input limit itself is checked in test/brand/display-limits.test.ts.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as InputCap from "../../src/rafiki/input-cap"
import * as Tpm from "../../src/rafiki/tpm"
import { SessionRetry } from "../../src/session/retry"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
// About 50,000 tokens at 4 characters a token.
const BIG = Array.from({ length: 20_000 }, (_, index) => `line${String(index).padStart(5, "0")}`).join(" ")

type Gateway = ReturnType<typeof createMockGateway>
type Body = { raw: Buffer; json: any; session?: string }

// The gateway's answer over the cap.
const tooLarge = (tokens: number, limit: number) => ({
  status: 413,
  type: "invalid_request_error",
  code: "context_length_exceeded",
  message: `rafiki-fast: this request has ${tokens.toLocaleString("en-US")} input tokens, over the limit of ${limit.toLocaleString("en-US")} input tokens per request.`,
})

let homes: string[] = []
let gateways: Gateway[] = []

afterEach(async () => {
  await Promise.all(gateways.map((gateway) => gateway.close()))
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true })
  homes = []
  gateways = []
})

async function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-input-cap-"))
  const repo = path.join(home, "repo")
  fs.mkdirSync(repo)
  spawnSync("git", ["init", "-q"], { cwd: repo })
  const gateway = createMockGateway({
    quiet: true,
    bodies: true,
    usage: (_body: unknown, tokens: number) => ({ prompt_tokens: tokens, completion_tokens: 8, total_tokens: tokens + 8 }),
  })
  await gateway.ready
  homes.push(home)
  gateways.push(gateway)
  return { home, repo, gateway }
}

type Side = Awaited<ReturnType<typeof setup>>

async function run(side: Side, message: string, input?: string) {
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
    RAFIKICODE_API_KEY: "sk-input-cap-stub",
  }
  for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_DB", "RAFIKICODE_CONSOLE_URL", Brand.env.headless, Brand.env.trustWorkspace])
    delete env[name]
  const session = (gateway.bodies as Body[]).find((body) => body.session)?.session
  const args = ["run", "--model", "rafiki/rafiki-fast", ...(session ? ["--session", session] : []), message]
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args], {
    cwd: repo,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { exitCode: await proc.exited, all: stdout + stderr }
}

const chats = (gateway: Gateway) => (gateway.requests as any[]).filter((entry) => entry.path === "/v1/chat/completions")
const task = (gateway: Gateway) => chats(gateway).filter((entry) => entry.tools > 0)
const compactions = (gateway: Gateway) =>
  (gateway.bodies as Body[]).filter((body) => JSON.stringify(body.json.messages).includes("Here is the conversation so far"))

describe("a request over the gateway's input cap", () => {
  test(
    "is compacted and sent once more; the run ends normally, without an error line",
    async () => {
      const side = await setup()
      const first = await run(side, "Keep the log below for later, then answer ok.", BIG)
      expect(first.exitCode, first.all).toBe(0)
      const size = task(side.gateway).at(-1)!.tokens as number
      const limit = size - 20_000
      // The task's requests over the limit are refused; the compaction request has no tools.
      side.gateway.options.refuse = (body: any, tokens: number) =>
        Array.isArray(body.tools) && body.tools.length > 0 && tokens > limit ? tooLarge(tokens, limit) : undefined
      const before = chats(side.gateway).length

      const second = await run(side, "What was the first line of the log?")
      expect(second.exitCode, second.all).toBe(0)
      expect(second.all).toContain(`Compacting the session first: the request was over the gateway's limit of ${limit.toLocaleString("en-US")} input tokens`)
      expect(second.all).toContain("Mock gateway reply")
      expect(second.all).not.toMatch(/Error|error:/)

      const after = chats(side.gateway).slice(before)
      expect(after.filter((entry) => entry.status === 413).length).toBe(1)
      expect(compactions(side.gateway).length).toBe(1)
      expect(task(side.gateway).at(-1)!.status).toBe(200)
    },
    240_000,
  )

  test(
    "a message too large on its own stops with one plain message after one compaction",
    async () => {
      const side = await setup()
      const first = await run(side, "Answer ok.")
      expect(first.exitCode, first.all).toBe(0)
      // Every request of the task is refused: the message alone is over the cap.
      side.gateway.options.refuse = (body: any, tokens: number) =>
        Array.isArray(body.tools) && body.tools.length > 0 ? tooLarge(tokens + 200_000, 200_000) : undefined
      const before = chats(side.gateway).length

      const second = await run(side, "Read this.")
      expect(second.exitCode).not.toBe(0)
      expect(second.all).toContain("This message alone is larger than the gateway's limit of 200,000 input tokens, even after compacting the session.")
      const after = chats(side.gateway).slice(before)
      expect(after.filter((entry) => entry.status === 413).length).toBe(2)
      expect(compactions(side.gateway).length).toBe(1)
    },
    240_000,
  )
})

describe("the parts", () => {
  test("the limit named by the gateway, or the brand's", () => {
    expect(InputCap.limitFrom("rafiki-pro: 245,429 input tokens, over the limit of 200,000 input tokens")).toBe(200_000)
    expect(InputCap.limitFrom("Request too large")).toBe(Brand.context.inputCap)
    expect(InputCap.limitFrom(undefined)).toBe(200_000)
  })

  test("refused once, then answered: the mark is per session and cleared", () => {
    InputCap.reset()
    expect(InputCap.marked("ses_a")).toBe(false)
    InputCap.mark("ses_a")
    expect(InputCap.marked("ses_a")).toBe(true)
    expect(InputCap.marked("ses_b")).toBe(false)
    InputCap.clear("ses_a")
    expect(InputCap.marked("ses_a")).toBe(false)
  })

  test("the compaction request is cut to fit under the input cap", () => {
    const text = "x".repeat(1_000_000)
    const cut = Tpm.fit(text, undefined, 8_000, 200_000)
    expect(cut.startsWith("[Earlier conversation omitted: it is larger than the gateway's limit of input tokens for one request]")).toBe(true)
    // At 4 characters a token, with the share and the reserve: well under 200,000 tokens.
    expect(cut.length / 4).toBeLessThan(200_000 * Tpm.SHARE)
    expect(cut.endsWith("x")).toBe(true)
    // A key limit lower than the cap decides, with its own note.
    expect(Tpm.fit(text, 100_000, 8_000, 200_000)).toContain("this key's limit of tokens per minute")
    // A key limit higher than the cap: the cap decides.
    expect(Tpm.fit(text, 2_000_000, 8_000, 200_000)).toContain("input tokens for one request")
    expect(Tpm.fit("short", undefined, 8_000, 200_000)).toBe("short")
  })

  test("a status code is read only where a message gives one", () => {
    const wrap = (message: string) => ({ name: "", data: { message } }) as any
    for (const message of [
      "rafiki-pro: this request has 245,429 input tokens, over the limit of 200,000",
      "Prompt of 1,500,502 characters",
      "read 4291 lines",
      "id 5030 not found",
    ])
      expect(SessionRetry.retryable(wrap(message), "test")).toBeUndefined()
    for (const message of ["429 Too Many Requests", "HTTP 502 Bad Gateway", "upstream returned status 524", "Request failed with status code 503.", "error: 500", "[504] gateway timeout", '{"error":{"code":503}}'])
      expect(SessionRetry.retryable(wrap(message), "test")).toEqual({ message })
  })
})
