// Headless runs. A person's own `rafikicode run` without a terminal (a script,
// a container, a pipe) keeps the default permissions, so a first task in an
// empty directory runs commands and writes files there. CI and GitHub Actions
// do not run shell commands unless something the user controls allows it:
// global config, OPENCODE_PERMISSION, run --auto, or a trusted workspace. A
// project config in an untrusted workspace grants no permission in either.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Trust from "@opencode-ai/core/brand/trust"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const KEY = "sk-headless-stub"
const names = ["CI", "GITHUB_ACTIONS", Brand.env.headless, Brand.env.trustWorkspace]
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const n of names) {
    saved[n] = process.env[n]
    delete process.env[n]
  }
})

afterEach(() => {
  for (const n of names) {
    if (saved[n] === undefined) delete process.env[n]
    else process.env[n] = saved[n]
  }
})

describe("headless detection", () => {
  test("CI, GitHub Actions and run without a terminal are headless; a terminal session is not", () => {
    expect(Trust.headless()).toBe(false)
    process.env["CI"] = "false"
    expect(Trust.headless()).toBe(false)
    process.env["CI"] = "1"
    expect(Trust.headless()).toBe(true)
    expect(Trust.headlessPermission()).toEqual({ bash: "ask" })
    delete process.env["CI"]
    process.env["GITHUB_ACTIONS"] = "true"
    expect(Trust.headless()).toBe(true)
    expect(Trust.headlessPermission()).toEqual({ bash: "ask" })
    delete process.env["GITHUB_ACTIONS"]
    Trust.markHeadless("run", { stdin: true, stdout: true })
    expect(Trust.headless()).toBe(false)
    Trust.markHeadless(undefined, { stdin: false, stdout: false })
    expect(Trust.headless()).toBe(false)
    expect(Trust.headlessPermission()).toEqual({})
    Trust.markHeadless("run", { stdin: true, stdout: false })
    expect(Trust.headless()).toBe(true)
    // Not CI: the person's own run keeps the shell.
    expect(Trust.headlessPermission()).toEqual({})
  })

  test("the project code switch: trusted everywhere by default; interactive keeps upstream loading at a terminal only", () => {
    expect(Trust.PROJECT_CODE).toBe("trusted")
    expect(Trust.allowsCode({ trusted: false, headless: false })).toBe(false)
    expect(Trust.allowsCode({ trusted: true, headless: false })).toBe(true)
    expect(Trust.allowsCode({ trusted: true, headless: true })).toBe(true)
    expect(Trust.allowsCode({ trusted: false, headless: false, mode: "interactive" })).toBe(true)
    expect(Trust.allowsCode({ trusted: false, headless: true, mode: "interactive" })).toBe(false)
  })
})

describe("rafikicode run without a terminal, with a model that asks for the shell", () => {
  let home: string
  let repo: string
  let marker: string
  let gateway: ReturnType<typeof createMockGateway>

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-headless-"))
    repo = path.join(home, "repo")
    fs.mkdirSync(repo)
    spawnSync("git", ["init", "-q"], { cwd: repo })
    // Inside the workspace, so only the shell permission is in question.
    marker = path.join(repo, "shell-ran")
    gateway = createMockGateway({
      quiet: true,
      toolCall: { name: "bash", arguments: { command: `touch '${marker}'`, description: "Create a marker file" } },
    })
    await gateway.ready
  })

  afterEach(async () => {
    await gateway.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function run(args: string[], extra: Record<string, string | undefined> = {}) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      COLUMNS: "120",
      // run takes its directory from PWD; the test runner's own would leak in.
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
    for (const k of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION", ...names]) delete env[k]
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", "--model", "rafiki/rafiki-fast", ...args], {
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

  const projectAllowsShell = () =>
    fs.writeFileSync(path.join(repo, "rafikicode.json"), JSON.stringify({ permission: { bash: "allow" }, agent: { build: { permission: { bash: { "*": "allow" } } } } }))
  const ran = () => fs.existsSync(marker)
  const shellCalls = () => gateway.requests.filter((r: any) => r.path === "/v1/chat/completions").length
  const CI = { CI: "1" }

  test("a first run in an empty directory, with no config and no git, runs the shell there", async () => {
    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true })
    const result = await run(["create the marker"])
    expect(result.all).not.toContain("auto-rejecting")
    expect(ran()).toBe(true)
    expect(result.all).not.toContain(KEY)
  }, 120_000)

  test("a project config cannot reach outside the directory for itself; the rejection prints a hint", async () => {
    const outside = path.join(home, "outside-ran")
    const reach = createMockGateway({
      quiet: true,
      toolCall: { name: "bash", arguments: { command: `touch '${outside}'`, workdir: home, description: "Create a marker outside" } },
    })
    await reach.ready
    try {
      fs.writeFileSync(path.join(repo, "opencode.json"), JSON.stringify({ permission: { external_directory: { "*": "allow" }, bash: "allow" } }))
      const result = await run(["create the marker outside"], { RAFIKICODE_GATEWAY_URL: reach.url + "/v1" })
      expect(result.stderr).toContain("Warning: ignored permission.external_directory.*, permission.bash in")
      expect(result.all).toContain("permission requested: external_directory")
      expect(result.all).toContain("Hint: external_directory was rejected because this run cannot ask for approval. Rerun with rafikicode run --auto")
      expect(fs.existsSync(outside)).toBe(false)
    } finally {
      await reach.close()
    }
  }, 120_000)

  test("in CI the shell asks, nobody answers, the command does not run; the project cannot allow it", async () => {
    projectAllowsShell()
    const result = await run(["create the marker"], CI)
    expect(shellCalls()).toBeGreaterThanOrEqual(1)
    expect(result.all).toContain("permission requested: bash")
    expect(result.all).toContain(`Hint: bash was rejected because this CI run cannot ask for approval. Rerun with rafikicode run --auto, or allow it in ~/.rafikicode/config.json`)
    expect(result.stderr).toContain("Warning: ignored permission.bash, agent.build.permission.bash.* in")
    expect(ran()).toBe(false)
    expect(result.all).not.toContain(KEY)
  }, 120_000)

  test("in CI, run --auto answers the question", async () => {
    const result = await run(["--auto", "create the marker"], CI)
    expect(result.all).not.toContain("auto-rejecting")
    expect(ran()).toBe(true)
  }, 120_000)

  test("in CI, global config and OPENCODE_PERMISSION allow it", async () => {
    fs.mkdirSync(path.join(home, ".rafikicode"), { recursive: true })
    fs.writeFileSync(path.join(home, ".rafikicode", "config.json"), JSON.stringify({ permission: { bash: "allow" } }))
    await run(["create the marker"], CI)
    expect(ran()).toBe(true)
    fs.rmSync(marker)
    fs.rmSync(path.join(home, ".rafikicode", "config.json"))
    await run(["create the marker"], { ...CI, OPENCODE_PERMISSION: JSON.stringify({ bash: "allow" }) })
    expect(ran()).toBe(true)
  }, 180_000)

  test("a trusted workspace keeps its own permission settings", async () => {
    projectAllowsShell()
    const result = await run(["create the marker"], { [Brand.env.trustWorkspace]: "1", CI: "1" })
    expect(result.stderr).not.toContain("Warning: ignored permission")
    expect(ran()).toBe(true)
  }, 120_000)
})
