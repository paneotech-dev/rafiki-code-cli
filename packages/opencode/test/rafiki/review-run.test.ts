// `rafikicode run` with the acceptance criteria and the review pass, end to
// end against the mock gateway. The project's test (`bun run test`) passes
// while value.cfg says "good"; the mock model writes it with a shell call.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const KEY = "sk-review-run-stub"
const REQUEST = "The value in value.cfg is wrong: it says bad but it should say good. Fix it and keep the test passing."

type Call = { name: string; arguments: Record<string, unknown> } | undefined
type Message = { role: string; content: unknown }
type Body = { model: string; messages: Message[] }

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
}

const text = (message: Message) =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content)
const isTitle = (messages: Message[]) => messages.some((message) => text(message).includes("title generator"))
const shell = (command: string): Call => ({ name: "bash", arguments: { command, description: "Change the value" } })

describe("rafikicode run with criteria and the review pass", () => {
  let home: string
  let repo: string
  let gateway: ReturnType<typeof createMockGateway>
  let userTurns: string[]
  let asides: { kind: string; body: Body }[]

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-review-run-"))
    repo = path.join(home, "repo")
    fs.mkdirSync(repo)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "Test")
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "demo", private: true, scripts: { test: "bun check.js" } }),
    )
    fs.writeFileSync(path.join(repo, "bun.lock"), "")
    fs.writeFileSync(
      path.join(repo, "check.js"),
      'const v = require("fs").readFileSync("value.cfg", "utf8").trim()\nif (v !== "good") { console.error("expected good, got " + v); process.exit(1) }\nconsole.log("1 passed")\n',
    )
    fs.writeFileSync(path.join(repo, "value.cfg"), "bad\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "first")
    userTurns = []
    asides = []
  })

  afterEach(async () => {
    await gateway?.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function run(input: {
    calls: (turn: number) => Call
    aside: (kind: string, count: number) => string | undefined
    prompt?: string
    args?: string[]
    env?: Record<string, string | undefined>
  }) {
    gateway = createMockGateway({
      quiet: true,
      reply: "Done.",
      costInUsage: true,
      aside: (kind: string, body: Body) => {
        asides.push({ kind, body })
        return input.aside(kind, asides.filter((item) => item.kind === kind).length)
      },
      toolCallEach: (turn: number, messages: Message[]) => {
        if (isTitle(messages)) return undefined
        userTurns.push(text(messages[messages.length - 1]))
        return input.calls(turn)
      },
    })
    await gateway.ready
    const env: Record<string, string | undefined> = {
      ...process.env,
      COLUMNS: "120",
      PWD: repo,
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      RAFIKICODE_GATEWAY_URL: gateway.url + "/v1",
      RAFIKICODE_API_KEY: KEY,
    }
    for (const k of [
      "CI",
      "GITHUB_ACTIONS",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_PERMISSION",
      Brand.env.verify,
      Brand.env.review,
      Brand.env.headless,
      Brand.env.trustWorkspace,
    ])
      delete env[k]
    // The review is opt-in; these tests turn it on unless they say otherwise.
    env[Brand.env.review] = "1"
    for (const [k, v] of Object.entries(input.env ?? {})) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        path.join(root, "src/index.ts"),
        "run",
        "--auto",
        ...(input.args ?? []),
        "--model",
        "rafiki/rafiki-fast",
        input.prompt ?? REQUEST,
      ],
      { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: env as Record<string, string> },
    )
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { exitCode, stdout, all: stdout + stderr }
  }

  const CRITERIA = JSON.stringify({ bug: true, criteria: ["value.cfg says good", "The test of the project passes"] })
  const verdict = (...pass: boolean[]) =>
    JSON.stringify({
      results: pass.map((value, index) => ({ id: index + 1, pass: value, reason: value ? "shown" : "not shown" })),
    })

  test("criteria first, a review that fails sends one more round, the second review passes", async () => {
    const result = await run({
      calls: (turn) => (turn <= 2 ? shell("echo good > value.cfg") : undefined),
      aside: (kind, count) =>
        kind === "criteria" ? CRITERIA : count === 1 ? verdict(true, false, false) : verdict(true, true, true),
    })
    expect(result.exitCode).toBe(0)
    // The criteria are written on rafiki-fast, the reviews run on rafiki-pro.
    expect(asides.map((item) => [item.kind, item.body.model])).toEqual([
      ["criteria", "rafiki-fast"],
      ["review", "rafiki-pro"],
      ["review", "rafiki-pro"],
    ])
    // The request carries the criteria and, for a bug, the reproduce first steps with the test command.
    expect(userTurns[0]).toContain("Acceptance criteria for this task")
    expect(userTurns[0]).toContain("1. value.cfg says good")
    expect(userTurns[0]).toContain("3. A test (or a short script")
    expect(userTurns[0]).toContain("Reproduce it before you fix it")
    expect(userTurns[0]).toContain("bun run test")
    // The review sees a curated context: the request, the criteria, the diff and the checks, not the conversation.
    const review = text(asides[1].body.messages.at(-1)!)
    expect(review).toContain(REQUEST)
    expect(review).toContain("value.cfg")
    expect(review).toMatch(/-bad\s+\+good/)
    expect(review).toContain("$ bun run test: passed")
    expect(asides[1].body.messages.filter((message) => message.role !== "system").length).toBe(1)
    // The failed criteria went back to the model for one round.
    expect(userTurns[1]).toContain("A review of your change found criteria that are not met yet (review round 1 of 1)")
    expect(userTurns[1]).toContain("2. The test of the project passes")
    expect(result.all).toContain("review: criteria 2, 3 not met, round 1 of 1")
    expect(result.all).toMatch(/criteria met: 3 of 3 after 1 review round \(review on rafiki-pro, [\d.]+ USD\)/)
    expect(result.all).toContain("checks passed: bun run test")
  }, 240_000)

  test("criteria still not met after the extra round: the line says so, no third round", async () => {
    const result = await run({
      calls: (turn) => (turn <= 3 ? shell("echo good > value.cfg") : undefined),
      aside: (kind) => (kind === "criteria" ? CRITERIA : verdict(true, false, true)),
      args: ["--format", "json"],
    })
    expect(asides.filter((item) => item.kind === "review").length).toBe(2)
    expect(userTurns.length).toBe(2)
    const events = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(events.find((event) => event.type === "criteria")).toMatchObject({ bug: true })
    expect(events.find((event) => event.type === "review" && event.status === "retry")).toMatchObject({
      round: 1,
      rounds: 1,
      failed: [2],
    })
    const last = events.filter((event) => event.type === "review").at(-1)!
    expect(last).toMatchObject({ status: "failing", rounds: 1, model: "rafiki-pro" })
    expect(typeof last.cost).toBe("number")
  }, 240_000)

  test("a review answer that cannot be read is asked for once more", async () => {
    const result = await run({
      calls: (turn) => (turn === 1 ? shell("echo good > value.cfg") : undefined),
      aside: (kind, count) =>
        kind === "criteria" ? CRITERIA : count === 1 ? "I could not decide." : verdict(true, true, true),
    })
    expect(result.exitCode).toBe(0)
    expect(asides.map((item) => item.kind)).toEqual(["criteria", "review", "review"])
    expect(userTurns.length).toBe(1)
    expect(result.all).toMatch(/criteria met: 3 of 3 \(review on rafiki-pro, [\d.]+ USD\)/)
  }, 240_000)

  test("a trivial request gets no criteria and no review", async () => {
    const result = await run({
      calls: (turn) => (turn === 1 ? shell("echo good > value.cfg") : undefined),
      aside: () => undefined,
      prompt: "Fix value.cfg.",
    })
    expect(result.exitCode).toBe(0)
    expect(asides).toEqual([])
    expect(userTurns.length).toBe(1)
  }, 240_000)

  test("by default the criteria and the reproduce first steps are on, the review is off", async () => {
    const result = await run({
      calls: (turn) => (turn === 1 ? shell("echo good > value.cfg") : undefined),
      aside: (kind) => (kind === "criteria" ? CRITERIA : verdict(false, false, false)),
      env: { [Brand.env.review]: undefined },
    })
    expect(result.exitCode).toBe(0)
    expect(asides.map((item) => item.kind)).toEqual(["criteria"])
    expect(userTurns[0]).toContain("check each one before you say the task is done")
    expect(userTurns[0]).toContain("Reproduce it before you fix it")
    expect(userTurns.length).toBe(1)
    expect(result.all).not.toContain("review on")
  }, 240_000)

  test("RAFIKICODE_REVIEW=0 turns the review off, review.criteria false turns the criteria off", async () => {
    const off = await run({
      calls: (turn) => (turn === 1 ? shell("echo good > value.cfg") : undefined),
      aside: (kind) => (kind === "criteria" ? CRITERIA : verdict(false, false, false)),
      env: { [Brand.env.review]: "0", OPENCODE_CONFIG_CONTENT: JSON.stringify({ review: { enabled: true } }) },
    })
    expect(off.exitCode).toBe(0)
    expect(asides.map((item) => item.kind)).toEqual(["criteria"])
    await gateway.close()
    asides = []
    const none = await run({
      calls: (turn) => (turn === 1 ? shell("echo good > value.cfg") : undefined),
      aside: (kind) => (kind === "criteria" ? CRITERIA : verdict(false, false, false)),
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ review: { criteria: false } }) },
    })
    expect(none.exitCode).toBe(0)
    expect(asides).toEqual([])
    expect(none.all).not.toContain("criteria")
  }, 240_000)

  test("a turn that changed nothing is not reviewed", async () => {
    const result = await run({
      calls: () => undefined,
      aside: (kind) => (kind === "criteria" ? CRITERIA : verdict(false, false, false)),
    })
    expect(result.exitCode).toBe(0)
    expect(asides.map((item) => item.kind)).toEqual(["criteria"])
    expect(userTurns.length).toBe(1)
  }, 240_000)
})
