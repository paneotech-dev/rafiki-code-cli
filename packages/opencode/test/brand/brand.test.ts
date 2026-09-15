// Brand defaults for the rafikicode fork. Everything asserted here comes from
// packages/core/src/brand, the single place that distinguishes rafikicode from
// upstream, plus the few upstream files that import it.
import { describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { Brand } from "@opencode-ai/core/brand/brand"
import { word } from "@opencode-ai/core/brand/wordmark"
import { sessionEpilogue } from "../../../tui/src/util/presentation"
import { Global } from "@opencode-ai/core/global"
import pkg from "../../package.json"

const root = path.resolve(import.meta.dir, "../..")

// The upstream name may only survive inside OPENCODE_* environment variable
// names, which stay unchanged for plugin and documentation compatibility.
const upstreamWord = /(?<![A-Z_])opencode(?![A-Z_])/i

async function help(
  args: string[],
  extraEnv: Record<string, string> = {},
  options: { cwd?: string; prepare?: (home: string) => Promise<void>; inspect?: (home: string) => Promise<void> } = {},
) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rafikicode-brand-"))
  if (options.prepare) await options.prepare(home)
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args], {
    cwd: options.cwd ?? root,
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
      ...extraEnv,
    },
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  if (options.inspect) await options.inspect(home)
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

  test("Console URL default and override", () => {
    expect(Brand.console.url).toBe("https://console.rafikiai.io")
    const before = process.env[Brand.env.consoleURL]
    delete process.env[Brand.env.consoleURL]
    expect(Brand.consoleURL()).toBe("https://console.rafikiai.io")
    process.env[Brand.env.consoleURL] = "http://127.0.0.1:4181/"
    expect(Brand.consoleURL()).toBe("http://127.0.0.1:4181")
    if (before === undefined) delete process.env[Brand.env.consoleURL]
    else process.env[Brand.env.consoleURL] = before
  })

  test("config file name is config.json", () => {
    expect(Brand.configFile).toBe("config.json")
  })

  test("OPENCODE_CONFIG_DIR reads config.json as well as the upstream file names", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rafikicode-configdir-"))
    await fs.writeFile(path.join(dir, Brand.configFile), JSON.stringify({ username: "from-config-json" }))
    await fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify({ model: "configdir/model" }))
    const result = await help(["debug", "config"], { OPENCODE_CONFIG_DIR: dir })
    await fs.rm(dir, { recursive: true, force: true })
    expect(result.exitCode).toBe(0)
    const config = JSON.parse(result.stdout)
    expect(config.username).toBe("from-config-json")
    expect(config.model).toBe("configdir/model")
  }, 60_000)

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
    expect(path.basename(Global.Path.tmp)).toBe("rafikicode")
    expect(Global.Path.config).toBe(Brand.configDir())
    // Sessions, logs, the binary cache, and snapshots never share a directory
    // with an upstream install, so its sessions cannot show up in ours.
    for (const key of ["data", "cache", "state", "tmp", "log", "bin", "repos"] as const) {
      const segments = Global.Path[key].split(path.sep)
      expect(segments).toContain("rafikicode")
      expect(segments).not.toContain("opencode")
    }
  })

  test("docs link, config hint, and default theme name are branded", () => {
    expect(Brand.docs).toBe("https://github.com/paneotech-dev/rafiki-code-cli")
    expect(Brand.issues.startsWith(Brand.docs)).toBe(true)
    expect(Brand.configHint).toBe(`~/${Brand.configDirName}/${Brand.configFile}`)
    expect(Brand.theme).toBe("rafikicode")
    for (const value of [Brand.docs, Brand.issues, Brand.configHint, Brand.theme, Brand.homepage]) {
      expect(value).not.toMatch(upstreamWord)
    }
  })

  test("default config registers the gateway provider only with a key and always disables upstream providers", () => {
    const before = process.env[Brand.env.apiKey]
    delete process.env[Brand.env.apiKey]
    const withoutKey = Brand.config()
    expect(withoutKey.provider).toBeUndefined()
    expect(withoutKey.disabled_providers).toEqual(["opencode", "opencode-go"])
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
    expect(config.disabled_providers).toEqual(["opencode", "opencode-go"])
    expect(JSON.stringify(config).replaceAll('"opencode","opencode-go"', "")).not.toMatch(upstreamWord)
  })

  test("project config names prefer rafikicode and keep reading the upstream names", async () => {
    expect(Brand.project.dir).toBe(".rafikicode")
    expect(Brand.project.file).toBe("rafikicode")
    expect(Brand.project.dirs[0]).toBe(".rafikicode")
    expect(Brand.project.files[0]).toBe("rafikicode.json")
    expect(Brand.project.isDir("/a/b/.rafikicode")).toBe(true)
    expect(Brand.project.isDir("/a/b/.opencode")).toBe(true)
    expect(Brand.project.isDir("/a/b/.other")).toBe(false)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rafikicode-project-"))
    expect(Brand.project.dirIn(root)).toBe(path.join(root, ".rafikicode"))
    await fs.mkdir(path.join(root, ".opencode"))
    expect(Brand.project.dirIn(root)).toBe(path.join(root, ".opencode"))
    await fs.mkdir(path.join(root, ".rafikicode"))
    expect(Brand.project.dirIn(root)).toBe(path.join(root, ".rafikicode"))
    await fs.rm(root, { recursive: true, force: true })
  })

  test("rafikicode.json, .rafikicode/, and the upstream names are all read from a project", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "rafikicode-projectcfg-"))
    await fs.writeFile(path.join(project, "rafikicode.json"), JSON.stringify({ username: "from-rafikicode-json" }))
    await fs.mkdir(path.join(project, ".rafikicode"))
    await fs.writeFile(path.join(project, ".rafikicode", "rafikicode.json"), JSON.stringify({ model: "dir/model" }))
    await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ small_model: "legacy/model" }))
    const result = await help(["debug", "config"], { OPENCODE_DISABLE_PROJECT_CONFIG: "" }, { cwd: project })
    await fs.rm(project, { recursive: true, force: true })
    expect(result.exitCode).toBe(0)
    const config = JSON.parse(result.stdout)
    expect(config.username).toBe("from-rafikicode-json")
    expect(config.model).toBe("dir/model")
    expect(config.small_model).toBe("legacy/model")
  }, 60_000)

  test("a fresh global config is seeded with our schema URL", async () => {
    let seeded = ""
    const result = await help(["debug", "config"], { XDG_CONFIG_HOME: "" }, {
      inspect: async (home) => {
        seeded = await fs.readFile(path.join(home, ".rafikicode", "config.json"), "utf8")
      },
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(seeded).$schema).toBe(Brand.schema.config)
    // A source run is not a release, so it points at the published fallback tag.
    expect(Brand.schema.config).toBe(
      `https://raw.githubusercontent.com/paneotech-dev/rafiki-code-cli/${Brand.schema.fallbackTag}/schema/config.json`,
    )
    expect(seeded).not.toMatch(upstreamWord)
  }, 60_000)

  test("a global config holding the broken main schema URL gets only that value replaced", async () => {
    const before = `{\n  // kept as written\n  "$schema": "${Brand.schema.broken.config}",\n  "username": "keep-me"\n}\n`
    let after = ""
    const result = await help(["debug", "config"], { XDG_CONFIG_HOME: "" }, {
      prepare: async (home) => {
        await fs.mkdir(path.join(home, ".rafikicode"), { recursive: true })
        await fs.writeFile(path.join(home, ".rafikicode", "config.json"), before)
      },
      inspect: async (home) => {
        after = await fs.readFile(path.join(home, ".rafikicode", "config.json"), "utf8")
      },
    })
    expect(result.exitCode).toBe(0)
    expect(after).toBe(before.replace(Brand.schema.broken.config, Brand.schema.config))
    expect(JSON.parse(result.stdout).username).toBe("keep-me")
  }, 60_000)

  test("the schema files are checked in and free of upstream names", async () => {
    for (const name of ["config.json", "tui.json"]) {
      const text = await fs.readFile(path.join(root, "../../schema", name), "utf8")
      expect(JSON.parse(text).$schema).toBe("https://json-schema.org/draft/2020-12/schema")
      expect(text).not.toMatch(upstreamWord)
      expect(text).not.toContain("opencode.ai")
    }
  })

  test("release locations and npm names come from the brand module", () => {
    expect(Brand.release.owner).toBe("paneotech-dev")
    expect(Brand.release.repo).toBe("rafiki-code-cli")
    expect(Brand.release.installer).toBe("https://get.rafikiai.io")
    expect(Brand.release.checksums).toBe("SHA256SUMS")
    expect(Brand.release.asset("linux", "x64")).toBe("rafikicode-linux-x64.tar.gz")
    expect(Brand.npm.meta).toBe("rafikicode")
    expect(Brand.env.releaseAPI).toBe("RAFIKICODE_RELEASE_API")
    expect(Brand.env.releaseBase).toBe("RAFIKICODE_RELEASE_BASE")
  })

  test("house style forbids attribution, emoji, and long dashes", () => {
    expect(Brand.houseStyle).toContain("Co-Authored-By")
    expect(Brand.houseStyle).toContain("Imperative")
    expect(Brand.houseStyle).not.toContain("\u2014")
    expect(Brand.houseStyle).not.toContain("\u2013")
    expect(Brand.houseStyle).not.toMatch(upstreamWord)
  })

  test("wordmark spells the product, not the upstream name", () => {
    expect(Brand.wordmark).toHaveLength(4)
    expect(Brand.logo.left).toHaveLength(4)
    expect(Brand.logo.right).toHaveLength(4)
    expect(Brand.logo.left).toEqual(word("rafiki"))
    expect(Brand.logo.right).toEqual(word("code"))
    expect(Brand.wordmark.join("\n")).not.toMatch(upstreamWord)
  })

  test("system prompts introduce the agent as the product and link to our repo", async () => {
    const dir = path.join(root, "src/session/prompt")
    const files = (await fs.readdir(dir)).filter((file) => file.endsWith(".txt"))
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const text = Brand.prompt(await fs.readFile(path.join(dir, file), "utf8"))
      expect(text).not.toMatch(upstreamWord)
      expect(text).not.toContain("anomalyco")
      expect(text).not.toContain("opencode.ai")
    }
    const rewritten = Brand.prompt("You are opencode. Report issues at https://github.com/anomalyco/opencode/issues")
    expect(rewritten).toBe(`You are ${Brand.name}. Report issues at ${Brand.docs}/issues`)
    expect(Brand.prompt("see https://opencode.ai/docs/agents and https://opencode.ai/docs")).toBe(`see ${Brand.docs} and ${Brand.docs}`)
    // Config file names and project directories are left alone.
    expect(Brand.prompt("see opencode.json and .opencode/agents")).toBe("see opencode.json and .opencode/agents")
  })

  test("session epilogue shows the brand wordmark and the rafikicode continue hint", () => {
    const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
    const plain = epilogue.replace(/\x1b\[[0-9;]*m/g, "")
    expect(plain).toContain("rafikicode -s ses_123")
    expect(plain).toContain(Brand.wordmark[1])
    expect(plain).toContain(Brand.wordmark[2])
    expect(plain).not.toMatch(upstreamWord)
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
    expect(result.stderr).not.toContain("rafikicode github")
    expect(result.stderr).toContain("rafikicode [project]")
    expect(result.stderr).toContain(Brand.wordmark[1])
    expect(result.stderr).not.toMatch(upstreamWord)
  }, 60_000)

  test("doctor is listed and its help names the product", async () => {
    const top = await help(["--help"])
    expect(top.exitCode).toBe(0)
    expect(top.stderr).toContain("rafikicode doctor")
    expect(top.stderr).toContain("rafikicode login")
    expect(top.stderr).toContain("rafikicode whoami")
    const result = await help(["doctor", "--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("rafikicode doctor")
    expect(result.stderr).toContain("check this terminal's Rafiki Code setup")
    expect(result.stderr).toContain("--timeout")
    expect(result.stderr).not.toMatch(upstreamWord)
  }, 60_000)

  test("run help names rafikicode", async () => {
    const result = await help(["run", "--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("rafikicode run [message..]")
    expect(result.stderr).not.toMatch(upstreamWord)
  }, 60_000)
})
