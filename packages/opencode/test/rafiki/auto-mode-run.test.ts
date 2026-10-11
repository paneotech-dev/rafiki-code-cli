// `rafikicode run --auto` against the mock gateway: the model writes a file
// and runs the tests with no question, in a config where edits and shell
// commands ask; a guarded action and a command the risk check rates high are
// refused with the reason; plan mode refuses the edit.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as PermissionMode from "@opencode-ai/core/brand/permission-mode"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const KEY = "sk-auto-mode-run-stub"
const RISK = "You rate one shell command"

type Call = { name: string; arguments: Record<string, unknown> }
type Body = { messages?: { role?: string; content?: unknown }[] }

const isRisk = (body: Body) => typeof body.messages?.[0]?.content === "string" && (body.messages[0].content as string).startsWith(RISK)

describe("rafikicode run in auto mode", () => {
  let home: string
  let repo: string
  let gateway: ReturnType<typeof createMockGateway>
  // What the tool calls answered, as the model saw it.
  let results: string[] = []

  beforeEach(() => {
    results = []
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-auto-run-"))
    repo = path.join(home, "repo")
    fs.mkdirSync(repo)
    fs.writeFileSync(path.join(repo, "build.txt"), "keep\n")
  })

  afterEach(async () => {
    await gateway?.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  // The model makes these tool calls one after the other, then answers.
  async function run(calls: Call[], args: string[], options: { risk?: string; extra?: Record<string, string | undefined> } = {}) {
    gateway = createMockGateway({
      quiet: true,
      respond: (body: Body) => {
        if (isRisk(body)) return { content: options.risk ?? '{"risk":"low","reason":"fine"}' }
        const tools = (body.messages ?? []).filter((m) => m?.role === "tool")
        results = tools.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        const done = tools.length
        const call = calls[done]
        return call ? { toolCall: call } : { content: "All done." }
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
      // A cautious config: edits and shell commands ask.
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: "ask", bash: "ask" }, verify: { enabled: false } }),
    }
    for (const k of ["CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_PERMISSION", "RAFIKICODE_ALLOW_PUSH", PermissionMode.ENV, Brand.env.headless, Brand.env.trustWorkspace]) delete env[k]
    for (const [k, v] of Object.entries(options.extra ?? {})) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", ...args, "--model", "rafiki/rafiki-fast", "Do the task."], {
      cwd: repo,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { exitCode, all: stdout + stderr }
  }

  const work: Call[] = [
    { name: "write", arguments: { filePath: "sum.test.ts", content: 'import { expect, test } from "bun:test"\ntest("sum", () => expect(1 + 1).toBe(2))\n' } },
    { name: "bash", arguments: { command: "bun test sum.test.ts > test-output.txt 2>&1; echo exit=$?", description: "Run the tests" } },
  ]

  test("without --auto the edit is refused", async () => {
    const result = await run(work, [])
    expect(fs.existsSync(path.join(repo, "sum.test.ts"))).toBe(false)
    expect(result.all).toContain("auto-rejecting")
  }, 180_000)

  test("--auto writes the file and runs the tests without a question", async () => {
    const result = await run(work, ["--auto"])
    expect(result.all).not.toContain("auto-rejecting")
    expect(result.all).not.toContain("refused")
    expect(fs.existsSync(path.join(repo, "sum.test.ts"))).toBe(true)
    expect(fs.readFileSync(path.join(repo, "test-output.txt"), "utf8")).toContain("1 pass")
    expect(result.exitCode).toBe(0)
    // Known commands need no risk check.
    expect(gateway.requests.filter((item) => item.max_tokens === 100).length).toBe(0)
  }, 180_000)

  test("RAFIKICODE_PERMISSION_MODE=auto does the same", async () => {
    const result = await run(work, [], { extra: { [PermissionMode.ENV]: "auto" } })
    expect(result.all).not.toContain("auto-rejecting")
    expect(fs.existsSync(path.join(repo, "test-output.txt"))).toBe(true)
  }, 180_000)

  test("a guarded action is refused with the reason", async () => {
    const result = await run([{ name: "bash", arguments: { command: "echo cleaning && rm -rf build.txt", description: "Clean" } }], ["--auto"])
    expect(fs.existsSync(path.join(repo, "build.txt"))).toBe(true)
    expect(result.all).toContain("refused in auto mode: recursive delete")
    expect(result.all).toContain("allow it by name")
  }, 180_000)

  test("a rule written for the command lets it run", async () => {
    await run([{ name: "bash", arguments: { command: "rm -rf build.txt", description: "Clean" } }], ["--auto"], {
      extra: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: "ask", bash: { "*": "ask", "rm -rf build.txt": "allow" } } }) },
    })
    expect(fs.existsSync(path.join(repo, "build.txt"))).toBe(false)
  }, 180_000)

  test("a command the risk check rates high is refused", async () => {
    fs.writeFileSync(path.join(repo, "frobnicate"), "#!/bin/sh\ntouch ran.txt\n", { mode: 0o755 })
    const result = await run([{ name: "bash", arguments: { command: "./frobnicate --all", description: "Run it" } }], ["--auto"], {
      risk: '{"risk":"high","reason":"unknown script"}',
    })
    expect(fs.existsSync(path.join(repo, "ran.txt"))).toBe(false)
    expect(result.all).toContain("risk check: unknown script")
    const checks = gateway.requests.filter((item) => item.max_tokens === 100)
    expect(checks.length).toBe(1)
    expect(checks[0].model).toBe("rafiki-fast")
  }, 180_000)

  test("low lets it run", async () => {
    fs.writeFileSync(path.join(repo, "frobnicate"), "#!/bin/sh\ntouch ran.txt\n", { mode: 0o755 })
    await run([{ name: "bash", arguments: { command: "./frobnicate --all", description: "Run it" } }], ["--auto"])
    expect(fs.existsSync(path.join(repo, "ran.txt"))).toBe(true)
  }, 180_000)

  test("plan mode refuses the edit and tells the model to propose", async () => {
    await run(work.slice(0, 1), [], { extra: { [PermissionMode.ENV]: "plan" } })
    expect(fs.existsSync(path.join(repo, "sum.test.ts"))).toBe(false)
    expect(results.join("\n")).toContain("Plan mode is on")
    expect(results.join("\n")).toContain("Describe the change you propose")
  }, 180_000)
})
