// Project memory in sessions (src/rafiki/memory.ts, src/tool/memory.ts), end
// to end with `rafikicode run` against the mock gateway: a first session
// records a decision with memory_update, and a second session starts with it
// in its stable system text. Within one session the memory is read once, so
// both requests of a task send the same system text even after a write.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as CachePrefix from "../../src/rafiki/cache-prefix"
import * as RafikiMemory from "../../src/rafiki/memory"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const KEY = "sk-memory-stub"
const DECISION = "Use SQLite for storage, because the app runs on one machine."

type Body = { raw: Buffer; json: any; session?: string }

function systemText(body: Body): string {
  return body.json.messages
    .filter((message: any) => message.role === "system")
    .map((message: any) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n")
}

function toolNames(body: Body): string[] {
  return (body.json.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name)
}

describe("unit", () => {
  test("the memory goes last in the stable system text, before the date", () => {
    const parts = CachePrefix.order({ environment: ["env"], instructions: ["agents"], skills: "skills", memory: "memory" }, new Date(0))
    expect(parts.slice(0, -1)).toEqual(["agents", "skills", "env", "memory"])
    expect(CachePrefix.isVolatile(parts.at(-1))).toBe(true)
    expect(CachePrefix.order({ environment: ["env"], instructions: [] }, new Date(0)).length).toBe(2)
  })

  test("a session reads the files once, until it is refreshed", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-memory-unit-")))
    try {
      const first = RafikiMemory.forSession({ sessionID: "ses_one", directory: dir, worktree: "/", settings: undefined, env: {} })
      expect(first).toContain("The memory is empty so far.")
      RafikiMemory.Memory.update(dir, { section: "notes", operation: "append", text: "Use pnpm." })
      expect(RafikiMemory.forSession({ sessionID: "ses_one", directory: dir, worktree: "/", settings: undefined, env: {} })).toBe(first)
      expect(RafikiMemory.forSession({ sessionID: "ses_two", directory: dir, worktree: "/", settings: undefined, env: {} })).toContain("- Use pnpm.")
      RafikiMemory.refresh("ses_one")
      expect(RafikiMemory.forSession({ sessionID: "ses_one", directory: dir, worktree: "/", settings: undefined, env: {} })).toContain("- Use pnpm.")
      expect(RafikiMemory.forSession({ sessionID: "ses_three", directory: dir, worktree: "/", settings: { enabled: false }, env: {} })).toBe("")
      expect(RafikiMemory.forSession({ sessionID: "ses_four", directory: dir, worktree: "/", settings: undefined, env: { [Brand.env.memory]: "0" } })).toBe("")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("file tools refuse the memory folder", () => {
    expect(RafikiMemory.isMemoryPath("/work/app/.rafiki/memory/notes.md")).toBe(true)
    expect(RafikiMemory.isMemoryPath("/work/app/.rafiki/memory")).toBe(true)
    expect(RafikiMemory.isMemoryPath("/work/app/.rafiki/plans/a.md")).toBe(false)
    expect(RafikiMemory.isMemoryPath("/work/app/memory/notes.md")).toBe(false)
    expect(() => RafikiMemory.refuseEdit("/work/app/.rafiki/memory/notes.md")).toThrow("memory_update")
    expect(() => RafikiMemory.refuseEdit("/work/app/src/a.ts")).not.toThrow()
  })
})

describe("two sessions against the mock gateway", () => {
  let home: string
  let repo: string
  let gateway: ReturnType<typeof createMockGateway> | undefined

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-memory-")))
    repo = path.join(home, "repo")
    fs.mkdirSync(repo)
    spawnSync("git", ["init", "-q"], { cwd: repo })
  })

  afterEach(async () => {
    await gateway?.close()
    gateway = undefined
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function run(toolCall: { name: string; arguments: Record<string, unknown> } | undefined, extra: Record<string, string | undefined> = {}) {
    await gateway?.close()
    gateway = createMockGateway({ quiet: true, bodies: true, ...(toolCall ? { toolCall } : {}) })
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
    for (const k of ["CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION", Brand.env.headless, Brand.env.trustWorkspace, Brand.env.memory]) delete env[k]
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", "--model", "rafiki/rafiki-fast", "Settle the storage question."], {
      cwd: repo,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    const task = (gateway.bodies as Body[]).filter((body) => Array.isArray(body.json.tools) && body.json.tools.length > 0)
    return { exitCode, all: stdout + stderr, task }
  }

  const decisions = () => path.join(repo, ".rafiki", "memory", "decisions.md")

  test("the second session starts with the decision the first one recorded", async () => {
    const first = await run({ name: "memory_update", arguments: { section: "decisions", operation: "append", text: DECISION } })
    expect(first.exitCode).toBe(0)
    expect(fs.readFileSync(decisions(), "utf8")).toMatch(new RegExp(`^# Decisions\\n\\n- \\d{4}-\\d{2}-\\d{2}: ${DECISION.replace(/[.,]/g, "\\$&")}\\n$`))
    expect(first.task.length).toBe(2)
    expect(toolNames(first.task[0])).toContain("memory_update")
    // Read once per session: the request after the write still sends the text of the first.
    expect(systemText(first.task[0])).toContain("The memory is empty so far.")
    expect(systemText(first.task[1])).toBe(systemText(first.task[0]))
    expect(systemText(first.task[0])).not.toContain(DECISION)

    const second = await run(undefined)
    expect(second.exitCode).toBe(0)
    expect(second.task.length).toBe(1)
    const stable = second.task[0].json.messages[0]
    expect(stable.role).toBe("system")
    const text = typeof stable.content === "string" ? stable.content : JSON.stringify(stable.content)
    expect(text).toContain("<project-memory>")
    expect(text).toContain("--- .rafiki/memory/decisions.md")
    expect(text).toContain(DECISION)
    expect(text).toContain("do not commit .rafiki/memory/ yourself")
    // The memory is in the stable message, not in the date line after it.
    expect(systemText(second.task[0]).indexOf(DECISION)).toBeLessThan(systemText(second.task[0]).indexOf("Today's date: "))
  }, 240_000)

  test("a secret is refused and nothing is written", async () => {
    const result = await run({
      name: "memory_update",
      arguments: { section: "notes", operation: "append", text: "The key is sk-live-abcdefghijklmnopqrstuvwxyz0123" }, // secret-scan: allow
    })
    expect(fs.existsSync(path.join(repo, ".rafiki"))).toBe(false)
    expect(result.all).not.toContain("abcdefghijklmnopqrstuvwxyz0123\n- ")
  }, 180_000)

  test("the write tool cannot change the memory", async () => {
    await run({ name: "write", arguments: { filePath: path.join(repo, ".rafiki", "memory", "notes.md"), content: "# Notes\n\n- free write\n" } })
    expect(fs.existsSync(path.join(repo, ".rafiki", "memory", "notes.md"))).toBe(false)
  }, 180_000)

  test("RAFIKICODE_MEMORY=0: no memory text and no memory tool", async () => {
    fs.mkdirSync(path.join(repo, ".rafiki", "memory"), { recursive: true })
    fs.writeFileSync(path.join(repo, ".rafiki", "memory", "notes.md"), "# Notes\n\n- remembered note\n")
    const off = await run(undefined, { [Brand.env.memory]: "0" })
    expect(off.exitCode).toBe(0)
    expect(systemText(off.task[0])).not.toContain("project memory")
    expect(systemText(off.task[0])).not.toContain("remembered note")
    expect(toolNames(off.task[0])).not.toContain("memory_update")
    const on = await run(undefined)
    expect(systemText(on.task[0])).toContain("remembered note")
  }, 240_000)

  test('"memory": { "enabled": false } in the config turns it off', async () => {
    const off = await run(undefined, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ memory: { enabled: false } }) })
    expect(off.exitCode).toBe(0)
    expect(toolNames(off.task[0])).not.toContain("memory_update")
    expect(systemText(off.task[0])).not.toContain("project memory")
  }, 180_000)
})
