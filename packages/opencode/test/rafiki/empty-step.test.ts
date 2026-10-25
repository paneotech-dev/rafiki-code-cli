// A step that finishes with no text and no tool call does not end the task.
// On 25 Oct 2026 a rafiki-pro task (ui-pricing-page) read the project, wrote
// index.html, and then got this 381 byte stream for its next step: a role
// chunk and a finish chunk with finish_reason "stop", no content, no tool
// call, no usage. The loop took it as the end of the task, so styles.css and
// script.js were never written and nothing said why. The step is now tried
// again once; a second empty step stops the task with a plain error.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import { EMPTY_MESSAGE, RETRY_LINE, applies, isEmptyStep, retried, retryNote } from "../../src/rafiki/empty-step"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const KEY = "sk-empty-step-stub"

// The stream as the gateway sent it (Caddy: 200, text/event-stream, 381 bytes,
// 0.5 s; no LiteLLM spend row). The id is a stand-in of the same length.
const ID = "5f0c2a9e-7b14-4d36-a8e1-93c6b0d2f4a7"
const chunk = (choice: object) =>
  "data: " + JSON.stringify({ id: ID, created: 1792910791, model: "rafiki-pro", object: "chat.completion.chunk", choices: [choice] }) + "\n\n"
const LOST_STREAM =
  chunk({ index: 0, delta: { role: "assistant" } }) +
  chunk({ finish_reason: "stop", index: 0, delta: {} }) +
  "data: [DONE]\n\n"

// DeepSeek thinking mode: reasoning only, then "stop" with empty content.
const REASONING_ONLY =
  chunk({ index: 0, delta: { role: "assistant", content: "", reasoning_content: "" } }) +
  chunk({ index: 0, delta: { reasoning_content: "Next I add the stylesheet." } }) +
  chunk({ index: 0, delta: { content: "" }, finish_reason: "stop" }) +
  "data: " +
  JSON.stringify({ id: ID, created: 1792910791, model: "rafiki-pro", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 16_000, completion_tokens: 12, total_tokens: 16_012 } }) +
  "\n\n" +
  "data: [DONE]\n\n"

describe("empty step", () => {
  test("the replayed stream is the size the gateway logged", () => {
    expect(Buffer.byteLength(LOST_STREAM)).toBe(381)
  })

  test("no text and no tool call is empty; text, a tool, or a finish with its own handling is not", () => {
    expect(isEmptyStep("stop", [{ type: "step-start" }, { type: "step-finish" }])).toBe(true)
    expect(isEmptyStep("stop", [{ type: "reasoning", text: "thinking" }])).toBe(true)
    expect(isEmptyStep("stop", [{ type: "text", text: "  " }])).toBe(true)
    expect(isEmptyStep("other", [])).toBe(true)
    expect(isEmptyStep("stop", [{ type: "text", text: "Done." }])).toBe(false)
    expect(isEmptyStep("stop", [{ type: "text", text: "note", synthetic: true }])).toBe(true)
    expect(isEmptyStep("stop", [{ type: "tool" }])).toBe(false)
    for (const finish of ["tool-calls", "unknown", "length", "content-filter", undefined]) expect(isEmptyStep(finish, [])).toBe(false)
  })

  test("only gateway steps that did not fail already", () => {
    expect(applies({ providerID: Brand.provider.id, finish: "stop" }, [])).toBe(true)
    expect(applies({ providerID: "openai", finish: "stop" }, [])).toBe(false)
    expect(applies({ providerID: Brand.provider.id, finish: "stop", error: { name: "APIError" } }, [])).toBe(false)
    expect(applies({ providerID: Brand.provider.id, finish: "stop", summary: true }, [])).toBe(false)
  })

  test("the retry is spent when the step before, in the same turn, carries the retry note", () => {
    expect(retried({ parentID: "u1", error: retryNote() }, "u1")).toBe(true)
    expect(retried({ parentID: "u0", error: retryNote() }, "u1")).toBe(false)
    expect(retried({ parentID: "u1" }, "u1")).toBe(false)
    expect(retried(undefined, "u1")).toBe(false)
    expect(EMPTY_MESSAGE).not.toMatch(/deepseek|opencode|litellm/i)
  })
})

describe("rafikicode run when a step comes back empty", () => {
  let home: string
  let repo: string
  let gateway: ReturnType<typeof createMockGateway> | undefined

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-empty-step-"))
    repo = path.join(home, "repo")
    fs.mkdirSync(repo)
    spawnSync("git", ["init", "-q"], { cwd: repo })
    fs.writeFileSync(path.join(repo, "index.html"), "<p>Pricing page coming soon.</p>\n")
  })

  afterEach(async () => {
    await gateway?.close()
    gateway = undefined
    fs.rmSync(home, { recursive: true, force: true })
  })

  // The first step reads index.html; after the tool result, `empties` steps
  // get `raw`, then the canned reply answers.
  async function start(raw: string, empties: number) {
    let sent = 0
    gateway = createMockGateway({
      quiet: true,
      toolCall: { name: "read", arguments: { filePath: path.join(repo, "index.html") } },
      respond: (body: any) => {
        const messages = Array.isArray(body.messages) ? body.messages : []
        if (!Array.isArray(body.tools) || !messages.some((m: any) => m?.role === "tool")) return undefined
        if (sent >= empties) return undefined
        sent++
        return { raw }
      },
    })
    await gateway.ready
  }

  async function run(prompt: string) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      COLUMNS: "120",
      PWD: repo,
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      RAFIKICODE_GATEWAY_URL: gateway!.url + "/v1",
      RAFIKICODE_API_KEY: KEY,
    }
    for (const k of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION"])
      delete env[k]
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", "--model", "rafiki/rafiki-pro", prompt], {
      cwd: repo,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { exitCode: await proc.exited, all: stdout + stderr }
  }

  // The task's steps: the calls with tools (the title call has none).
  const steps = () => gateway!.requests.filter((r: any) => r.path === "/v1/chat/completions" && r.tools > 0)

  test("the replayed lost stream is tried again once and the task goes on", async () => {
    await start(LOST_STREAM, 1)
    const result = await run("lost stream check")
    expect(result.exitCode).toBe(0)
    expect(result.all.split(RETRY_LINE).length - 1).toBe(1)
    expect(result.all).toContain("Mock gateway reply")
    expect(result.all).not.toContain(EMPTY_MESSAGE)
    expect(result.all).not.toContain(KEY)
    // The read, the empty step, and its retry.
    const sent = steps()
    expect(sent.length).toBe(3)
    // The empty step is not sent back: the retry carries the same messages.
    expect(sent[2].messages).toBe(sent[1].messages)
  }, 120_000)

  test("a reasoning-only step that is empty again after the retry stops the task and says so", async () => {
    await start(REASONING_ONLY, 10)
    const result = await run("reasoning only check")
    expect(result.exitCode).toBe(1)
    expect(result.all.split(RETRY_LINE).length - 1).toBe(1)
    expect(result.all).toContain(EMPTY_MESSAGE)
    expect(result.all).not.toContain("Mock gateway reply")
    // The read, the empty step, and one retry: no third try.
    expect(steps().length).toBe(3)
  }, 120_000)
})
