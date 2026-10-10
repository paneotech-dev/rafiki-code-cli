// `rafikicode github` without a terminal, with real git and the fake gh of
// packages/core/test/brand/fake-gh on PATH: nothing reaches GitHub.
import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"

const root = path.resolve(import.meta.dir, "../..")
const FAKE = path.resolve(root, "../core/test/brand/fake-gh")
let base: string
let project: string

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-github-command-")))
  project = path.join(base, "site")
  fs.mkdirSync(project)
  fs.writeFileSync(path.join(project, "index.html"), "<h1>site</h1>\n")
  fs.writeFileSync(path.join(base, "gitconfig"), "")
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

async function github(...args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${FAKE}${path.delimiter}${process.env.PATH}`,
    HOME: base,
    OPENCODE_TEST_HOME: base,
    XDG_DATA_HOME: path.join(base, ".local/share"),
    XDG_STATE_HOME: path.join(base, ".local/state"),
    XDG_CACHE_HOME: path.join(base, ".cache"),
    XDG_CONFIG_HOME: path.join(base, ".config"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    FAKE_GH_ROOT: path.join(base, "gh"),
    GIT_CONFIG_GLOBAL: path.join(base, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  }
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "github", ...args], {
    cwd: project,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { exitCode: await proc.exited, stdout, stderr }
}

test("without a terminal and without --yes: stops at the first step and says how to go on", async () => {
  const result = await github()
  expect(result.exitCode).toBe(1)
  expect(result.stdout).toContain("is not a git repository yet. Create one here?")
  expect(result.stdout).toContain("No terminal to answer in: rerun with --yes to accept every step.")
  expect(fs.existsSync(path.join(project, ".git"))).toBe(false)
}, 120_000)

test("--yes --name: a private repository, pushed, with its address and the next steps", async () => {
  const result = await github("--yes", "--name", "my-site")
  expect(result.stderr).toBe("")
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("Create the private repository tester/my-site on GitHub and add it as origin? yes (--yes)")
  expect(result.stdout).toContain("Done: https://github.com/tester/my-site")
  expect(result.stdout).toContain("docs/github.md#deploy-to-a-server")
  const remote = path.join(base, "gh/remotes/my-site.git")
  expect(spawnSync("git", ["rev-parse", "--verify", "main"], { cwd: remote }).status).toBe(0)
}, 120_000)

test("an invalid --name is a usage error", async () => {
  const result = await github("--yes", "--name", "my site")
  expect(result.exitCode).toBe(2)
  expect(result.stderr).toContain("--name")
}, 120_000)
