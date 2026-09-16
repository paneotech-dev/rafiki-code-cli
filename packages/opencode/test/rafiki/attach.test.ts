// rafikicode run --attach <url> (D42): the answer is printed (and the JSON
// output carries text events) before the run exits, and a server that wants a
// password says so instead of "Session not found".
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Attach from "../../src/rafiki/attach"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const KEY = "sk-attach-stub-0001"
const PASSWORD = "attach-test-password"
const serverNames = ["RAFIKICODE_SERVER_PASSWORD", "RAFIKICODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"]

describe("preflight", () => {
  const url = "http://127.0.0.1:4101/"
  const answer = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch

  test("a reachable server without a password needs nothing", async () => {
    let asked = ""
    const fetcher = (async (input: string) => {
      asked = input
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    expect(await Attach.check(url, undefined, fetcher)).toEqual({ ok: true })
    expect(asked).toBe("http://127.0.0.1:4101/path")
  })

  test("401 without a password asks for one, exit 2", async () => {
    const result = await Attach.check(url, undefined, answer(401))
    expect(result).toEqual({
      ok: false,
      exitCode: 2,
      message:
        "The rafikicode server at http://127.0.0.1:4101/ needs a password. Pass --password, or set RAFIKICODE_SERVER_PASSWORD to the password the server was started with.",
    })
  })

  test("401 with a password says it was refused and names the user, exit 2", async () => {
    const result = await Attach.check(url, { Authorization: "Basic eA==" }, answer(401))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.exitCode).toBe(2)
    expect(result.message).toBe(
      "The rafikicode server at http://127.0.0.1:4101/ refused the password. Check --password or RAFIKICODE_SERVER_PASSWORD (the user name is rafikicode, or --username).",
    )
  })

  test("nothing answering is a network problem, exit 4", async () => {
    const fetcher = (async () => {
      throw new Error("connection refused")
    }) as unknown as typeof fetch
    const result = await Attach.check(url, undefined, fetcher)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.exitCode).toBe(4)
  })
})

describe("whenConnected", () => {
  test("resolves on the first event and passes every event through", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    async function* source() {
      yield "server.connected"
      await gate
      yield "message.updated"
    }
    const events = { stream: source() }
    const connected = Attach.whenConnected(events)
    const seen: string[] = []
    const reading = (async () => {
      for await (const event of events.stream) seen.push(event)
    })()
    await connected
    expect(seen).toEqual(["server.connected"])
    release()
    await reading
    expect(seen).toEqual(["server.connected", "message.updated"])
  })

  test("resolves when the stream ends or times out without events", async () => {
    async function* empty() {}
    const ended = { stream: empty() }
    const done = Attach.whenConnected(ended)
    for await (const _ of ended.stream) {
    }
    await done
    async function* silent() {
      await new Promise(() => {})
    }
    const quiet = { stream: silent() as AsyncGenerator<string> }
    const started = Date.now()
    await Attach.whenConnected(quiet, 50)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

// A port in the project range that nothing listens on right now.
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

describe("run --attach against rafikicode serve", () => {
  let home: string
  let gateway: ReturnType<typeof createMockGateway>

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-attach-"))
    gateway = createMockGateway({ quiet: true, reply: "attached-answer" })
    await gateway.ready
  })

  afterAll(async () => {
    await gateway.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  function env(extra: Record<string, string | undefined> = {}) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      COLUMNS: "120",
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
      RAFIKICODE_GATEWAY_URL: gateway.url + "/v1",
      [Brand.env.apiKey]: KEY,
    }
    for (const k of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", Brand.providers.testEnv, ...serverNames]) delete env[k]
    Object.assign(env, extra)
    return env as Record<string, string>
  }

  async function serve(extra: Record<string, string | undefined>) {
    const port = freePort()
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "serve", "--port", String(port)], {
      cwd: home,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env(extra),
    })
    const reader = proc.stdout.getReader()
    let text = ""
    const deadline = Date.now() + 60_000
    while (!text.includes("listening on") && Date.now() < deadline) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += new TextDecoder().decode(chunk.value)
    }
    reader.releaseLock()
    expect(text).toContain(`listening on http://127.0.0.1:${port}`)
    return {
      url: `http://127.0.0.1:${port}`,
      stop: async () => {
        proc.kill()
        await proc.exited
      },
    }
  }

  async function run(args: string[], extra: Record<string, string | undefined> = {}) {
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", "--model", "rafiki/rafiki-fast", ...args], {
      cwd: home,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env(extra),
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { exitCode: await proc.exited, stdout, stderr }
  }

  test("a server without a password: the answer is printed, JSON has a text event", async () => {
    const server = await serve({})
    try {
      const plain = await run(["--attach", server.url, "say it"])
      expect(plain.exitCode).toBe(0)
      expect(plain.stdout).toContain("attached-answer")

      const json = await run(["--attach", server.url, "--format", "json", "say it"])
      expect(json.exitCode).toBe(0)
      const events = json.stdout.trim().split("\n").map((line) => JSON.parse(line))
      const texts = events.filter((event) => event.type === "text").map((event) => event.part.text)
      expect(texts).toContain("attached-answer")
      expect(json.stdout + json.stderr).not.toContain(KEY)
    } finally {
      await server.stop()
    }
  }, 180_000)

  test("a server with a password: missing and wrong passwords exit 2 with a clear message, the right one answers", async () => {
    const server = await serve({ RAFIKICODE_SERVER_PASSWORD: PASSWORD })
    try {
      const missing = await run(["--attach", server.url, "say it"])
      expect(missing.exitCode).toBe(2)
      expect(missing.stderr).toContain(`The rafikicode server at ${server.url} needs a password.`)
      expect(missing.stderr).not.toContain("Session not found")

      const wrong = await run(["--attach", server.url, "--password", "not-the-password", "say it"])
      expect(wrong.exitCode).toBe(2)
      expect(wrong.stderr).toContain("refused the password")
      expect(wrong.stderr).not.toContain("not-the-password")

      const right = await run(["--attach", server.url, "--password", PASSWORD, "say it"])
      expect(right.exitCode).toBe(0)
      expect(right.stdout).toContain("attached-answer")

      const fromEnv = await run(["--attach", server.url, "say it"], { RAFIKICODE_SERVER_PASSWORD: PASSWORD })
      expect(fromEnv.exitCode).toBe(0)
      expect(fromEnv.stdout).toContain("attached-answer")

      const legacy = await run(["--attach", server.url, "say it"], { OPENCODE_SERVER_PASSWORD: PASSWORD })
      expect(legacy.exitCode).toBe(0)
      expect(legacy.stdout).toContain("attached-answer")

      for (const [user, status] of [
        ["rafikicode", 200],
        ["opencode", 401],
      ] as const) {
        const response = await fetch(`${server.url}/path`, { headers: { authorization: `Basic ${Buffer.from(`${user}:${PASSWORD}`).toString("base64")}` } })
        expect(response.status).toBe(status)
      }
    } finally {
      await server.stop()
    }
  }, 240_000)

  test("nothing listening: exit 4 with a clear message", async () => {
    const result = await run(["--attach", `http://127.0.0.1:${freePort()}`, "say it"])
    expect(result.exitCode).toBe(4)
    expect(result.stderr).toContain("Cannot reach a rafikicode server at")
  }, 60_000)
})
