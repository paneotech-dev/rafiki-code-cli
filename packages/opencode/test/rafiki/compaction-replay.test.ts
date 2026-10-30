// The compaction summary as a replay of the turn (session/compaction.ts, Run): on the session's own tier the
// summary request carries the same system text, the same tool definitions, the same tool_choice and the same
// conversation as the request before it, with the summary instruction as the last message. So it starts with the
// bytes the provider has just cached instead of a transcript the provider has never seen.
//
// `rafikicode run` against the mock gateway, with a compaction point low enough that the second step of the
// task compacts first. The mock reports each request's own size as its usage.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const KEY = "sk-compaction-replay-stub"
const SUMMARY = "## Objective\n- Print one word.\n\n## Next Move\n1. (none)"

type Body = { raw: Buffer; json: any }

// Any summary request: the instruction is its last message.
const asksSummary = (json: any) => /anchored summary|<prior-summary>/.test(JSON.stringify(json.messages.at(-1)))
// The replay: a summary request with no transcript pasted into it.
const isSummary = (body: Body) => asksSummary(body.json) && !JSON.stringify(body.json.messages).includes("<conversation>")

describe("compaction summary request", () => {
  let home: string
  let repo: string
  let gateway: ReturnType<typeof createMockGateway>

  let steps = 0
  let replayAnswer: "summary" | "tool" = "summary"

  beforeEach(async () => {
    steps = 0
    replayAnswer = "summary"
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-compaction-replay-"))
    repo = path.join(home, "repo")
    fs.mkdirSync(repo)
    spawnSync("git", ["init", "-q"], { cwd: repo })
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "# Project instructions\n\nKeep functions short.\n")
    gateway = createMockGateway({
      quiet: true,
      bodies: true,
      toolCall: { name: "bash", arguments: { command: "echo cached", description: "Print one word" } },
      // The first step of the task reports a size over the compaction point, every other request a small one, so the
      // session is compacted once, before its second step.
      usage: (body: any) => {
        const step = Array.isArray(body.tools) && body.tools.length > 0 && !asksSummary(body)
        const prompt = step && steps++ === 0 ? 5_000 : 100
        return { prompt_tokens: prompt, completion_tokens: 8, total_tokens: prompt + 8 }
      },
      respond: (body: any) => {
        if (!asksSummary(body)) return undefined
        // replayAnswer "tool": the replay is answered with a tool call, as a model ignoring the instruction would.
        if (replayAnswer === "tool" && isSummary({ raw: Buffer.alloc(0), json: body }))
          return { toolCall: { name: "bash", arguments: { command: "echo again", description: "Again" } } }
        return { content: SUMMARY }
      },
    })
    await gateway.ready
  })

  afterEach(async () => {
    await gateway.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function run(model: string, extra: Record<string, string> = {}) {
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
      RAFIKICODE_API_KEY: KEY,
      [Brand.env.compactAt]: "3000",
    }
    for (const k of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION", Brand.env.headless, Brand.env.trustWorkspace, Brand.env.cacheMarkers]) delete env[k]
    Object.assign(env, extra)
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", "--model", `rafiki/${model}`, "Print one word with the shell, then stop."], {
      cwd: repo,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    const bodies = gateway.bodies as Body[]
    return { exitCode, all: stdout + stderr, bodies }
  }

  test(
    "starts with the bytes of the turn before it",
    async () => {
      const { exitCode, all, bodies } = await run("rafiki-fast")
      expect(exitCode, all).toBe(0)
      const at = bodies.findIndex(isSummary)
      expect(at, all).toBeGreaterThan(0)
      const summary = bodies[at]
      // The request before it that carried the tool definitions: the task's first step.
      const turn = bodies.slice(0, at).findLast((body) => Array.isArray(body.json.tools) && body.json.tools.length > 0)!
      expect(turn).toBeDefined()

      // Same tool definitions and the same tool_choice, byte for byte.
      expect(JSON.stringify(summary.json.tools)).toBe(JSON.stringify(turn.json.tools))
      expect(summary.json.tool_choice).toBe(turn.json.tool_choice)
      // The turn's messages are the start of the summary request's messages, unchanged.
      const before = turn.json.messages
      expect(JSON.stringify(summary.json.messages.slice(0, before.length))).toBe(JSON.stringify(before))
      // The raw bytes too, up to the end of the turn's last message.
      const last = Buffer.from(JSON.stringify(before.at(-1)), "utf8")
      const end = turn.raw.indexOf(last) + last.length
      expect(end).toBeGreaterThan(last.length)
      expect(Buffer.compare(turn.raw.subarray(0, end), summary.raw.subarray(0, end))).toBe(0)
      // No transcript of the conversation is pasted into the instruction.
      expect(JSON.stringify(summary.json.messages.at(-1))).not.toContain("<conversation>")
      expect(summary.json.messages.at(-1).role).toBe("user")
    },
    { timeout: 120_000 },
  )

  test(
    "a compaction agent with a model of its own keeps the transcript request",
    async () => {
      const { exitCode, all, bodies } = await run("rafiki-pro", {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { compaction: { model: "rafiki/rafiki-fast" } } }),
      })
      expect(exitCode, all).toBe(0)
      expect(bodies.some(isSummary)).toBe(false)
      const legacy = bodies.find((body) => JSON.stringify(body.json.messages).includes("<conversation>"))
      expect(legacy, all).toBeDefined()
      expect(legacy!.json.model).toBe("rafiki-fast")
      expect(legacy!.json.tool_choice).toBeUndefined()
    },
    { timeout: 120_000 },
  )

  test(
    "a tier that takes cache markers keeps the transcript request",
    async () => {
      const { exitCode, all, bodies } = await run("rafiki-max")
      expect(exitCode, all).toBe(0)
      expect(bodies.some(isSummary)).toBe(false)
      const legacy = bodies.find((body) => JSON.stringify(body.json.messages).includes("<conversation>"))
      expect(legacy, all).toBeDefined()
      expect(legacy!.json.tool_choice).toBeUndefined()
    },
    { timeout: 120_000 },
  )

  test(
    "a replay answered with a tool call is written again from the transcript",
    async () => {
      replayAnswer = "tool"
      const { exitCode, all, bodies } = await run("rafiki-fast")
      expect(exitCode, all).toBe(0)
      const replay = bodies.findIndex(isSummary)
      expect(replay, all).toBeGreaterThan(0)
      const legacy = bodies.findIndex((body) => JSON.stringify(body.json.messages).includes("<conversation>"))
      expect(legacy, all).toBeGreaterThan(replay)
      expect(all).toContain("Print one word.")
    },
    { timeout: 120_000 },
  )
})
