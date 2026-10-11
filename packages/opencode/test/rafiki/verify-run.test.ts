// `rafikicode run` and the verify step, end to end against the mock gateway.
// The project is a git repository whose test script (`bun run test`) passes
// while value.cfg says "good". The mock model changes value.cfg with a shell
// call on the turns the test chooses, then answers "Done".
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import { createMockGateway } from "../brand/mock-gateway.mjs"
import * as Verify from "../../src/rafiki/verify"

const root = path.resolve(import.meta.dir, "../..")
const KEY = "sk-verify-run-stub"

type Call = { name: string; arguments: Record<string, unknown> } | undefined
type Message = { role: string; content: unknown }

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
}

const text = (message: Message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content))
const isTitle = (messages: Message[]) => messages.some((message) => text(message).includes("title generator"))
const shell = (command: string): Call => ({ name: "bash", arguments: { command, description: "Change the value" } })

describe("rafikicode run and the verify step", () => {
  let home: string
  let repo: string
  let gateway: ReturnType<typeof createMockGateway>
  let userTurns: string[]

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-verify-run-"))
    repo = path.join(home, "repo")
    fs.mkdirSync(repo)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "Test")
    userTurns = []
  })

  afterEach(async () => {
    await gateway?.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  function project() {
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "demo", private: true, scripts: { test: "bun check.js" } }))
    fs.writeFileSync(path.join(repo, "bun.lock"), "")
    fs.writeFileSync(
      path.join(repo, "check.js"),
      'const v = require("fs").readFileSync("value.cfg", "utf8").trim()\nif (v !== "good") { console.error("expected good, got " + v); process.exit(1) }\nconsole.log("1 passed")\n',
    )
    fs.writeFileSync(path.join(repo, "value.cfg"), "good\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "first")
  }

  // calls(turn): the call the model makes on the nth user message of the conversation.
  async function run(calls: (turn: number) => Call, args: string[] = [], extra: Record<string, string | undefined> = {}) {
    gateway = createMockGateway({
      quiet: true,
      reply: "Done.",
      toolCallEach: (turn: number, messages: Message[]) => {
        if (isTitle(messages)) return undefined
        userTurns.push(text(messages[messages.length - 1]))
        return calls(turn)
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
    for (const k of ["CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION", Brand.env.verify, Brand.env.headless, Brand.env.trustWorkspace])
      delete env[k]
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", "--auto", ...args, "--model", "rafiki/rafiki-fast", "Fix the value."], {
      cwd: repo,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { exitCode, stdout, all: stdout + stderr }
  }

  const events = (stdout: string) =>
    stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>)

  test("an edit that breaks a test gets the failure back, and the fix passes", async () => {
    project()
    const result = await run((turn) => (turn === 1 ? shell("echo bad > value.cfg") : turn === 2 ? shell("echo good > value.cfg") : undefined))
    expect(result.all).toContain("checks failed, fix round 1 of 2: bun run test")
    expect(result.all).toContain("checks passed: bun run test")
    // The fix round is part of the same turn on the Task: line.
    expect(result.all).toMatch(/Task: tier fast · .* · checks passed/)
    expect(result.exitCode).toBe(0)
    // The second user message the model saw is the failure, with the test's own output.
    expect(userTurns[1]).toContain("The project's checks failed after your changes (verify round 1 of 2)")
    expect(userTurns[1]).toContain("expected good, got bad")
    expect(fs.readFileSync(path.join(repo, "value.cfg"), "utf8").trim()).toBe("good")
  }, 240_000)

  test("a check that still fails ends with the honest line and exit code 8", async () => {
    project()
    const result = await run((turn) => (turn === 1 ? shell("echo bad > value.cfg") : turn === 2 ? shell("echo worse > value.cfg") : shell("true")))
    expect(result.all).toContain("checks failed, fix round 2 of 2")
    expect(result.all).toContain("checks failing: bun run test (exit code 1) after 2 fix rounds. The changes are not verified.")
    expect(result.exitCode).toBe(Verify.EXIT_CHECKS_FAILING)
    expect(userTurns.length).toBe(3)
  }, 240_000)

  test("a round that changes nothing about the failure ends the fix rounds", async () => {
    project()
    const result = await run((turn) => (turn === 1 ? shell("echo bad > value.cfg") : shell("true")))
    expect(result.all).toContain("checks failed, fix round 1 of 2")
    expect(result.all).not.toContain("fix round 2 of 2")
    expect(result.all).toContain("checks failing: bun run test (exit code 1) after 1 fix round. The changes are not verified.")
    expect(result.exitCode).toBe(Verify.EXIT_CHECKS_FAILING)
    expect(userTurns.length).toBe(2)
  }, 240_000)

  test("JSON output carries the verify status, and the exit code is 8 there too", async () => {
    project()
    const result = await run((turn) => (turn === 1 ? shell("echo bad > value.cfg") : undefined), ["--format", "json"], {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ verify: { rounds: 0 } }),
    })
    const verify = events(result.stdout).filter((event) => event.type === "verify")
    expect(verify.at(-1)).toMatchObject({ type: "verify", status: "failing", rounds: 0 })
    expect((verify.at(-1)!.checks as { command: string; status: string }[])[0]).toMatchObject({ command: "bun run test", status: "failed" })
    expect(result.exitCode).toBe(Verify.EXIT_CHECKS_FAILING)
  }, 240_000)

  test("no checks found: no verify step, one line says so", async () => {
    fs.writeFileSync(path.join(repo, "value.cfg"), "good\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "first")
    const result = await run((turn) => (turn === 1 ? shell("echo bad > value.cfg") : undefined))
    expect(result.all).toContain("no checks found for this project, so the changes were not verified")
    expect(result.all).not.toContain("checks failed")
    expect(result.exitCode).toBe(0)
    expect(userTurns.length).toBe(1)
  }, 240_000)

  test("RAFIKICODE_VERIFY=0 turns it off", async () => {
    project()
    const result = await run((turn) => (turn === 1 ? shell("echo bad > value.cfg") : undefined), ["--format", "json"], {
      [Brand.env.verify]: "0",
    })
    // No verify event at all when the step did not run, so the JSON stream is the same as without it.
    expect(events(result.stdout).filter((event) => event.type === "verify")).toEqual([])
    expect(result.exitCode).toBe(0)
    expect(userTurns.length).toBe(1)
  }, 240_000)

  test("the working practice is in the system text while the step is on", async () => {
    project()
    gateway = createMockGateway({ quiet: true, reply: "Done.", bodies: true })
    await gateway.ready
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", "--model", "rafiki/rafiki-fast", "Hello."], {
      cwd: repo,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
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
      } as Record<string, string>,
    })
    await proc.exited
    const bodies = gateway.bodies as { json: { messages: Message[] } }[]
    const main = bodies.find((body) => !isTitle(body.json.messages))
    expect(main).toBeDefined()
    const system = main!.json.messages.filter((message) => message.role === "system").map(text).join("\n")
    expect(system).toContain("When the task reports a bug, reproduce it first")
    expect(system).toContain("Do not try to download packages")
  }, 240_000)
})
