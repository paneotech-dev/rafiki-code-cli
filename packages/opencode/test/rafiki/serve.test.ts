// rafikicode serve, web, acp and the terminal interface server (L-R2-8): the
// server answers with the configuration, which carries the stored key, so an
// address other machines can reach needs OPENCODE_SERVER_PASSWORD, and a
// loopback server without one gets a warning.
//
// RP-3: every listener checks the Host header (DNS rebinding), refuses
// Origins other than its own and the configured ones, and redacts secrets
// from the configuration and provider routes.
import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import net from "net"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Serve from "@opencode-ai/core/brand/serve"

const root = path.resolve(import.meta.dir, "../..")
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-serve-"))

afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

describe("server password rule", () => {
  test("only 127.0.0.0/8, ::1 and localhost count as loopback", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"]) expect(Serve.loopback(host), host).toBe(true)
    for (const host of ["0.0.0.0", "::", "[::]", "", "192.168.1.10", "10.0.0.1", "127.0.0.1.nip.io", "127.0.0.256", "localhost.example.com", "example.com"]) {
      expect(Serve.loopback(host), host).toBe(false)
    }
  })

  test("another address without a password is refused, loopback warns, a password is enough", () => {
    expect(Serve.check({ hostname: "0.0.0.0" }).refuse).toContain("Refusing to listen on 0.0.0.0 without a password")
    expect(Serve.check({ hostname: "192.168.1.10", password: "" }).refuse).toContain("Set OPENCODE_SERVER_PASSWORD")
    expect(Serve.check({ hostname: "" }).refuse).toContain("every address")
    const loop = Serve.check({ hostname: "127.0.0.1" })
    expect(loop.refuse).toBeUndefined()
    expect(loop.warn).toContain("OPENCODE_SERVER_PASSWORD is not set")
    expect(Serve.check({ hostname: "0.0.0.0", password: "stub-password" })).toEqual({})
    expect(Serve.check({ hostname: "127.0.0.1", password: "stub-password" })).toEqual({})
  })

  test("refused() prints the refusal and sets the usage exit code", () => {
    const saved = { code: process.exitCode, password: process.env[Serve.passwordEnv] }
    const lines: string[] = []
    try {
      delete process.env[Serve.passwordEnv]
      expect(Serve.refused({ hostname: "127.0.0.1" }, (l) => lines.push(l))).toBe(false)
      expect(Serve.refused({ hostname: "0.0.0.0" }, (l) => lines.push(l))).toBe(true)
      expect(process.exitCode).toBe(2)
      process.env[Serve.passwordEnv] = "stub-password"
      expect(Serve.refused({ hostname: "0.0.0.0" }, (l) => lines.push(l))).toBe(false)
      expect(lines.length).toBe(2)
    } finally {
      process.exitCode = saved.code ?? 0
      if (saved.password === undefined) delete process.env[Serve.passwordEnv]
      else process.env[Serve.passwordEnv] = saved.password
    }
  })

  for (const args of [["serve", "--hostname", "0.0.0.0"], ["serve", "--mdns"], ["web", "--hostname", "0.0.0.0"], ["acp", "--hostname", "0.0.0.0"]]) {
    test(`rafikicode ${args.join(" ")} without a password exits 2 before listening`, async () => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: home,
        OPENCODE_TEST_HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local/share"),
        XDG_STATE_HOME: path.join(home, ".local/state"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      }
      delete env[Serve.passwordEnv]
      // A port inside the project range; nothing listens on it when the rule holds.
      const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args, "--port", "4114"], {
        cwd: home,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: env as Record<string, string>,
      })
      const timer = setTimeout(() => proc.kill(), 45_000)
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      const exitCode = await proc.exited
      clearTimeout(timer)
      expect(exitCode).toBe(2)
      expect(stderr).toContain("without a password")
      expect(stdout).not.toContain("listening on")
    }, 60_000)
  }
})

