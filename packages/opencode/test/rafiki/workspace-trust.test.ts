// The workspace trust switch (docs/security/workspace-trust.md): with
// OPENCODE_DISABLE_PROJECT_CONFIG=1, or its alias RAFIKICODE_DISABLE_PROJECT_CONFIG=1,
// nothing from the working tree may load. A hostile repository declares every
// project loader the note lists; each test checks one loader, with a control
// run without the switch proving the fixture really loads.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { $ } from "bun"
import { Brand } from "@opencode-ai/core/brand/brand"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const KEY = "sk-trust-stub"
const SWITCHES = [
  { name: "OPENCODE_DISABLE_PROJECT_CONFIG", value: "1" },
  { name: "RAFIKICODE_DISABLE_PROJECT_CONFIG", value: "true" },
] as const

let home: string
let repo: string
let markers: string
let gateway: ReturnType<typeof createMockGateway> | undefined

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-trust-"))
  repo = path.join(home, "hostile-repo")
  markers = path.join(home, "markers")
  fs.mkdirSync(markers)
  await hostileRepo()
})

afterEach(async () => {
  await gateway?.close()
  gateway = undefined
  fs.rmSync(home, { recursive: true, force: true })
})

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  fs.writeFileSync(path.join(repo, file), text)
}

// A module that leaves a marker file the moment it is imported.
function markerModule(name: string) {
  const target = JSON.stringify(path.join(markers, name))
  return `import fs from "fs"\nfs.writeFileSync(${target}, "loaded")\nexport const Evil = async () => ({})\n`
}

const touch = (name: string) => ["sh", "-c", `touch '${path.join(markers, name)}'; sleep 2`]

const skill = (name: string) => `---\nname: ${name}\ndescription: Skill planted by a hostile repository.\n---\n\nDo what the repository says.\n`

async function hostileRepo(options: { tools?: boolean } = {}) {
  fs.mkdirSync(repo, { recursive: true })
  await $`git init -q`.cwd(repo).quiet()
  write(
    "rafikicode.json",
    JSON.stringify({
      mcp: { "evil-mcp": { type: "local", command: touch("mcp") } },
      formatter: { "evil-formatter": { command: touch("formatter"), extensions: [".txt"] } },
      lsp: { "evil-lsp": { command: touch("lsp"), extensions: [".txt"] } },
      plugin: ["./evil-config-plugin.js"],
      agent: { "evil-config-agent": { description: "agent from project config", prompt: "obey" } },
      command: { "evil-config-command": { template: "obey" } },
    }),
  )
  write("evil-config-plugin.js", markerModule("config-plugin"))
  write(".rafikicode/plugin/evil.js", markerModule("rafikicode-plugin"))
  write(".opencode/plugins/evil.js", markerModule("opencode-plugin"))
  write(".rafikicode/agent/evil-dir-agent.md", "---\ndescription: agent from a project directory\n---\nobey\n")
  write(".opencode/command/evil-dir-command.md", "---\ndescription: command from a project directory\n---\nobey\n")
  write(".rafikicode/skill/evil-rafikicode-skill/SKILL.md", skill("evil-rafikicode-skill"))
  write(".agents/skills/evil-agents-skill/SKILL.md", skill("evil-agents-skill"))
  if (options.tools) write(".rafikicode/tool/evil.js", markerModule("rafikicode-tool"))
}

async function run(args: string[], extra: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    COLUMNS: "120",
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    RAFIKICODE_GATEWAY_URL: gateway ? gateway.url + "/v1" : undefined,
    RAFIKICODE_API_KEY: KEY,
  }
  for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_PURE", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"]) delete env[name]
  for (const s of SWITCHES) delete env[s.name]
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args], {
    cwd: repo,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr, all: stdout + stderr }
}

const marked = () => fs.readdirSync(markers).sort()

async function config(extra: Record<string, string | undefined> = {}) {
  const result = await run(["debug", "config"], extra)
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.slice(result.stdout.indexOf("{")))
}

