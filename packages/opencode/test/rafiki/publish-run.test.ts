// `rafikicode run` and a push asked for by the model, end to end against the
// mock gateway: the gateway answers the first request with a shell call that
// pushes to a bare repository on disk (never a real remote), then with text.
// The push is refused, --auto or not, unless the run allows it with
// --allow-push, RAFIKICODE_ALLOW_PUSH=1 or "publish": "allow" in its config.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const KEY = "sk-publish-run-stub"

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

describe("rafikicode run and a push the model asks for", () => {
  let home: string
  let repo: string
  let remote: string
  let gateway: ReturnType<typeof createMockGateway>

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-publish-run-"))
    repo = path.join(home, "repo")
    remote = path.join(home, "remote.git")
    fs.mkdirSync(repo)
    git(home, "init", "-q", "--bare", remote)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "Test")
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n")
    git(repo, "add", "a.txt")
    git(repo, "commit", "-q", "-m", "first")
    git(repo, "remote", "add", "origin", remote)
  })

  afterEach(async () => {
    await gateway?.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function run(command: string, args: string[], extra: Record<string, string | undefined> = {}) {
    gateway = createMockGateway({
      quiet: true,
      toolCall: { name: "bash", arguments: { command, description: "Push the branch" } },
    })
    await gateway.ready
    const env: Record<string, string | undefined> = {
      ...process.env,
      COLUMNS: "120",
      PWD: repo,
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      RAFIKICODE_GATEWAY_URL: gateway.url + "/v1",
      RAFIKICODE_API_KEY: KEY,
    }
    for (const k of ["CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION", "RAFIKICODE_ALLOW_PUSH", Brand.env.headless, Brand.env.trustWorkspace]) delete env[k]
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", ...args, "--model", "rafiki/rafiki-fast", "Push the branch."], {
      cwd: repo,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { exitCode, all: stdout + stderr }
  }

  const pushed = () => spawnSync("git", ["rev-parse", "--verify", "-q", "refs/heads/main"], { cwd: remote, encoding: "utf8" }).status === 0

  test("refused by default, with the way to allow it", async () => {
    const result = await run("git push origin main", [])
    expect(pushed()).toBe(false)
    expect(result.all).toContain("refused to publish code: git push")
    expect(result.all).toContain("--allow-push")
    expect(result.all).toContain("RAFIKICODE_ALLOW_PUSH=1")
    expect(result.exitCode).not.toBe(0)
  }, 180_000)

  test("refused with --auto, and in compound commands and env prefixes", async () => {
    const result = await run("echo ready && env GIT_TERMINAL_PROMPT=0 git -C . push --force origin main", ["--auto"])
    expect(pushed()).toBe(false)
    expect(result.all).toContain("refused to publish code: git push (force)")
  }, 180_000)

  test("--allow-push lets it through", async () => {
    const result = await run("git push origin main", ["--allow-push"])
    expect(result.all).not.toContain("refused to publish code")
    expect(pushed()).toBe(true)
  }, 180_000)

  test("RAFIKICODE_ALLOW_PUSH=1 lets it through", async () => {
    await run("git push origin main", [], { RAFIKICODE_ALLOW_PUSH: "1" })
    expect(pushed()).toBe(true)
  }, 180_000)

  test('"publish": "allow" in the config lets it through', async () => {
    await run("git push origin main", [], { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { publish: "allow" } }) })
    expect(pushed()).toBe(true)
  }, 180_000)

  test("a wildcard allow in the config does not", async () => {
    const result = await run("git push origin main", [], { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "allow" }) })
    expect(pushed()).toBe(false)
    expect(result.all).toContain("refused to publish code")
  }, 180_000)
})