describe("listener Host check (DNS rebinding)", () => {
  const none = () => [] as string[]

  test("loopback names are accepted with or without a port", () => {
    for (const host of ["127.0.0.1:4096", "127.0.0.1", "localhost:4096", "LOCALHOST:4096", "localhost.:4096", "[::1]:4096", "127.3.4.5:80"]) {
      expect(Serve.hostAllowed(host, { hostname: "127.0.0.1" }, none), host).toBe(true)
    }
  })

  test("a rebinding style Host naming another domain is refused", () => {
    for (const host of ["attacker.example:4096", "127.0.0.1.nip.io:4096", "localhost.attacker.example", "evil.localhost:4096", "0x7f000001:4096", "", "127.0.0.1:4096 evil", "[::1", "user@127.0.0.1"]) {
      expect(Serve.hostAllowed(host, { hostname: "127.0.0.1" }, none), host).toBe(false)
    }
    expect(Serve.hostAllowed(undefined, { hostname: "127.0.0.1" }, none)).toBe(false)
  })

  test("the configured hostname is accepted: the engine sandbox address the orchestrator connects to", () => {
    // serve-launcher.ts runs `rafikicode serve --hostname <sandbox address>` and fetches http://<sandbox address>:<port>.
    expect(Serve.hostAllowed("172.28.0.5:4180", { hostname: "172.28.0.5" }, none)).toBe(true)
    expect(Serve.hostAllowed("172.28.0.6:4180", { hostname: "172.28.0.5" }, none)).toBe(false)
    expect(Serve.hostAllowed("myhost.lan:4096", { hostname: "MyHost.lan" }, none)).toBe(true)
  })

  test("on every address, this machine's own addresses and the mDNS name are accepted, other names are not", () => {
    const addresses = () => ["192.168.1.10", "172.28.0.5", "fe80::1"]
    expect(Serve.hostAllowed("192.168.1.10:4096", { hostname: "0.0.0.0" }, addresses)).toBe(true)
    expect(Serve.hostAllowed("172.28.0.5:4096", { hostname: "0.0.0.0" }, addresses)).toBe(true)
    expect(Serve.hostAllowed("[fe80::1]:4096", { hostname: "::" }, addresses)).toBe(true)
    expect(Serve.hostAllowed("192.168.1.11:4096", { hostname: "0.0.0.0" }, addresses)).toBe(false)
    expect(Serve.hostAllowed("attacker.example:4096", { hostname: "0.0.0.0" }, addresses)).toBe(false)
    expect(Serve.hostAllowed("rafikicode.local:4096", { hostname: "0.0.0.0", mdns: true, mdnsDomain: "rafikicode.local" }, addresses)).toBe(true)
    expect(Serve.hostAllowed("rafikicode.local:4096", { hostname: "0.0.0.0", mdns: false, mdnsDomain: "rafikicode.local" }, addresses)).toBe(false)
  })
})

describe("listener Origin check (CORS)", () => {
  const host = "127.0.0.1:4096"

  test("no Origin, the server's own origin and configured origins are allowed", () => {
    expect(Serve.originAllowed(undefined, host, {})).toBe(true)
    expect(Serve.originAllowed("http://127.0.0.1:4096", host, {})).toBe(true)
    expect(Serve.originAllowed("https://ide.example.com", host, { cors: ["https://ide.example.com"] })).toBe(true)
  })

  test("foreign origins are refused, including the upstream allowances", () => {
    for (const origin of [
      "https://app.opencode.ai",
      "https://anything.opencode.ai",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "tauri://localhost",
      "oc://renderer",
      "null",
      "http://attacker.example",
      "http://127.0.0.1:4096/path",
      "https://ide.example.com.attacker.example",
    ]) {
      expect(Serve.originAllowed(origin, host, { cors: ["https://ide.example.com"] }), origin).toBe(false)
    }
    expect(Serve.originAllowed("http://127.0.0.1:4096", undefined, {})).toBe(false)
  })

  test("the in process server (no listen options) keeps the upstream middleware untouched", () => {
    const next = <E, R>(app: Effect.Effect<any, E, R>) => app as any
    expect(Serve.listenerGuard(undefined, next)).toBe(next)
    expect(Serve.listenerGuard({ cors: [] }, next)).toBe(next)
    expect(Serve.listenerGuard({ hostname: "127.0.0.1" }, next)).not.toBe(next)
  })
})