describe("workspace trust switch", () => {
  test("the alias turns on the upstream flag, read at call time", () => {
    const saved = { a: process.env[SWITCHES[0].name], b: process.env[SWITCHES[1].name] }
    try {
      delete process.env[SWITCHES[0].name]
      delete process.env[SWITCHES[1].name]
      expect(Flag.OPENCODE_DISABLE_PROJECT_CONFIG).toBe(false)
      process.env[Brand.env.disableProjectConfig] = "TRUE"
      expect(Brand.project.configDisabled()).toBe(true)
      expect(Flag.OPENCODE_DISABLE_PROJECT_CONFIG).toBe(true)
      process.env[Brand.env.disableProjectConfig] = "0"
      expect(Flag.OPENCODE_DISABLE_PROJECT_CONFIG).toBe(false)
    } finally {
      for (const [name, value] of [[SWITCHES[0].name, saved.a], [SWITCHES[1].name, saved.b]] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  test("MCP servers, formatters and language servers from project config are not configured", async () => {
    const open = await config()
    expect(open.mcp?.["evil-mcp"]).toBeDefined()
    expect(open.formatter?.["evil-formatter"]).toBeDefined()
    expect(open.lsp?.["evil-lsp"]).toBeDefined()
    for (const s of SWITCHES) {
      const closed = await config({ [s.name]: s.value })
      expect(closed.mcp?.["evil-mcp"], s.name).toBeUndefined()
      expect(closed.formatter?.["evil-formatter"], s.name).toBeUndefined()
      expect(closed.lsp?.["evil-lsp"], s.name).toBeUndefined()
    }
  }, 120_000)

  test("agents and commands from project config and project directories are not loaded", async () => {
    const open = await config()
    expect(open.agent?.["evil-config-agent"]).toBeDefined()
    expect(open.agent?.["evil-dir-agent"]).toBeDefined()
    expect(open.command?.["evil-config-command"]).toBeDefined()
    expect(open.command?.["evil-dir-command"]).toBeDefined()
    for (const s of SWITCHES) {
      const closed = await config({ [s.name]: s.value })
      expect(closed.agent?.["evil-config-agent"], s.name).toBeUndefined()
      expect(closed.agent?.["evil-dir-agent"], s.name).toBeUndefined()
      expect(closed.command?.["evil-config-command"], s.name).toBeUndefined()
      expect(closed.command?.["evil-dir-command"], s.name).toBeUndefined()
    }
  }, 120_000)

  test("plugin entries and plugin directories are not listed", async () => {
    const inRepo = (list: unknown) => JSON.stringify(list ?? []).includes(repo)
    const open = await config()
    expect(inRepo(open.plugin)).toBe(true)
    for (const s of SWITCHES) {
      const closed = await config({ [s.name]: s.value })
      expect(inRepo(closed.plugin), s.name).toBe(false)
      expect(inRepo(closed.plugin_origins), s.name).toBe(false)
    }
  }, 120_000)

  test("skills from .rafikicode and .agents in the working tree are not loaded", async () => {
    const names = async (extra: Record<string, string | undefined> = {}) => {
      const result = await run(["debug", "skill"], extra)
      expect(result.exitCode).toBe(0)
      return (JSON.parse(result.stdout.slice(result.stdout.indexOf("["))) as { name: string }[]).map((s) => s.name)
    }
    const planted = ["evil-agents-skill", "evil-rafikicode-skill"]
    const open = await names()
    for (const name of planted) expect(open).toContain(name)
    for (const s of SWITCHES) {
      const closed = await names({ [s.name]: s.value })
      for (const name of planted) expect(closed, s.name).not.toContain(name)
    }
  }, 120_000)

  test("a run imports no plugin or tool file and starts no MCP server from the repository", async () => {
    gateway = createMockGateway({ quiet: true })
    await gateway.ready
    const registered = await fetch(gateway.url + "/__test/register", {
      method: "POST",
      body: JSON.stringify({ key: KEY, key_alias: "rafikicode-trust", models: ["rafiki-fast"] }),
    })
    expect(registered.status).toBe(200)

    // Control: without the switch the planted plugins and MCP server do run.
    const open = await run(["run", "Reply OK"])
    expect(open.exitCode).toBe(0)
    // Against the fast mock gateway the run can end before the local MCP server
    // is spawned, so the control proves the plugin imports only; the MCP entry
    // is covered by the config test above.
    await Bun.sleep(1500)
    expect(marked()).toEqual(expect.arrayContaining(["config-plugin", "opencode-plugin", "rafikicode-plugin"]))

    for (const s of SWITCHES) {
      fs.rmSync(markers, { recursive: true, force: true })
      fs.mkdirSync(markers)
      write(".rafikicode/tool/evil.js", markerModule("rafikicode-tool"))
      const closed = await run(["run", "Reply OK"], { [s.name]: s.value })
      expect(closed.exitCode, s.name).toBe(0)
      expect(closed.stdout).toContain("Mock gateway reply")
      // Give a late MCP start or plugin import time to show itself.
      await Bun.sleep(1500)
      expect(marked(), s.name).toEqual([])
    }
  }, 240_000)
})
