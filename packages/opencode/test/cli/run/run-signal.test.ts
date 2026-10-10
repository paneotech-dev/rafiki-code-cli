// rafikicode run stopped by a time limit or Ctrl-c mid-turn: the session is
// written before the process exits, with its own exit code, so a transcript
// can still be exported (rafiki/run-signal.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Meter from "@opencode-ai/core/brand/meter"
import * as RunSignal from "../../../src/rafiki/run-signal"
import { createMockGateway } from "../../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../../..")

describe("the Task: line of a run that ended early", () => {
  test("is marked partial with the reason", () => {
    const state = Meter.update(Meter.empty(), { at: 1 })
    const input = { path: "tier pro", requests: 3, sent: 1000, received: 200, state }
    expect(Meter.runLine(input)).toStartWith("Task: tier pro · 3 requests")
    expect(Meter.runLine({ ...input, partial: "stopped by SIGTERM" })).toStartWith("Task (partial, stopped by SIGTERM): tier pro · 3 requests")
  })
})

describe("the stop handler", () => {
  test("stops the turn, says where the session is, and exits 143 on SIGTERM; a second signal exits at once", async () => {
    const lines: string[] = []
    const codes: number[] = []
    let release!: () => void
    const stopped = new Promise<void>((resolve) => (release = resolve))
    const remove = RunSignal.install({
      sessionID: "ses_test",
      stop: () => stopped,
      after: async (signal) => void lines.push(`after ${signal}`),
      write: (text) => lines.push(text),
      exit: (code) => codes.push(code),
    })
    try {
      process.emit("SIGTERM")
      expect(codes).toEqual([])
      process.emit("SIGINT")
      expect(codes).toEqual([130])
      release()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(codes).toEqual([130, 143])
      expect(lines).toEqual(["after SIGTERM", `Stopped by SIGTERM. The session is saved: ${Brand.name} export ses_test`])
    } finally {
      remove()
    }
  })

  test("a stop that hangs still exits after the grace period", async () => {
    const codes: number[] = []
    const remove = RunSignal.install({
      sessionID: "ses_test",
      stop: () => new Promise(() => {}),
      write: () => {},
      exit: (code) => codes.push(code),
      graceMs: 20,
    })
    try {
      process.emit("SIGINT")
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(codes).toEqual([130])
    } finally {
      remove()
    }
  })
})

describe("rafikicode run receiving SIGTERM mid-turn against the mock gateway", () => {
  let home: string
  let repo: string
  let gateway: ReturnType<typeof createMockGateway>

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-signal-"))
    repo = path.join(home, "repo")
    fs.mkdirSync(repo)
    // The model asks for a command that outlives the time limit.
    gateway = createMockGateway({
      quiet: true,
      toolCall: { name: "bash", arguments: { command: "sleep 60", description: "Wait a long time" } },
    })
    await gateway.ready
    // The key is known to the gateway, so its spend can be read for the Task: line.
    await fetch(gateway.url + "/__test/register", {
      method: "POST",
      body: JSON.stringify({ key: "sk-signal-stub", key_alias: "signal" }),
    })
  })

  afterEach(async () => {
    await gateway.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  function env() {
    const value: Record<string, string | undefined> = {
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
      RAFIKICODE_API_KEY: "sk-signal-stub",
    }
    // The test preload turns experimental systems on and keeps the database in memory; a person's run has neither.
    for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_EXPERIMENTAL_EVENT_SYSTEM", "OPENCODE_EXPERIMENTAL_WORKSPACES", "OPENCODE_DB"])
      delete value[name]
    return value as Record<string, string>
  }

  const cli = (...args: string[]) => [process.execPath, "run", path.join(root, "src/index.ts"), ...args]

  test("the run exits 143, prints the export line, and the exported session holds the stopped turn", async () => {
    const proc = Bun.spawn(cli("run", "--auto", "--title", "signal check", "wait for it"), {
      cwd: repo,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env(),
    })
    const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    // Mid-turn: the model has asked for the command and the command is running.
    const deadline = Date.now() + 60_000
    while (!gateway.requests.some((r: any) => r.path === "/v1/chat/completions" && r.tools > 0)) {
      if (Date.now() > deadline) throw new Error("the run never reached the gateway")
      await Bun.sleep(100)
    }
    await Bun.sleep(2_000)
    const sent = Date.now()
    proc.kill("SIGTERM")
    const exitCode = await proc.exited
    const [stdout, stderr] = await output
    expect(exitCode).toBe(RunSignal.EXIT_CODES.SIGTERM)
    expect(Date.now() - sent).toBeLessThan(RunSignal.GRACE_MS + 3_000)
    const match = /Stopped by SIGTERM\. The session is saved: \S+ export (\S+)/.exec(stdout + stderr)
    expect(match).not.toBeNull()
    // The cost line is still printed, from the key's spend, and marked partial.
    expect(stdout + stderr).toMatch(/Task \(partial, stopped by SIGTERM\): tier fast · \d+ requests?, .* 0\.0010 USD spent on this key during the task/)
    expect(gateway.requests.filter((r: any) => r.path === "/key/info").length).toBeGreaterThanOrEqual(2)

    const exported = Bun.spawnSync(cli("export", match![1]), { cwd: repo, env: env(), stdout: "pipe", stderr: "pipe" })
    expect(exported.exitCode).toBe(0)
    const text = exported.stdout.toString()
    const data = JSON.parse(text.slice(text.indexOf("{")))
    expect(data.info.id).toBe(match![1])
    const assistant = data.messages.filter((m: any) => m.info.role === "assistant").at(-1)
    expect(assistant.info.time.completed).toBeGreaterThan(0)
    const bash = assistant.parts.find((p: any) => p.type === "tool" && p.tool === "bash")
    expect(bash).toBeDefined()
    expect(["error", "completed"]).toContain(bash.state.status)
  }, 120_000)
})