describe("secret redaction", () => {
  test("secret property names", () => {
    for (const name of ["apiKey", "api_key", "API-KEY", "key", "x-api-key", "Authorization", "accessToken", "refresh_token", "token", "clientSecret", "password", "OPENCODE_SERVER_PASSWORD", "GITHUB_TOKEN", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "Cookie", "privateKey"]) {
      expect(Serve.secretKeyName(name), name).toBe(true)
    }
    for (const name of ["baseURL", "headers", "keybinds", "X-Rafiki-Surface", "model", "name", "maxTokens", "tokenizer", "monkey", "keyboard", "environment"]) {
      expect(Serve.secretKeyName(name), name).toBe(false)
    }
  })

  test("known secret values: secret named env values, the server password and the stored key", () => {
    const secrets = Serve.knownSecrets(
      { RAFIKICODE_API_KEY: "stub-rafiki-key-000001", OPENCODE_SERVER_PASSWORD: "stub-password-0001", PATH: "/usr/bin:/bin", SHORT_TOKEN: "abc" },
      "stub-stored-key-0000001",
    )
    expect(secrets).toContain("stub-rafiki-key-000001")
    expect(secrets).toContain("stub-password-0001")
    expect(secrets).toContain("stub-stored-key-0000001")
    expect(secrets).not.toContain("/usr/bin:/bin")
    expect(secrets).not.toContain("abc")
  })

  test("a configuration keeps its shape and loses every secret", () => {
    const config = {
      keybinds: { app_exit: "ctrl+c" },
      provider: {
        rafiki: { options: { baseURL: "https://gateway.rafikiai.io/v1", apiKey: "stub-stored-key-0000001", headers: { "X-Rafiki-Surface": "cli" } } },
        other: { key: "stub-provider-key-01", options: { headers: { Authorization: "Bearer stub-provider-token-01" } } },
      },
      mcp: { tools: { type: "local", command: ["run", "--token", "stub-rafiki-key-000001"], environment: { GITHUB_TOKEN: "stub-github-token-01", LOG_LEVEL: "info" } } },
      limit: { output: 64000 },
      note: "the key is stub-rafiki-key-000001 here",
    }
    const out = Serve.redact(config, ["stub-rafiki-key-000001"]) as any
    expect(out.keybinds).toEqual({ app_exit: "ctrl+c" })
    expect(out.provider.rafiki.options.baseURL).toBe("https://gateway.rafikiai.io/v1")
    expect(out.provider.rafiki.options.apiKey).toBe(Serve.REDACTED)
    expect(out.provider.rafiki.options.headers).toEqual({ "X-Rafiki-Surface": "cli" })
    expect(out.provider.other.key).toBe(Serve.REDACTED)
    expect(out.provider.other.options.headers.Authorization).toBe(Serve.REDACTED)
    expect(out.mcp.tools.command).toEqual(["run", "--token", Serve.REDACTED])
    expect(out.mcp.tools.environment).toEqual({ GITHUB_TOKEN: Serve.REDACTED, LOG_LEVEL: "info" })
    expect(out.limit).toEqual({ output: 64000 })
    expect(out.note).toBe(Serve.REDACTED)
    expect(JSON.stringify(out)).not.toMatch(/stub-(stored|provider|github|rafiki)/)
  })

  test("a config update drops the redacted values a client saves back", () => {
    const patch = {
      provider: { rafiki: { options: { apiKey: Serve.REDACTED, timeout: 5000 } } },
      mcp: { tools: { command: ["run", Serve.REDACTED], environment: { GITHUB_TOKEN: Serve.REDACTED, LOG_LEVEL: "debug" } } },
      theme: "dark",
    }
    expect(Serve.withoutRedacted(patch)).toEqual({
      provider: { rafiki: { options: { timeout: 5000 } } },
      mcp: { tools: { environment: { LOG_LEVEL: "debug" } } },
      theme: "dark",
    } as any)
  })

  test("only the configuration and provider routes are rewritten", () => {
    for (const url of ["/config", "/config?directory=/tmp", "/config/", "/config/providers", "/global/config", "/provider", "/provider?directory=x", "/api/provider", "/api/provider/rafiki"]) {
      expect(Serve.redactsRoute(url), url).toBe(true)
    }
    for (const url of ["/global/health", "/session", "/provider/auth", "/event", "/configx", "/"]) expect(Serve.redactsRoute(url), url).toBe(false)
  })
})

type Answer = { status: number; headers: Record<string, string>; body: string }

