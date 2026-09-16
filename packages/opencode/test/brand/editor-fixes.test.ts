// Editor and server fixes (2026-09-16 editor checks):
// - rafikicode acp labels its model calls X-Rafiki-Surface: ide (contract,
//   Gateway usage), every other command stays cli;
// - model calls send the user agent rafikicode/<version>;
// - RAFIKICODE_SERVER_PASSWORD and RAFIKICODE_SERVER_USERNAME are the
//   documented server names, the OPENCODE_ ones still work;
// - the upstream customize-opencode skill is not offered;
// - rafikicode acp protects its own local server with a random password when
//   none is set, so other programs on the machine cannot use it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { ConfigProvider, Effect, Option } from "effect"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Serve from "@opencode-ai/core/brand/serve"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ServerAuth } from "../../src/server/auth"
import * as RafikiACP from "../../src/rafiki/acp"
import { markHeadless } from "../../src/rafiki/cmd"
import { createMockGateway } from "./mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const stubKey = "sk-stub-editor-fixes-0001"
const serverNames = ["RAFIKICODE_SERVER_PASSWORD", "RAFIKICODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"]

type Env = Record<string, string | undefined>

let saved: Env = {}
beforeEach(() => {
  saved = Object.fromEntries(serverNames.map((name) => [name, process.env[name]]))
  for (const name of serverNames) delete process.env[name]
})
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  Brand.markCommand(undefined)
})

describe("surface label", () => {
  test("the contract values, cli by default and ide for rafikicode acp", () => {
    expect(Brand.surfaces).toEqual(["cli", "ide", "builder", "server"])
    expect(Brand.surface()).toBe("cli")
    // markHeadless is the hook src/index.ts runs before every command.
    for (const command of ["serve", "web", "attach", undefined, 3]) {
      markHeadless(command)
      expect(Brand.surface()).toBe("cli")
    }
    Brand.markCommand("run")
    expect(Brand.surface()).toBe("cli")
    markHeadless("acp")
    expect(Brand.surface()).toBe("ide")
    expect((Brand.provider.config() as any).rafiki.options.headers).toEqual({ "X-Rafiki-Surface": "ide" })
    Brand.markCommand("run")
    expect((Brand.provider.config() as any).rafiki.options.headers).toEqual({ "X-Rafiki-Surface": "cli" })
  })

  test("the model call user agent names rafikicode", () => {
    expect(Brand.userAgent()).toBe(`rafikicode/${InstallationVersion}`)
  })
})

describe("server password names", () => {
  test("RAFIKICODE_ names first, OPENCODE_ names as the fallback", () => {
    expect(Brand.server.env).toEqual({ password: "RAFIKICODE_SERVER_PASSWORD", username: "RAFIKICODE_SERVER_USERNAME" })
    expect(Brand.server.password({})).toBeUndefined()
    expect(Brand.server.password({ OPENCODE_SERVER_PASSWORD: "old-password" })).toBe("old-password")
    expect(Brand.server.password({ OPENCODE_SERVER_PASSWORD: "old-password", RAFIKICODE_SERVER_PASSWORD: "new-password" })).toBe("new-password")
    expect(Brand.server.username({ OPENCODE_SERVER_USERNAME: "old-user" })).toBe("old-user")
    expect(Brand.server.username({ OPENCODE_SERVER_USERNAME: "old-user", RAFIKICODE_SERVER_USERNAME: "new-user" })).toBe("new-user")
    expect(Serve.username({})).toBe("rafikicode")
    expect(Serve.passwordEnv).toBe("RAFIKICODE_SERVER_PASSWORD")
  })

  test("the warning names RAFIKICODE_SERVER_PASSWORD and the user name, not the upstream variable", () => {
    const warn = Serve.check({ hostname: "127.0.0.1" }).warn!
    expect(warn).toBe(
      "Warning: RAFIKICODE_SERVER_PASSWORD is not set, so the server on 127.0.0.1 has no password. Any program or user on this machine can use it to run commands as you and read your files, including the Rafiki Code key. Set RAFIKICODE_SERVER_PASSWORD (user name rafikicode) to require a password.",
    )
    expect(warn).not.toContain("OPENCODE")
    expect(Serve.check({ hostname: "0.0.0.0" }).refuse).toContain("Set RAFIKICODE_SERVER_PASSWORD")
    process.env.OPENCODE_SERVER_PASSWORD = "legacy-password"
    const lines: string[] = []
    expect(Serve.refused({ hostname: "0.0.0.0" }, (line) => lines.push(line))).toBe(false)
    expect(lines).toEqual([])
  })

  test("the server reads either name, the new one first", async () => {
    const read = (env: Record<string, string>) =>
      Effect.runPromise(ServerAuth.Config.pipe(Effect.provide(ServerAuth.Config.layer), Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))))
    expect(await read({})).toEqual({ password: Option.none(), username: "rafikicode" })
    expect(await read({ OPENCODE_SERVER_PASSWORD: "old-password", OPENCODE_SERVER_USERNAME: "old-user" })).toEqual({
      password: Option.some("old-password"),
      username: "old-user",
    })
    expect(
      await read({ OPENCODE_SERVER_PASSWORD: "old-password", RAFIKICODE_SERVER_PASSWORD: "new-password", RAFIKICODE_SERVER_USERNAME: "new-user" }),
    ).toEqual({ password: Option.some("new-password"), username: "new-user" })
  })
})

