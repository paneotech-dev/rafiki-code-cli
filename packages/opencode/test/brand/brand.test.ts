// Brand defaults for the rafikicode fork. Everything asserted here comes from
// packages/core/src/brand, the single place that distinguishes rafikicode from
// upstream, plus the few upstream files that import it.
import { describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { Brand } from "@opencode-ai/core/brand/brand"
import { Global } from "@opencode-ai/core/global"
import pkg from "../../package.json"

const root = path.resolve(import.meta.dir, "../..")

// The upstream name may only survive inside OPENCODE_* environment variable
// names, which stay unchanged for plugin and documentation compatibility.
const upstreamWord = /(?<![A-Z_])opencode(?![A-Z_])/i

async function help(args: string[]) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rafikicode-brand-"))
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      COLUMNS: "120",
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    },
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  await fs.rm(home, { recursive: true, force: true })
  return { exitCode, stdout, stderr }
}

describe("brand constants", () => {
  test("binary and product names", () => {
    expect(Brand.name).toBe("rafikicode")
    expect(Brand.product).toBe("Rafiki Code")
    expect(Brand.dir).toBe("rafikicode")
  })

  test("gateway base URL and override", () => {
    expect(Brand.gateway.url).toBe("https://gateway.rafikiai.io/v1")
    const before = process.env[Brand.env.gatewayURL]
    process.env[Brand.env.gatewayURL] = "http://127.0.0.1:4180/v1"
    expect(Brand.gatewayURL()).toBe("http://127.0.0.1:4180/v1")
    delete process.env[Brand.env.gatewayURL]
    expect(Brand.gatewayURL()).toBe("https://gateway.rafikiai.io/v1")
    if (before !== undefined) process.env[Brand.env.gatewayURL] = before
  })

  test("model aliases and default model", () => {
    expect([...Brand.models]).toEqual(["rafiki-fast", "rafiki-pro", "rafiki-max"])
    expect(Brand.defaultModel).toBe("rafiki/rafiki-fast")
    expect(Brand.provider.id).toBe("rafiki")
  })

  test("headless key env var name", () => {
    expect(Brand.env.apiKey).toBe("RAFIKICODE_API_KEY")
  })

  test("config file name is config.json", () => {
    expect(Brand.configFile).toBe("config.json")
  })

  test("config directory defaults to ~/.rafikicode and honors XDG_CONFIG_HOME", () => {
    const xdg = process.env["XDG_CONFIG_HOME"]
    delete process.env["XDG_CONFIG_HOME"]
    expect(Brand.configDir("/home/someone")).toBe(path.join("/home/someone", ".rafikicode"))
    process.env["XDG_CONFIG_HOME"] = "/tmp/xdg"
    expect(Brand.configDir("/home/someone")).toBe(path.join("/tmp/xdg", "rafikicode"))
    if (xdg === undefined) delete process.env["XDG_CONFIG_HOME"]
    else process.env["XDG_CONFIG_HOME"] = xdg
  })

  test("global paths use the brand directory", () => {
    expect(path.basename(Global.Path.data)).toBe("rafikicode")
    expect(path.basename(Global.Path.cache)).toBe("rafikicode")
    expect(path.basename(Global.Path.state)).toBe("rafikicode")
    expect(Global.Path.config).toBe(Brand.configDir())
  })

  test("default config registers the gateway provider only when a key is present", () => {
    const before = process.env[Brand.env.apiKey]
    delete process.env[Brand.env.apiKey]
    expect(Brand.config().provider).toBeUndefined()
    process.env[Brand.env.apiKey] = "sk-test"
    const config = Brand.config()
    if (before === undefined) delete process.env[Brand.env.apiKey]
    else process.env[Brand.env.apiKey] = before
    const provider = config.provider!.rafiki
    expect(provider.npm).toBe("@ai-sdk/openai-compatible")
    expect(provider.env).toEqual(["RAFIKICODE_API_KEY"])
    expect(provider.options.baseURL).toBe(Brand.gatewayURL())
    expect(Object.keys(provider.models)).toEqual(["rafiki-fast", "rafiki-pro", "rafiki-max"])
    for (const model of Object.values(provider.models)) expect(model.tool_call).toBe(true)
    expect(config.autoupdate).toBe(false)
    expect(JSON.stringify(config)).not.toMatch(upstreamWord)
  })

  test("house style forbids attribution, emoji, and long dashes", () => {
    expect(Brand.houseStyle).toContain("Co-Authored-By")
    expect(Brand.houseStyle).toContain("Imperative")
    expect(Brand.houseStyle).not.toContain("—")
    expect(Brand.houseStyle).not.toContain("–")
    expect(Brand.houseStyle).not.toMatch(upstreamWord)
  })

  test("wordmark spells the product, not the upstream name", () => {
    expect(Brand.wordmark).toHaveLength(4)
    expect(Brand.logo.left).toHaveLength(4)
    expect(Brand.logo.right).toHaveLength(4)
    expect(Brand.wordmark.join("\n")).not.toMatch(upstreamWord)
  })
})

describe("package surface", () => {
  test("npm package name and bin", async () => {
    expect(pkg.name).toBe("rafikicode")
    expect(Object.keys(pkg.bin)).toEqual(["rafikicode"])
    expect(pkg.bin.rafikicode).toBe("./bin/rafikicode")
    const stat = await fs.stat(path.join(root, pkg.bin.rafikicode))
    expect(stat.isFile()).toBe(true)
  })

  test("bin wrapper resolves rafikicode binaries", async () => {
    const wrapper = await fs.readFile(path.join(root, "bin/rafikicode"), "utf8")
    expect(wrapper).toContain('"rafikicode-"')
    expect(wrapper).not.toMatch(upstreamWord)
  })
})

describe("help output", () => {
  test("top level help names rafikicode and shows the wordmark", async () => {
    const result = await help(["--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("rafikicode run [message..]")
    expect(result.stderr).toContain("rafikicode [project]")
    expect(result.stderr).toContain(Brand.wordmark[1])
    expect(result.stderr).not.toMatch(upstreamWord)
  }, 60_000)

  test("run help names rafikicode", async () => {
    const result = await help(["run", "--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("rafikicode run [message..]")
    expect(result.stderr).not.toMatch(upstreamWord)
  }, 60_000)
})