// One HTTP/1.1 request over a plain socket, so the Host and Origin headers are exactly what a browser under attack would send.
function send(port: number, method: string, target: string, headers: Record<string, string>, body = ""): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1")
    const chunks: Buffer[] = []
    socket.setTimeout(20_000, () => socket.destroy(new Error(`no answer for ${method} ${target}`)))
    socket.on("connect", () => {
      const all: Record<string, string> = { ...headers, connection: "close" }
      if (body) all["content-length"] = String(Buffer.byteLength(body))
      const head = [`${method} ${target} HTTP/1.1`, ...Object.entries(all).map(([name, value]) => `${name}: ${value}`)].join("\r\n")
      socket.write(`${head}\r\n\r\n${body}`)
    })
    socket.on("data", (chunk) => chunks.push(chunk))
    socket.on("error", reject)
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8")
      const split = text.indexOf("\r\n\r\n")
      const [status, ...lines] = text.slice(0, split).split("\r\n")
      const parsed: Record<string, string> = {}
      for (const line of lines) {
        const colon = line.indexOf(":")
        parsed[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      let rest = text.slice(split + 4)
      if (parsed["transfer-encoding"]?.includes("chunked")) {
        let out = ""
        while (rest.length) {
          const end = rest.indexOf("\r\n")
          const size = parseInt(rest.slice(0, end), 16)
          if (!size) break
          out += rest.slice(end + 2, end + 2 + size)
          rest = rest.slice(end + 2 + size + 2)
        }
        rest = out
      }
      resolve({ status: Number(status.split(" ")[1]), headers: parsed, body: rest })
    })
  })
}

