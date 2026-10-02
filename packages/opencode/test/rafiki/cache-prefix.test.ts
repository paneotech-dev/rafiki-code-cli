// The request prefix a provider can cache (src/rafiki/cache-prefix.ts): two
// consecutive requests of one task start with the same bytes, the cache
// marker sits at the end of that stable part on the tiers that take one, and
// nothing that changes by itself (a date, a time, an id) is inside it.
//
// The end to end tests run `rafikicode run` against the mock gateway, which
// answers the first request with a tool call and the second with text, and
// compare the request bodies as the gateway received them.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import type { ModelMessage } from "ai"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as CachePrefix from "../../src/rafiki/cache-prefix"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const KEY = "sk-cache-prefix-stub"
const MARKER = { type: "ephemeral" }
const INSTRUCTIONS = "Project rule for the cache prefix test: keep functions short."

type Body = { raw: Buffer; json: any; session?: string }

// The bytes of a request body up to the end of its first (stable) system message.
function stablePrefix(body: Body) {
  const first = Buffer.from(JSON.stringify(body.json.messages[0]), "utf8")
  const at = body.raw.indexOf(first)
  expect(at).toBeGreaterThan(0)
  return body.raw.subarray(0, at + first.length)
}

// The bytes from the tool definitions to the end of the body.
function toolsBytes(body: Body) {
  const at = body.raw.indexOf(Buffer.from(',"tools":[', "utf8"))
  expect(at).toBeGreaterThan(0)
  return body.raw.subarray(at)
}

function withoutMarkers(messages: any[]) {
  return messages.map((message) => {
    const { cache_control: _dropped, ...rest } = message
    return rest
  })
}

function markerCount(body: Body) {
  return body.raw.toString("utf8").split('"cache_control"').length - 1
}

