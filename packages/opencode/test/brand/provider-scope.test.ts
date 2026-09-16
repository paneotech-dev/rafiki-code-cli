// Provider scope (memo C1 to C4, docs/security/provider-scope.md): the official
// binary offers only the rafiki provider, hides rafikicode providers, prints
// one sign in message without a key (run, terminal interface, acp), and names
// its ACP auth method rafikicode-login. The preload opens the scope for the
// upstream suites; every check here closes it again.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as BrandGuard from "@opencode-ai/core/brand/guard"
import * as Trust from "@opencode-ai/core/brand/trust"
import * as MissingKey from "../../src/rafiki/missing-key"
import * as RafikiACP from "../../src/rafiki/acp"
import { createMockGateway } from "./mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const scopeEnv = Brand.providers.testEnv
const stubKey = "sk-stub-rafiki-scope-0001"
const noKeyLines = [
  "Rafiki Code needs a Rafiki AI account. Create one in the Rafiki AI console (https://console.rafikiai.io), then run: rafikicode login",
  "On a server or in CI, create an API key at https://console.rafikiai.io/keys with the Rafiki Code option ticked, and set RAFIKICODE_API_KEY.",
]
const outOfScopeLine = "rafikicode runs on Rafiki models only (rafiki-fast, rafiki-pro, rafiki-max). Run rafikicode models to see them."

type Env = Record<string, string | undefined>

// A scratch HOME with stub OpenAI and Anthropic keys and the scope closed,
// unless the caller passes the scope variable itself.
async function spawnCli(args: string[], extra: Env = {}, options: { config?: unknown; stdin?: "ignore" | "pipe" } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rafikicode-scope-"))
  if (options.config) {
    await fs.mkdir(path.join(home, ".rafikicode"), { recursive: true })
    await fs.writeFile(path.join(home, ".rafikicode", "config.json"), JSON.stringify(options.config))
  }
  const env: Env = {
    ...process.env,
    COLUMNS: "120",
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENAI_API_KEY: "sk-stub-openai-scope",
    ANTHROPIC_API_KEY: "sk-ant-stub-scope",
  }
  for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", scopeEnv, Brand.env.apiKey])
    delete env[name]
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args], {
    cwd: home,
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  })
  return { proc, home }
}

async function cli(args: string[], extra: Env = {}, options: { config?: unknown } = {}) {
  const { proc, home } = await spawnCli(args, extra, options)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  await fs.rm(home, { recursive: true, force: true })
  return { exitCode, stdout, stderr }
}

function providersOf(stdout: string) {
  return [...new Set(stdout.split("\n").filter((line) => /^[\w.-]+\/\S+$/.test(line)).map((line) => line.split("/")[0]))].sort()
}