describe("rafikicode serve on a port: Host, Origin and redaction", () => {
  const port = 4115
  const stub = {
    password: "stub-server-password-0001",
    stored: "stub-stored-rafiki-key-000000000001",
    provider: "stub-provider-key-000000000000001",
    mcp: "stub-mcp-token-0000000000000001",
    extraOrigin: "https://ide.example.com",
  }
  const leak = /stub-(server-password|stored-rafiki-key|provider-key|mcp-token)/
  const work = path.join(home, "listener")
  const xdg = path.join(work, ".config")
  const configFile = path.join(xdg, Brand.dir, "config.json")
  const auth = { authorization: `Basic ${Buffer.from(`rafikicode:${stub.password}`).toString("base64")}` }
  const self = `127.0.0.1:${port}`

  test("a wrong Host is refused, a foreign Origin gets 403 and no CORS headers, secrets are redacted", async () => {
    fs.mkdirSync(path.join(xdg, Brand.dir), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.join(xdg, Brand.dir), 0o700)
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        provider: {
          stubco: {
            name: "Stub",
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: stub.provider, baseURL: "http://127.0.0.1:4119/v1" },
            models: { "stub-model": { name: "Stub model" } },
          },
        },
        mcp: { stub: { type: "local", command: ["true"], enabled: false, environment: { STUB_TOKEN: stub.mcp } } },
      }),
    )
    // A stored login with a stub key; the gateway and Console point at a closed loopback port, so nothing leaves the machine.
    fs.writeFileSync(
      path.join(xdg, Brand.dir, "credentials"),
      JSON.stringify({ version: 1, key: stub.stored, kind: "server", gateway_url: "http://127.0.0.1:4119", console_url: "http://127.0.0.1:4119", created_at: new Date().toISOString() }),
      { mode: 0o600 },
    )
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: work,
      OPENCODE_TEST_HOME: work,
      XDG_CONFIG_HOME: xdg,
      XDG_DATA_HOME: path.join(work, ".local/share"),
      XDG_STATE_HOME: path.join(work, ".local/state"),
      XDG_CACHE_HOME: path.join(work, ".cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      RAFIKICODE_GATEWAY_URL: "http://127.0.0.1:4119",
      RAFIKICODE_CONSOLE_URL: "http://127.0.0.1:4119",
      [Serve.passwordEnv]: stub.password,
    }
    delete env.RAFIKICODE_API_KEY
    delete env.CI
    delete env.OPENCODE_SERVER_USERNAME
    const proc = Bun.spawn(
      ["bun", "run", path.join(root, "src/index.ts"), "serve", "--hostname", "127.0.0.1", "--port", String(port), "--cors", stub.extraOrigin],
      { cwd: work, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: env as Record<string, string> },
    )
    const stderr = new Response(proc.stderr).text()
    try {
      let ready = false
      for (let i = 0; i < 240 && !ready; i++) {
        const answer = await send(port, "GET", "/global/health", { host: self, ...auth }).catch(() => undefined)
        if (answer?.status === 200) ready = true
        else await Bun.sleep(250)
      }
      expect(ready).toBe(true)

      // Host: the listen address and loopback names pass; rebinding names do not, even with the right password.
      expect((await send(port, "GET", "/global/health", { host: `localhost:${port}`, ...auth })).status).toBe(200)
      for (const host of [`attacker.example:${port}`, `127.0.0.1.nip.io:${port}`]) {
        const refused = await send(port, "GET", "/global/config", { host, ...auth })
        expect(refused.status, host).toBe(403)
        expect(refused.body).not.toMatch(leak)
      }

      // Origin: foreign origins get 403 and no CORS headers, on a preflight and on a real request.
      for (const origin of ["https://app.opencode.ai", "http://localhost:3000", "null"]) {
        const preflight = await send(port, "OPTIONS", "/global/config", { host: self, origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" })
        expect(preflight.status, origin).toBe(403)
        expect(preflight.headers["access-control-allow-origin"], origin).toBeUndefined()
        const real = await send(port, "GET", "/global/config", { host: self, origin, ...auth })
        expect(real.status, origin).toBe(403)
        expect(real.headers["access-control-allow-origin"], origin).toBeUndefined()
        expect(real.body).not.toMatch(leak)
      }
      const own = await send(port, "OPTIONS", "/global/config", { host: self, origin: `http://${self}`, "access-control-request-method": "GET" })
      expect(own.status).toBe(204)
      expect(own.headers["access-control-allow-origin"]).toBe(`http://${self}`)
      const configured = await send(port, "OPTIONS", "/global/config", { host: self, origin: stub.extraOrigin, "access-control-request-method": "GET" })
      expect(configured.status).toBe(204)
      expect(configured.headers["access-control-allow-origin"]).toBe(stub.extraOrigin)

      // The password rule is unchanged.
      expect((await send(port, "GET", "/global/config", { host: self })).status).toBe(401)

      // Redaction: the configuration keeps its shape, every stub secret is replaced.
      const global = await send(port, "GET", "/global/config", { host: self, ...auth, "accept-encoding": "gzip" })
      expect(global.status).toBe(200)
      expect(global.headers["content-encoding"]).toBeUndefined()
      expect(global.body).not.toMatch(leak)
      const globalJson = JSON.parse(global.body)
      expect(globalJson.provider.stubco.options.apiKey).toBe(Serve.REDACTED)
      expect(globalJson.provider.stubco.options.baseURL).toBe("http://127.0.0.1:4119/v1")
      expect(globalJson.mcp.stub.environment.STUB_TOKEN).toBe(Serve.REDACTED)

      const directory = { "x-opencode-directory": work }
      for (const target of ["/config", "/provider", "/config/providers"]) {
        const answer = await send(port, "GET", target, { host: self, ...auth, ...directory, "accept-encoding": "gzip, deflate" })
        expect(answer.status, target).toBe(200)
        expect(answer.body, target).not.toMatch(leak)
        expect(answer.body.length, target).toBeGreaterThan(2)
      }
      const instance = JSON.parse((await send(port, "GET", "/config", { host: self, ...auth, ...directory })).body)
      expect(instance.provider.rafiki.options.apiKey).toBe(Serve.REDACTED)
      expect(instance.provider.stubco.options.apiKey).toBe(Serve.REDACTED)

      // Saving back a redacted answer keeps the stored secret on disk.
      const saved = await send(
        port,
        "PATCH",
        "/global/config",
        { host: self, ...auth, "content-type": "application/json" },
        JSON.stringify({
          provider: { stubco: { options: { apiKey: Serve.REDACTED, baseURL: "http://127.0.0.1:4119/v1" } } },
          mcp: { stub: { type: "local", command: ["true"], enabled: false, environment: { STUB_TOKEN: Serve.REDACTED } } },
        }),
      )
      expect(saved.status, saved.body.slice(0, 400)).toBe(200)
      expect(saved.body).not.toMatch(leak)
      const onDisk = JSON.parse(fs.readFileSync(configFile, "utf8"))
      expect(onDisk.provider.stubco.options.apiKey).toBe(stub.provider)
      expect(onDisk.mcp.stub.environment.STUB_TOKEN).toBe(stub.mcp)
    } finally {
      proc.kill()
      await proc.exited
    }
    expect(await stderr).not.toMatch(leak)
  }, 150_000)
})