// Dates, times and ids in the forms a prompt builder could put them.
function volatileFindings(text: string, session: string | undefined, now: Date) {
  const found: string[] = []
  const candidates = [
    now.toDateString(),
    now.toISOString().slice(0, 10),
    now.toLocaleDateString("en-US"),
    now.toLocaleDateString("en-GB"),
    now.toUTCString().slice(0, 16),
    ...(session ? [session] : []),
  ]
  for (const candidate of candidates) if (text.includes(candidate)) found.push(candidate)
  const patterns: [string, RegExp][] = [
    ["an ISO date", /\b20\d\d-[01]\d-[0-3]\d\b/],
    ["a clock time", /\b[0-2]\d:[0-5]\d:[0-5]\d\b/],
    ["a millisecond timestamp", /\b1[6-9]\d{11}\b/],
    ["a session, message or call id", /\b(?:ses|msg|prt|call|chatcmpl)_[A-Za-z0-9]{8,}/],
    ["a UUID", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ]
  for (const [label, pattern] of patterns) if (pattern.test(text)) found.push(label)
  return found
}

describe("one task against the mock gateway: two consecutive requests", () => {
  let home: string
  let repo: string
  let gateway: ReturnType<typeof createMockGateway>

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-cache-prefix-"))
    repo = path.join(home, "repo")
    fs.mkdirSync(repo)
    spawnSync("git", ["init", "-q"], { cwd: repo })
    fs.writeFileSync(path.join(repo, "AGENTS.md"), `# Project instructions\n\n${INSTRUCTIONS}\n`)
    gateway = createMockGateway({
      quiet: true,
      bodies: true,
      toolCall: { name: "bash", arguments: { command: "echo cached", description: "Print one word" } },
    })
    await gateway.ready
  })

  afterEach(async () => {
    await gateway.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function run(model: string, extra: Record<string, string | undefined> = {}) {
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
    }
    for (const k of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION", Brand.env.headless, Brand.env.trustWorkspace, Brand.env.cacheMarkers]) delete env[k]
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", "--model", `rafiki/${model}`, "Print one word with the shell, then stop."], {
      cwd: repo,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    // The requests of the task itself: the ones that carry the tool definitions (the title request has none).
    const task = (gateway.bodies as Body[]).filter((body) => Array.isArray(body.json.tools) && body.json.tools.length > 0)
    return { exitCode, all: stdout + stderr, task }
  }

  // What holds on every tier: the same bytes first, in the stable order, with nothing volatile inside.
  function expectStablePrefix(task: Body[]) {
    expect(task.length).toBe(2)
    const [first, second] = task
    const prefix = stablePrefix(first)
    // Byte for byte: the body from its first byte to the end of the stable system message.
    expect(Buffer.compare(prefix, stablePrefix(second))).toBe(0)
    expect(Buffer.compare(first.raw.subarray(0, prefix.length), second.raw.subarray(0, prefix.length))).toBe(0)
    expect(prefix.length).toBeGreaterThan(4000)
    // The tool definitions are the same bytes too, in name order.
    expect(Buffer.compare(toolsBytes(first), toolsBytes(second))).toBe(0)
    const names = first.json.tools.map((tool: any) => tool.function.name)
    expect(names).toEqual(names.toSorted((a: string, b: string) => a.localeCompare(b)))

    // The stable system message: the system prompt, then the project instructions, then the repository context.
    const system = first.json.messages[0]
    expect(system.role).toBe("system")
    const instructions = system.content.indexOf(INSTRUCTIONS)
    const houseStyle = system.content.indexOf(Brand.houseStyle)
    const environment = system.content.indexOf("<env>")
    expect(instructions).toBeGreaterThan(1000)
    expect(houseStyle).toBeGreaterThan(instructions)
    expect(environment).toBeGreaterThan(houseStyle)
    expect(system.content).toContain(`Working directory: ${fs.realpathSync(repo)}`)

    // Nothing that changes by itself is inside it.
    const now = new Date()
    expect(volatileFindings(prefix.toString("utf8"), first.session, now)).toEqual([])
    expect(first.session).toMatch(/^ses_/)
    expect(JSON.stringify(first.json.tools)).not.toContain(first.session!)
    expect(volatileFindings(JSON.stringify(first.json.tools), first.session, now).filter((item) => item !== "an ISO date" && item !== "a clock time")).toEqual([])

    // The date follows in a system message of its own, after the stable one.
    for (const body of task) {
      const date = body.json.messages[1]
      expect(date.role).toBe("system")
      expect(date.content).toBe(CachePrefix.volatile(now))
      expect(date.cache_control).toBeUndefined()
      expect(body.json.messages.filter((message: any) => message.role === "system").length).toBe(2)
    }

    // The conversation only grows: the second request repeats the first one's messages and adds to them.
    expect(second.json.messages.length).toBeGreaterThan(first.json.messages.length)
    expect(withoutMarkers(second.json.messages.slice(0, first.json.messages.length))).toEqual(withoutMarkers(first.json.messages))
    expect(second.json.messages.slice(first.json.messages.length).map((message: any) => message.role)).toEqual(["assistant", "tool"])
  }

  test("a marked tier: identical prefix bytes, the marker at the end of the stable system message, the date after it", async () => {
    const result = await run("rafiki-max")
    expect(result.exitCode).toBe(0)
    expectStablePrefix(result.task)
    const [first, second] = result.task
    for (const body of result.task) {
      // The marker closes the stable prefix: it is the last field of the first message and appears nowhere before.
      expect(body.json.messages[0].cache_control).toEqual(MARKER)
      const prefix = stablePrefix(body).toString("utf8")
      expect(prefix.endsWith('"cache_control":{"type":"ephemeral"}}')).toBe(true)
      expect(prefix.split('"cache_control"').length - 1).toBe(1)
      expect(markerCount(body)).toBeLessThanOrEqual(4)
      expect(body.json.tools.some((tool: any) => "cache_control" in tool || "cache_control" in tool.function)).toBe(false)
    }
    // The conversation so far is marked as well, so the next request can reuse it.
    expect(first.json.messages.map((message: any) => (message.cache_control ? message.role : null)).filter(Boolean)).toEqual(["system", "user"])
    expect(second.json.messages.map((message: any) => (message.cache_control ? message.role : null)).filter(Boolean)).toEqual(["system", "assistant", "tool"])
    expect(result.all).not.toContain(KEY)
  }, 180_000)

  test("an unmarked tier: the same stable prefix, and no marker anywhere in the body", async () => {
    const result = await run("rafiki-fast")
    expect(result.exitCode).toBe(0)
    expectStablePrefix(result.task)
    for (const body of result.task) expect(markerCount(body)).toBe(0)
  }, 180_000)

  test(`${Brand.env.cacheMarkers}: off removes the marker from a marked tier, all adds it to every tier`, async () => {
    const off = await run("rafiki-max", { [Brand.env.cacheMarkers]: "off" })
    expect(off.exitCode).toBe(0)
    expect(off.task.length).toBe(2)
    for (const body of off.task) expect(markerCount(body)).toBe(0)
    expect(Buffer.compare(stablePrefix(off.task[0]), stablePrefix(off.task[1]))).toBe(0)

    gateway.bodies.length = 0
    const all = await run("rafiki-fast", { [Brand.env.cacheMarkers]: "all" })
    expect(all.exitCode).toBe(0)
    expect(all.task.length).toBe(2)
    for (const body of all.task) expect(body.json.messages[0].cache_control).toEqual(MARKER)
    expect(Buffer.compare(stablePrefix(all.task[0]), stablePrefix(all.task[1]))).toBe(0)
  }, 300_000)
})

describe("the pieces", () => {
  const max = { providerID: Brand.provider.id, api: { id: "rafiki-max" } }
  const fast = { providerID: Brand.provider.id, api: { id: "rafiki-fast" } }
  const marker = { openaiCompatible: { cache_control: MARKER } }

  test("order: project instructions, MCP instructions and skills, then the repository context", () => {
    expect(CachePrefix.order({ environment: ["env", "references"], instructions: ["agents", "house"], mcp: "mcp", skills: "skills" })).toEqual(["agents", "house", "mcp", "skills", "env", "references"])
    expect(CachePrefix.order({ environment: ["env"], instructions: [], mcp: undefined, skills: undefined })).toEqual(["env"])
  })

  test("volatile: the date only, recognisable, and different on another day", () => {
    const day = new Date(2026, 9, 2, 23, 59, 59)
    expect(CachePrefix.volatile(day)).toBe("Today's date: Fri Oct 02 2026")
    expect(CachePrefix.volatile(new Date(2026, 9, 2, 0, 0, 1))).toBe(CachePrefix.volatile(day))
    expect(CachePrefix.volatile(new Date(2026, 9, 3))).not.toBe(CachePrefix.volatile(day))
    expect(CachePrefix.isVolatile(CachePrefix.volatile(day))).toBe(true)
    expect(CachePrefix.isVolatile("You are a coding agent.")).toBe(false)
    expect(CachePrefix.isVolatile([{ type: "text", text: "Today's date: x" }])).toBe(false)
  })

  test("which tiers are marked: the brand list by default, the environment variable over it", () => {
    expect(Brand.provider.cacheMarkers).toEqual(["rafiki-max"])
    expect(Brand.env.cacheMarkers).toBe("RAFIKICODE_CACHE_MARKERS")
    expect(CachePrefix.markedModels("")).toEqual(["rafiki-max"])
    expect(CachePrefix.markedModels("all")).toBe("all")
    expect(CachePrefix.markedModels(" ALL ")).toBe("all")
    for (const off of ["off", "0", "none"]) expect(CachePrefix.markedModels(off)).toEqual([])
    expect(CachePrefix.markedModels("rafiki-pro, rafiki-max")).toEqual(["rafiki-pro", "rafiki-max"])
    expect(CachePrefix.marks(max, "")).toBe(true)
    expect(CachePrefix.marks(fast, "")).toBe(false)
    expect(CachePrefix.marks(fast, "all")).toBe(true)
    expect(CachePrefix.marks(max, "off")).toBe(false)
    expect(CachePrefix.marks(fast, "rafiki-fast")).toBe(true)
    // Another provider's model of the same name is not the gateway's.
    expect(CachePrefix.marks({ providerID: "other", api: { id: "rafiki-max" } }, "all")).toBe(false)
  })

  test("mark: the stable system message and the last two conversation messages, each where the provider package reads it", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "stable" },
      { role: "system", content: CachePrefix.volatile() },
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "text", value: "ok" } }] },
    ]
    const before = JSON.stringify(msgs)
    const marked = CachePrefix.mark(msgs, max, "") as any[]
    expect(JSON.stringify(msgs)).toBe(before)
    expect(marked[0].providerOptions).toEqual(marker)
    expect(marked[1].providerOptions).toBeUndefined()
    expect(marked[2]).toEqual(msgs[2])
    // An assistant message takes it on the message, a tool message on its result part.
    expect(marked[3].providerOptions).toEqual(marker)
    expect(marked[3].content[0].providerOptions).toBeUndefined()
    expect(marked[4].providerOptions).toBeUndefined()
    expect(marked[4].content[0].providerOptions).toEqual(marker)
  })

  test("mark: a user message of parts takes it on the last part, plain text on the message, and existing options stay", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "stable" },
      { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b", providerOptions: { openaiCompatible: { keep: 1 }, other: { x: 1 } } }] },
      { role: "user", content: "plain", providerOptions: { other: { y: 2 } } },
    ]
    const marked = CachePrefix.mark(msgs, max, "") as any[]
    expect(marked[1].content[0].providerOptions).toBeUndefined()
    expect(marked[1].content[1].providerOptions).toEqual({ openaiCompatible: { keep: 1, cache_control: MARKER }, other: { x: 1 } })
    expect(marked[2].providerOptions).toEqual({ other: { y: 2 }, openaiCompatible: { cache_control: MARKER } })
  })

  test("mark: with several system messages the marker goes on the last stable one; without a date message, on the last", () => {
    const three: ModelMessage[] = [
      { role: "system", content: "header" },
      { role: "system", content: "rest" },
      { role: "system", content: CachePrefix.volatile() },
      { role: "user", content: "go" },
    ]
    const marked = CachePrefix.mark(three, max, "") as any[]
    expect(marked.map((message) => Boolean(message.providerOptions))).toEqual([false, true, false, true])
    const plain = CachePrefix.mark([{ role: "system", content: "only" }, { role: "user", content: "go" }] as ModelMessage[], max, "") as any[]
    expect(plain.map((message) => Boolean(message.providerOptions))).toEqual([true, true])
  })

  test("mark: an unmarked tier and another provider get the messages back untouched", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "stable" },
      { role: "user", content: "go" },
    ]
    expect(CachePrefix.mark(msgs, fast, "")).toBe(msgs)
    expect(CachePrefix.mark(msgs, { providerID: "anthropic", api: { id: "claude-sonnet" } }, "all")).toBe(msgs)
    expect(CachePrefix.mark(msgs, max, "off")).toBe(msgs)
  })
})