describe("rafikicode acp server password", () => {
  test("a random password when none is set, taken out of the environment after listen", () => {
    const env: Env = {}
    const a = RafikiACP.serverSecret({ hostname: "127.0.0.1" }, env)!
    expect(a.generated).toBe(true)
    expect(a.password.length).toBeGreaterThanOrEqual(40)
    expect(env.RAFIKICODE_SERVER_PASSWORD).toBe(a.password)
    const b = RafikiACP.serverSecret({ hostname: "127.0.0.1" }, {})!
    expect(b.password).not.toBe(a.password)
    RafikiACP.forget(a, env)
    expect(env.RAFIKICODE_SERVER_PASSWORD).toBeUndefined()
  })

  test("a password the person set is kept and stays in the environment", () => {
    const env: Env = { OPENCODE_SERVER_PASSWORD: "chosen-password" }
    const secret = RafikiACP.serverSecret({ hostname: "127.0.0.1" }, env)!
    expect(secret).toEqual({ password: "chosen-password", generated: false })
    RafikiACP.forget(secret, env)
    expect(env).toEqual({ OPENCODE_SERVER_PASSWORD: "chosen-password" })
  })

  test("another address without a chosen password is still refused", () => {
    const saved = process.exitCode
    try {
      const env: Env = {}
      expect(RafikiACP.serverSecret({ hostname: "0.0.0.0" }, env)).toBeUndefined()
      expect(env).toEqual({})
      expect(process.exitCode).toBe(2)
    } finally {
      process.exitCode = saved ?? 0
    }
  })
})

// A port in the project range that nothing listens on right now.
async function freePort() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const port = 4140 + Math.floor(Math.random() * 60)
    const free = await new Promise<boolean>((resolve) => {
      const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } })
      server.stop(true)
      resolve(true)
    }).catch(() => false)
    if (free) return port
  }
  throw new Error("no free port in 4140 to 4199")
}

async function acpSession(extra: Env, args: string[] = []) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rafikicode-editor-"))
  await fs.mkdir(path.join(home, ".rafikicode"), { recursive: true })
  await fs.writeFile(path.join(home, ".rafikicode", "secret-probe"), "secret-probe-editor-fixes")
  const env: Env = {
    ...process.env,
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    [Brand.env.apiKey]: stubKey,
  }
  for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", Brand.providers.testEnv, ...serverNames])
    delete env[name]
  Object.assign(env, extra)
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "acp", ...args], {
    cwd: home,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  })
  const stderr = new Response(proc.stderr).text()
  const pending = new Map<number, (message: any) => void>()
  const notifications: any[] = []
  let buffer = ""
  const decoder = new TextDecoder()
  const reading = (async () => {
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let index
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (typeof message.id === "number" && pending.has(message.id)) {
          pending.get(message.id)!(message)
          pending.delete(message.id)
        } else if (message.method) notifications.push(message)
      }
    }
  })()
  let next = 0
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      const id = ++next
      pending.set(id, resolve)
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
      proc.stdin!.flush()
    })
  const close = async () => {
    proc.kill()
    await proc.exited
    await reading.catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
    return stderr
  }
  return { request, close, home, notifications, proc }
}

