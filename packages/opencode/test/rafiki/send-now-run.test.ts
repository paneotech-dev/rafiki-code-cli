// Send now against the mock gateway, through a real server (rafikicode
// serve): a long turn runs, a message is queued with the "send now" mark
// (core/brand/steer.ts), and the turn takes it at its next safe point
// (rafiki/steer.ts). A running command is never cut; a long answer being
// written is, and what it wrote is kept.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Steer from "@opencode-ai/core/brand/steer"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const KEY = "sk-send-now-stub-0001"
const PASSWORD = "send-now-test-password"
const LONG = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ")

type Body = { messages?: { role: string; content?: unknown }[]; tools?: unknown[] }
const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((item) => (typeof item?.text === "string" ? item.text : "")).join(" ")
      : ""

function freePort() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const port = 4140 + Math.floor(Math.random() * 60)
    try {
      Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true)
      return port
    } catch {}
  }
  throw new Error("no free port in 4140 to 4199")
}

async function until<T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== undefined && value !== false) return value as T
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe("send now against the mock gateway", () => {
  let home: string
  let gateway: ReturnType<typeof createMockGateway>
  // The chat requests of the turns, in order: the last user text and the tool results seen.
  const seen: { at: number; last: string; tools: number; users: string[] }[] = []
  let server: { url: string; stop: () => Promise<void> }

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-send-now-"))
    gateway = createMockGateway({
      quiet: true,
      respond(body: Body) {
        // Title and summary requests carry no tools.
        if (!body.tools?.length) return { content: "Send now" }
        const messages = body.messages ?? []
        const users = messages.filter((item) => item.role === "user").map((item) => text(item.content))
        const tools = messages.filter((item) => item.role === "tool").length
        seen.push({ at: Date.now(), last: users.at(-1) ?? "", tools, users })
        const last = users.at(-1) ?? ""
        if (last.includes("now please")) return { content: "answered the queued message" }
        if (last.includes("run the build")) {
          if (tools === 0) return { toolCall: { name: "bash", arguments: { command: "sleep 3; echo built", description: "Build" } } }
          return { content: LONG, wordDelayMs: 50 }
        }
        if (last.includes("write a long answer")) return { content: LONG, wordDelayMs: 50 }
        return { content: "ok" }
      },
    })
    await gateway.ready
    const port = freePort()
    const env: Record<string, string | undefined> = {
      ...process.env,
      PWD: home,
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      RAFIKICODE_NO_DEFAULT_WORKSPACE: "1",
      RAFIKICODE_GATEWAY_URL: gateway.url + "/v1",
      RAFIKICODE_SERVER_PASSWORD: PASSWORD,
      [Brand.env.apiKey]: KEY,
    }
    for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_SERVER_PASSWORD", Brand.providers.testEnv])
      delete env[name]
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "serve", "--port", String(port)], {
      cwd: home,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    })
    let out = ""
    const decoder = new TextDecoder()
    void (async () => {
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) out += decoder.decode(chunk)
    })()
    void (async () => {
      for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) out += decoder.decode(chunk)
    })()
    await until(() => out.includes("listening on") || proc.exitCode !== null, 60_000, "the server")
    expect(out).toContain(`listening on http://127.0.0.1:${port}`)
    server = {
      url: `http://127.0.0.1:${port}`,
      stop: async () => {
        proc.kill()
        const timer = setTimeout(() => proc.kill(9), 10_000)
        await proc.exited
        clearTimeout(timer)
      },
    }
  }, 90_000)

  afterAll(async () => {
    await server?.stop()
    await gateway?.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function call(method: string, route: string, body?: unknown) {
    const response = await fetch(server.url + route, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`rafikicode:${PASSWORD}`).toString("base64")}`,
        "content-type": "application/json",
        "x-opencode-directory": home,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${raw}`)
    return raw ? JSON.parse(raw) : undefined
  }

  const send = (sessionID: string, value: string, now = false) =>
    call("POST", `/session/${sessionID}/prompt_async`, {
      model: { providerID: Brand.provider.id, modelID: "rafiki-fast" },
      parts: [{ type: "text", text: value, ...(now ? { metadata: Steer.metadata() } : {}) }],
    })

  type Stored = { info: { role: string; time: { completed?: number } }; parts: { type: string; tool?: string; text?: string; state?: { status: string; output?: string; error?: string } }[] }
  const messages = (sessionID: string) => call("GET", `/session/${sessionID}/message`) as Promise<Stored[]>
  const idle = (sessionID: string) =>
    until(
      async () => {
        const status = (await call("GET", "/session/status")) as Record<string, { type: string }>
        return (status[sessionID]?.type ?? "idle") === "idle" ? true : undefined
      },
      60_000,
      "the turn to end",
    )

  test("sent during a command: the command finishes, then the message goes out next", async () => {
    const session = await call("POST", "/session", {})
    const from = seen.length
    await send(session.id, "run the build")
    await until(() => seen.slice(from).find((item) => item.last.includes("run the build")), 30_000, "the first request")
    // The command (3 seconds) is running now.
    await Bun.sleep(800)
    await send(session.id, "now please", true)
    const next = await until(() => seen.slice(from + 1)[0], 30_000, "the next request")
    // The step ended at the command's result; the long answer was never asked for.
    expect(next.last).toContain("now please")
    expect(next.tools).toBe(1)
    await idle(session.id)
    const list = await messages(session.id)
    const bash = list.flatMap((item) => item.parts).find((part) => part.type === "tool" && part.tool === "bash")
    expect(bash?.state?.status).toBe("completed")
    expect(bash?.state?.output).toContain("built")
    expect(list.flatMap((item) => item.parts).some((part) => part.type === "text" && part.text?.includes("answered the queued message"))).toBe(true)
    expect(seen.slice(from).some((item) => item.tools === 1 && item.last.includes("run the build"))).toBe(false)
  }, 90_000)

  test("sent during a long answer: the answer stops, what it wrote is kept, the message goes out next", async () => {
    const session = await call("POST", "/session", {})
    const from = seen.length
    await send(session.id, "write a long answer")
    const first = await until(() => seen.slice(from)[0], 30_000, "the first request")
    // The answer streams for about 20 seconds.
    await Bun.sleep(2_000)
    // Queued without the mark first: it waits.
    await send(session.id, "a plain queued note")
    await Bun.sleep(1_000)
    expect(seen.length).toBe(from + 1)
    await send(session.id, "now please", true)
    const next = await until(() => seen.slice(from + 1)[0], 15_000, "the next request")
    expect(next.at - first.at).toBeLessThan(10_000)
    expect(next.last).toContain("now please")
    expect(next.users.some((item) => item.includes("a plain queued note"))).toBe(true)
    await idle(session.id)
    const list = await messages(session.id)
    const partial = list
      .filter((item) => item.info.role === "assistant")
      .flatMap((item) => item.parts)
      .find((part) => part.type === "text" && part.text?.includes("word0"))
    expect(partial?.text).toBeDefined()
    expect(partial!.text!.includes("word399")).toBe(false)
  }, 90_000)
})