let saved: Env = {}
let warnings: string[] = []
let restoreWarn: (message: string) => void
beforeEach(() => {
  saved = { scope: process.env[scopeEnv], key: process.env[Brand.env.apiKey], ci: process.env.CI }
  delete process.env[scopeEnv]
  delete process.env.CI
  warnings = []
  Trust.resetWarnings()
  restoreWarn = Trust.setWarn((message) => warnings.push(message))
})
afterEach(() => {
  Trust.setWarn(restoreWarn)
  Brand.providers.userOverride = false
  for (const [name, value] of [
    [scopeEnv, saved.scope],
    [Brand.env.apiKey, saved.key],
    ["CI", saved.ci],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe("provider scope defaults", () => {
  test("only the rafiki provider is enabled and the escape hatch is off", () => {
    expect([...Brand.providers.enabled]).toEqual(["rafiki"])
    expect(Brand.providers.userOverride).toBe(false)
    expect(Brand.providers.open()).toBe(false)
    // Set on the merged config (providerScope), not as a default a user file could replace.
    expect("enabled_providers" in Brand.config()).toBe(false)
  })

  test("the test variable opens the scope only in a source run", () => {
    process.env[scopeEnv] = "off"
    // bun test runs from source: no release channel is compiled in.
    expect(Brand.providers.testing()).toBe(true)
    expect(Brand.providers.open()).toBe(true)
    process.env[scopeEnv] = "on"
    expect(Brand.providers.open()).toBe(false)
  })
})

describe("providerScope on the merged config", () => {
  test("user level enabled_providers, models and agent models outside the scope are replaced", () => {
    const merged = BrandGuard.providerScope({
      enabled_providers: ["openai", "rafiki", "local"],
      disabled_providers: [],
      model: "openai/gpt-4o",
      small_model: "rafiki/rafiki-fast",
      agent: { build: { model: "anthropic/claude-x" }, plan: { model: "rafiki/rafiki-pro" } },
      mode: { review: { model: "local/llama" } },
    } as Record<string, any>)
    expect(merged.enabled_providers).toEqual(["rafiki"])
    expect(merged.disabled_providers).toEqual(["opencode", "opencode-go"])
    expect(merged.model).toBeUndefined()
    expect(merged.small_model).toBe("rafiki/rafiki-fast")
    expect(merged.agent.build.model).toBeUndefined()
    expect(merged.agent.plan.model).toBe("rafiki/rafiki-pro")
    expect(merged.mode.review.model).toBeUndefined()
    expect(warnings.join("\n")).toContain("ignored enabled_providers in the configuration")
    expect(warnings.join("\n")).toContain("ignored model openai/gpt-4o, agent.build.model anthropic/claude-x, mode.review.model local/llama")
    expect(warnings.join("\n")).toContain("runs on Rafiki models only")
  })

  test("a config without enabled_providers still gets the scope, silently", () => {
    const merged = BrandGuard.providerScope({ disabled_providers: ["groq"] } as Record<string, any>)
    expect(merged.enabled_providers).toEqual(["rafiki"])
    expect(merged.disabled_providers).toEqual(["groq", "opencode", "opencode-go"])
    expect(warnings).toEqual([])
  })

  test("with the escape hatch on, the user list is kept; without one the scope applies", () => {
    Brand.providers.userOverride = true
    expect(Brand.providers.open()).toBe(true)
    const kept = BrandGuard.providerScope({ enabled_providers: ["rafiki", "ollama"], model: "ollama/llama" } as Record<string, any>)
    expect(kept.enabled_providers).toEqual(["rafiki", "ollama"])
    expect(kept.model).toBe("ollama/llama")
    const defaulted = BrandGuard.providerScope({} as Record<string, any>)
    expect(defaulted.enabled_providers).toEqual(["rafiki"])
  })

  test("project config never sets enabled_providers, hatch on or off", () => {
    for (const hatch of [false, true]) {
      Brand.providers.userOverride = hatch
      const project = BrandGuard.projectConfig("/repo/rafikicode.json", { enabled_providers: ["openai"] } as Record<string, any>, "/repo")
      expect(project.enabled_providers).toBeUndefined()
    }
    expect(warnings.join("\n")).toContain("ignored enabled_providers in /repo/rafikicode.json")
  })
})

describe("models with stub OpenAI and Anthropic keys", () => {
  test("lists only rafiki models, whatever the user config asks for", async () => {
    const plain = await cli(["models"], { [Brand.env.apiKey]: stubKey })
    expect(plain.exitCode).toBe(0)
    expect(providersOf(plain.stdout)).toEqual(["rafiki"])
    expect(plain.stdout.trim().split("\n")).toEqual(["rafiki/rafiki-fast", "rafiki/rafiki-max", "rafiki/rafiki-pro"])

    const widened = await cli(
      ["models"],
      { [Brand.env.apiKey]: stubKey, OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ["anthropic"] }) },
      {
        config: {
          enabled_providers: ["openai", "anthropic", "rafiki", "local"],
          disabled_providers: [],
          provider: {
            local: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:4199/v1" }, models: { llama: {} } },
          },
        },
      },
    )
    expect(widened.exitCode).toBe(0)
    expect(providersOf(widened.stdout)).toEqual(["rafiki"])
    expect(widened.stderr).toContain("ignored enabled_providers in the configuration")
  }, 120_000)

  test("control: with the scope open the same keys list openai and anthropic models", async () => {
    const open = await cli(["models"], { [Brand.env.apiKey]: stubKey, [scopeEnv]: "off" })
    expect(open.exitCode).toBe(0)
    expect(providersOf(open.stdout)).toEqual(expect.arrayContaining(["anthropic", "openai", "rafiki"]))
  }, 120_000)

  test("without a Rafiki key no model is offered", async () => {
    const result = await cli(["models"])
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(Brand.signInHint())
  }, 60_000)
})

describe("providers command", () => {
  test("is not in help", async () => {
    const result = await cli(["--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("rafikicode login")
    expect(result.stderr).not.toMatch(/rafikicode (providers|auth)\b/)
  }, 60_000)

  test("every form answers with where the Rafiki key comes from", async () => {
    for (const args of [["providers"], ["providers", "list"], ["auth", "login"], ["providers", "login", "--provider", "openai"], ["auth", "--help"]]) {
      const result = await cli(args)
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("rafikicode providers is not available: rafikicode runs on Rafiki models only.")
      expect(result.stderr).toContain("Sign in with rafikicode login, or on a server or in CI set RAFIKICODE_API_KEY (create a key at https://console.rafikiai.io/keys).")
    }
  }, 120_000)
})

describe("no key message", () => {
  test("message() wording and cases", () => {
    delete process.env[Brand.env.apiKey]
    expect(MissingKey.noKey().split("\n")).toEqual(noKeyLines)
    expect(MissingKey.message(undefined)).toBe(MissingKey.noKey())
    expect(MissingKey.message("openai/gpt-4o")).toBe(MissingKey.noKey())
    process.env[Brand.env.apiKey] = stubKey
    expect(MissingKey.message(undefined)).toBeUndefined()
    expect(MissingKey.message("rafiki/rafiki-pro")).toBeUndefined()
    expect(MissingKey.message("openai/gpt-4o")).toBe(outOfScopeLine)
    expect(MissingKey.needed(undefined, undefined)).toBe(true)
    expect(MissingKey.needed("run", undefined)).toBe(true)
    expect(MissingKey.needed("run", "http://127.0.0.1:4100")).toBe(false)
    expect(MissingKey.needed("acp", undefined)).toBe(false)
    expect(MissingKey.needed("models", undefined)).toBe(false)
    Brand.providers.userOverride = true
    expect(MissingKey.needed(undefined, undefined)).toBe(false)
    expect(MissingKey.message("openai/gpt-4o")).toBeUndefined()
  })

  test("run and the terminal interface stop with the same message and exit 2", async () => {
    for (const args of [["run", "hello"], ["run", "--model", "openai/gpt-4o", "hello"], [], ["."]]) {
      const result = await cli(args)
      expect(result.exitCode).toBe(2)
      for (const line of noKeyLines) expect(result.stderr).toContain(line)
      expect(result.stderr).not.toContain("UnknownError")
    }
  }, 120_000)

  test("a key present and another provider's model: one out of scope line, no request", async () => {
    const gateway = createMockGateway({ quiet: true })
    await gateway.ready
    try {
      const result = await cli(["run", "--model", "openai/gpt-4o", "hello"], { [Brand.env.apiKey]: stubKey, RAFIKICODE_GATEWAY_URL: gateway.url + "/v1" })
      expect(result.exitCode).toBe(2)
      expect(result.stderr.split(outOfScopeLine).length - 1).toBe(1)
      expect(gateway.requests.filter((r: any) => r.path === "/v1/chat/completions")).toHaveLength(0)
    } finally {
      await gateway.close()
    }
  }, 120_000)
})

describe("acp", () => {
  test("auth method id, legacy id, and the terminal auth command", () => {
    expect(Brand.acp.authMethod).toBe("rafikicode-login")
    expect(RafikiACP.knownAuthMethod("rafikicode-login")).toBe(true)
    expect(RafikiACP.knownAuthMethod("opencode-login")).toBe(true)
    expect(RafikiACP.knownAuthMethod("other-login")).toBe(false)
    expect(RafikiACP.loginCommand("/home/u/.rafikicode/bin/rafikicode")).toBe("/home/u/.rafikicode/bin/rafikicode")
    expect(RafikiACP.loginCommand("C:\\Users\\u\\rafikicode.exe".replaceAll("\\", "/"))).toBe("C:/Users/u/rafikicode.exe")
    expect(RafikiACP.loginCommand("/usr/local/bin/bun")).toBe("rafikicode")
    expect(RafikiACP.loginArgs()).toEqual(["login", "--surface", "ide"])
  })

  async function acpSession(extra: Env) {
    const { proc, home } = await spawnCli(["acp"], extra, { stdin: "pipe" })
    const pending = new Map<number, (message: any) => void>()
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
          }
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
    }
    return { request, close, home }
  }

  test("without a key: initialize works, authenticate and session/new answer auth_required with the message", async () => {
    const acp = await acpSession({})
    try {
      const init = await acp.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { "terminal-auth": true } } })
      expect(init.result.authMethods).toHaveLength(1)
      expect(init.result.authMethods[0].id).toBe("rafikicode-login")
      expect(init.result.authMethods[0]._meta["terminal-auth"].args).toEqual(["login", "--surface", "ide"])
      for (const [method, params] of [
        ["authenticate", { methodId: "rafikicode-login" }],
        ["session/new", { cwd: acp.home, mcpServers: [] }],
        ["session/prompt", { sessionId: "ses_missing", prompt: [{ type: "text", text: "hi" }] }],
      ] as const) {
        const answer = await acp.request(method, params)
        expect(answer.error.code).toBe(-32000)
        expect(answer.error.message).toBe(`Authentication required: ${noKeyLines.join("\n")}`)
        expect(answer.error.data).toEqual({ authMethods: ["rafikicode-login"] })
      }
      const unknown = await acp.request("authenticate", { methodId: "missing-auth-method" })
      expect(unknown.error.code).toBe(-32602)
    } finally {
      await acp.close()
    }
  }, 120_000)

  test("with a key: both ids authenticate and session/new offers only rafiki models", async () => {
    const acp = await acpSession({ [Brand.env.apiKey]: stubKey, RAFIKICODE_GATEWAY_URL: "http://127.0.0.1:9/v1" })
    try {
      await acp.request("initialize", { protocolVersion: 1 })
      expect((await acp.request("authenticate", { methodId: "rafikicode-login" })).result).toEqual({})
      expect((await acp.request("authenticate", { methodId: "opencode-login" })).result).toEqual({})
      const created = await acp.request("session/new", { cwd: acp.home, mcpServers: [] })
      expect(created.error).toBeUndefined()
      const option = (created.result.configOptions ?? []).find((item: { id: string }) => item.id === "model")
      const ids: string[] = (option?.options ?? []).flatMap((item: any) => ("value" in item ? [item.value] : item.options.map((inner: any) => inner.value)))
      expect(ids.length).toBeGreaterThan(0)
      for (const id of ids) expect(id.startsWith("rafiki/")).toBe(true)
    } finally {
      await acp.close()
    }
  }, 120_000)
})