describe("rafikicode acp end to end", () => {
  let gateway: ReturnType<typeof createMockGateway>
  beforeEach(async () => {
    gateway = createMockGateway({ quiet: true, reply: "editor-fixes-ok" })
    await gateway.ready
  })
  afterEach(async () => {
    await gateway.close()
  })

  test("model calls carry surface ide and the rafikicode user agent; no customize-opencode command; no password warning", async () => {
    const acp = await acpSession({ RAFIKICODE_GATEWAY_URL: gateway.url + "/v1" })
    let stderr = ""
    try {
      await acp.request("initialize", { protocolVersion: 1 })
      const created = await acp.request("session/new", { cwd: acp.home, mcpServers: [] })
      expect(created.error).toBeUndefined()
      const prompt = await acp.request("session/prompt", {
        sessionId: created.result.sessionId,
        prompt: [{ type: "text", text: "Reply with the word ok." }],
      })
      expect(prompt.result.stopReason).toBe("end_turn")
      const chats = gateway.requests.filter((r: any) => r.path === "/v1/chat/completions")
      expect(chats.length).toBeGreaterThan(0)
      for (const chat of chats) {
        expect(chat.surface).toBe("ide")
        expect(chat.ua).toStartWith(`rafikicode/${InstallationVersion}`)
        expect(chat.ua).not.toContain("opencode")
      }
      const commands = acp.notifications
        .filter((n) => n.method === "session/update" && n.params?.update?.sessionUpdate === "available_commands_update")
        .flatMap((n) => n.params.update.availableCommands.map((c: any) => c.name))
      expect(commands).not.toContain("customize-opencode")
    } finally {
      stderr = await acp.close()
    }
    expect(stderr).not.toContain("SERVER_PASSWORD")
    expect(stderr).not.toContain("has no password")
  }, 120_000)

  test("rafikicode run labels its calls cli", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "rafikicode-editor-run-"))
    try {
      const env: Env = {
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
        RAFIKICODE_GATEWAY_URL: gateway.url + "/v1",
        [Brand.env.apiKey]: stubKey,
      }
      for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", Brand.providers.testEnv]) delete env[name]
      const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", "--model", "rafiki/rafiki-fast", "say ok"], {
        cwd: home,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: env as Record<string, string>,
      })
      const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      expect(await proc.exited).toBe(0)
      expect(stdout).toContain("editor-fixes-ok")
      const chats = gateway.requests.filter((r: any) => r.path === "/v1/chat/completions")
      expect(chats.length).toBeGreaterThan(0)
      for (const chat of chats) {
        expect(chat.surface).toBe("cli")
        expect(chat.ua).toStartWith(`rafikicode/${InstallationVersion}`)
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  }, 120_000)

  test("another program on the machine cannot use the acp server: no files, no terminal", async () => {
    const port = await freePort()
    const acp = await acpSession({ RAFIKICODE_GATEWAY_URL: gateway.url + "/v1" }, ["--port", String(port)])
    try {
      await acp.request("initialize", { protocolVersion: 1 })
      const created = await acp.request("session/new", { cwd: acp.home, mcpServers: [] })
      expect(created.error).toBeUndefined()
      const base = `http://127.0.0.1:${port}`
      const file = await fetch(`${base}/file/content?path=${encodeURIComponent(".rafikicode/secret-probe")}`, {
        headers: { "x-opencode-directory": acp.home },
      })
      expect(file.status).toBe(401)
      expect(await file.text()).not.toContain("secret-probe-editor-fixes")
      const pty = await fetch(`${base}/pty`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": acp.home },
        body: JSON.stringify({ command: "/bin/sh", args: ["-c", "true"] }),
      })
      expect(pty.status).toBe(401)
      for (const user of ["rafikicode", "opencode"]) {
        const guessed = await fetch(`${base}/path`, { headers: { authorization: `Basic ${Buffer.from(`${user}:`).toString("base64")}` } })
        expect(guessed.status).toBe(401)
      }
    } finally {
      await acp.close()
    }
  }, 120_000)
})
