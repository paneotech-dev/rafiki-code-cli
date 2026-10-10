// The guided GitHub setup with real git and a fake gh on PATH (fake-gh/gh):
// nothing reaches GitHub. Repositories the fake creates are bare
// repositories in a temporary folder.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import * as GithubSetup from "../../src/brand/github-setup"

const FAKE = path.join(import.meta.dir, "fake-gh")
const saved = { ...process.env }
let base: string
let project: string
let ghRoot: string

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" })
}

type Script = { confirm?: boolean[]; ask?: (string | undefined)[] }

function io(script: Script = {}, overrides: Partial<GithubSetup.Io> = {}) {
  const said: string[] = []
  const questions: string[] = []
  const confirms = [...(script.confirm ?? [])]
  const asks = [...(script.ask ?? [])]
  const value: GithubSetup.Io = {
    ...GithubSetup.defaults(),
    cwd: project,
    home: base,
    guide: "https://example.test/docs/github.md#deploy-to-a-server",
    say: (text) => void said.push(text),
    confirm: async (question) => {
      questions.push(question)
      return confirms.length ? confirms.shift()! : true
    },
    ask: async (question, suggested) => {
      questions.push(`${question} [${suggested}]`)
      return asks.length ? asks.shift() : suggested
    },
    ...overrides,
  }
  return { io: value, said, questions }
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-github-setup-")))
  project = path.join(base, "My Shop")
  ghRoot = path.join(base, "gh")
  fs.mkdirSync(project)
  fs.writeFileSync(path.join(base, "gitconfig"), "")
  process.env.PATH = `${FAKE}${path.delimiter}${saved.PATH}`
  process.env.FAKE_GH_ROOT = ghRoot
  process.env.GIT_CONFIG_GLOBAL = path.join(base, "gitconfig")
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test"
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.com"
  delete process.env.FAKE_GH_AUTH
})

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  fs.rmSync(base, { recursive: true, force: true })
})

describe("the whole flow", () => {
  test("a plain folder: init, scan, first commit, private repository, push, URL and next steps", async () => {
    fs.writeFileSync(path.join(project, "index.html"), "<h1>shop</h1>\n")
    fs.mkdirSync(path.join(project, "node_modules/pkg"), { recursive: true })
    fs.writeFileSync(path.join(project, "node_modules/pkg/index.js"), "module.exports = 1\n")
    const { io: value, said, questions } = io()
    const outcome = await GithubSetup.run(value)
    expect(outcome.status).toBe("done")
    expect(outcome.status === "done" && outcome.url).toBe("https://github.com/tester/My-Shop")
    expect(questions).toEqual([
      `${project} is not a git repository yet. Create one here?`,
      `Commit the 2 files in ${project} as the first commit ("Initial commit")?`,
      "Name of the new private repository on GitHub [My-Shop]",
      "Create the private repository tester/My-Shop on GitHub and add it as origin?",
      expect.stringMatching(/^Push the branch main to origin \(.*My-Shop\.git\)\?$/),
    ])
    expect(said).toContain("GitHub CLI signed in as tester.")
    expect(said.some((line) => line.includes("node_modules"))).toBe(true)
    expect(fs.readFileSync(path.join(project, ".gitignore"), "utf8")).toContain("/node_modules/")
    // The fake remote got the branch, with the files and without node_modules.
    const remote = path.join(ghRoot, "remotes/My-Shop.git")
    const files = git(remote, "ls-tree", "-r", "--name-only", "main").stdout.trim().split("\n")
    expect(files.sort()).toEqual([".gitignore", "index.html"])
    // Private, every time.
    const calls = fs.readFileSync(path.join(ghRoot, "calls.log"), "utf8")
    expect(calls).toContain("repo create My-Shop --private --source")
    expect(outcome.message).toContain("Pull request:")
    expect(outcome.message).toContain("Deploy to a server: pull-based deploy is recommended, GitHub Actions over SSH is the alternative")
  })

  test("a repository with a remote already: no new repository, a push after a yes", async () => {
    git(project, "init", "-q", "-b", "main")
    fs.writeFileSync(path.join(project, "a.txt"), "a\n")
    git(project, "add", "a.txt")
    git(project, "commit", "-q", "-m", "a")
    const remote = path.join(base, "remote.git")
    git(base, "init", "-q", "--bare", remote)
    git(project, "remote", "add", "origin", remote)
    const { io: value, questions } = io()
    const outcome = await GithubSetup.run(value)
    expect(outcome.status).toBe("done")
    expect(questions).toEqual([`Push the branch main to origin (${remote})?`])
    expect(git(remote, "rev-parse", "main").status).toBe(0)
  })

  test("a feature branch: offers the pull request and reports its address", async () => {
    git(project, "init", "-q", "-b", "main")
    fs.writeFileSync(path.join(project, "a.txt"), "a\n")
    git(project, "add", "a.txt")
    git(project, "commit", "-q", "-m", "a")
    git(project, "switch", "-q", "-c", "feature")
    const remote = path.join(base, "shop.git")
    git(base, "init", "-q", "--bare", remote)
    git(project, "remote", "add", "origin", remote)
    const { io: value, questions } = io()
    const outcome = await GithubSetup.run(value)
    expect(questions.at(-1)).toBe("Open a pull request from feature into main?")
    expect(outcome.message).toContain("Pull request: https://github.com/tester/shop/pull/1")
  })

  test("each no stops there and changes nothing more", async () => {
    fs.writeFileSync(path.join(project, "a.txt"), "a\n")
    let result = await GithubSetup.run(io({ confirm: [false] }).io)
    expect(result.status).toBe("cancelled")
    expect(fs.existsSync(path.join(project, ".git"))).toBe(false)

    result = await GithubSetup.run(io({ confirm: [true, false] }).io)
    expect(result.status).toBe("cancelled")
    expect(git(project, "rev-parse", "--verify", "-q", "HEAD").status).not.toBe(0)

    result = await GithubSetup.run(io({ confirm: [true, false] }).io)
    expect(result.status).toBe("cancelled")
    expect(fs.existsSync(path.join(ghRoot, "remotes/My-Shop.git"))).toBe(false)

    result = await GithubSetup.run(io({ confirm: [true, false] }).io)
    expect(result.status).toBe("cancelled")
    expect(result.message).toContain("The repository was created on GitHub; nothing was pushed.")
    expect(git(path.join(ghRoot, "remotes/My-Shop.git"), "rev-parse", "--verify", "-q", "main").status).not.toBe(0)
  })

  test("a changed name is used, and an invalid one is asked again", async () => {
    fs.writeFileSync(path.join(project, "a.txt"), "a\n")
    const { io: value, said } = io({ ask: ["my shop!", "shop-site"] })
    const outcome = await GithubSetup.run(value)
    expect(said).toContain("A repository name uses letters, digits, '.', '-' and '_' only, up to 100 characters.")
    expect(outcome.status === "done" && outcome.url).toBe("https://github.com/tester/shop-site")
  })

  test("a name that exists on GitHub stops with gh's reason", async () => {
    fs.writeFileSync(path.join(project, "a.txt"), "a\n")
    fs.mkdirSync(path.join(ghRoot, "remotes/My-Shop.git"), { recursive: true })
    const outcome = await GithubSetup.run(io().io)
    expect(outcome.status).toBe("stopped")
    expect(outcome.message).toBe("gh repo create failed: GraphQL: Name already exists on this account (createRepository)")
  })
})

describe("checks before anything changes", () => {
  test("gh missing: how to install it on each system, then sign in", async () => {
    const empty = path.join(base, "bin")
    fs.mkdirSync(empty)
    const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()
    fs.symlinkSync(gitPath, path.join(empty, "git"))
    process.env.PATH = empty
    for (const [platform, expected] of [
      ["linux", "sudo apt install gh"],
      ["darwin", "brew install gh"],
      ["win32", "winget install --id GitHub.cli -e"],
    ] as const) {
      const outcome = await GithubSetup.run(io({}, { platform }).io)
      expect(outcome.status).toBe("stopped")
      expect(outcome.message).toContain(expected)
      expect(outcome.message).toContain("gh auth login")
    }
    expect(fs.existsSync(path.join(project, ".git"))).toBe(false)
  })

  test("git missing: how to install it", async () => {
    process.env.PATH = path.join(base, "nothing")
    expect((await GithubSetup.run(io({}, { platform: "win32" }).io)).message).toContain("winget install --id Git.Git -e")
    expect((await GithubSetup.run(io({}, { platform: "darwin" }).io)).message).toContain("xcode-select --install")
    expect((await GithubSetup.run(io({}, { platform: "linux" }).io)).message).toContain("sudo apt install git")
  })

  test("gh not signed in: says how, per system", async () => {
    process.env.FAKE_GH_AUTH = "0"
    const outcome = await GithubSetup.run(io({}, { platform: "win32" }).io)
    expect(outcome.status).toBe("stopped")
    expect(outcome.message).toContain("In a PowerShell window, run:\n  gh auth login")
    expect(outcome.message).toContain("Login with a web browser")
  })

  test("the home folder is never made a repository", async () => {
    const outcome = await GithubSetup.run(io({}, { cwd: base, home: base }).io)
    expect(outcome.status).toBe("stopped")
    expect(outcome.message).toContain("home folder")
    expect(fs.existsSync(path.join(base, ".git"))).toBe(false)
  })

  test("git without a name and email: says how to set them", async () => {
    delete process.env.GIT_AUTHOR_NAME
    delete process.env.GIT_AUTHOR_EMAIL
    delete process.env.GIT_COMMITTER_NAME
    delete process.env.GIT_COMMITTER_EMAIL
    process.env.EMAIL = ""
    fs.writeFileSync(path.join(base, "gitconfig"), "[user]\n\tuseConfigOnly = true\n")
    fs.writeFileSync(path.join(project, "a.txt"), "a\n")
    const outcome = await GithubSetup.run(io().io)
    expect(outcome.status).toBe("stopped")
    expect(outcome.message).toContain('git config --global user.email "you@example.com"')
  })
})

describe("secrets", () => {
  test(".env and a key file: added to .gitignore, listed, nothing pushed; the next run goes through", async () => {
    fs.writeFileSync(path.join(project, "index.js"), "console.log(1)\n")
    fs.writeFileSync(path.join(project, ".env"), "DB_PASSWORD=hunter2\n")
    fs.writeFileSync(path.join(project, ".env.example"), "DB_PASSWORD=\n")
    fs.writeFileSync(path.join(project, "deploy.pem"), "x\n")
    const first = await GithubSetup.run(io().io)
    expect(first.status).toBe("stopped")
    expect(first.message).toContain("Nothing was pushed: these look like secrets.")
    expect(first.message).toContain("  .env: environment file")
    expect(first.message).toContain("  deploy.pem: private key or certificate file")
    expect(first.message).not.toContain(".env.example:")
    expect(first.message).not.toContain("hunter2")
    const ignore = fs.readFileSync(path.join(project, ".gitignore"), "utf8")
    expect(ignore).toContain(".env\n.env.*\n!.env.example\n/deploy.pem\n")
    expect(fs.existsSync(path.join(ghRoot, "remotes/My-Shop.git"))).toBe(false)

    const second = await GithubSetup.run(io().io)
    expect(second.status).toBe("done")
    const files = git(path.join(ghRoot, "remotes/My-Shop.git"), "ls-tree", "-r", "--name-only", "main").stdout
    expect(files).not.toContain(".env\n")
    expect(files).toContain(".env.example")
    expect(files).not.toContain("deploy.pem")
  })

  test("tokens inside files: file and line, never the value; an allowed line is skipped", async () => {
    const token = "ghp_" + "a".repeat(36)
    const key = "-----BEGIN OPENSSH " + "PRIVATE KEY-----"
    fs.writeFileSync(path.join(project, "config.js"), `const a = 1\nconst token = "${token}"\n`)
    fs.writeFileSync(path.join(project, "notes.txt"), `${key}\n`)
    fs.writeFileSync(path.join(project, "test.js"), `const fake = "sk-${"b".repeat(30)}" // ${GithubSetup.ALLOW_MARK}\n`)
    const outcome = await GithubSetup.run(io().io)
    expect(outcome.status).toBe("stopped")
    expect(outcome.message).toContain("  config.js:2: GitHub token")
    expect(outcome.message).toContain("  notes.txt:1: private key")
    expect(outcome.message).not.toContain("test.js")
    expect(outcome.message).not.toContain(token)
    expect(fs.existsSync(path.join(project, ".gitignore"))).toBe(false)
  })

  test("a committed .env: tells how to stop tracking it", async () => {
    git(project, "init", "-q", "-b", "main")
    fs.writeFileSync(path.join(project, ".env"), "A=1\n")
    git(project, "add", ".env")
    git(project, "commit", "-q", "-m", "oops")
    const outcome = await GithubSetup.run(io().io)
    expect(outcome.status).toBe("stopped")
    expect(outcome.message).toContain("git rm --cached .env")
  })

  test("a secret file in an earlier commit is reported", async () => {
    git(project, "init", "-q", "-b", "main")
    fs.writeFileSync(path.join(project, "id_rsa"), "x\n")
    git(project, "add", "id_rsa")
    git(project, "commit", "-q", "-m", "oops")
    git(project, "rm", "-q", "id_rsa")
    git(project, "commit", "-q", "-m", "remove")
    const outcome = await GithubSetup.run(io().io)
    expect(outcome.status).toBe("stopped")
    expect(outcome.message).toContain("  id_rsa: private key or certificate file, in an earlier commit")
  })

  test.each([
    [".env", "environment file"],
    [".env.local", "environment file"],
    ["prod.env", "environment file"],
    ["config/.env.production", "environment file"],
    ["server.key", "private key or certificate file"],
    ["certs/site.pfx", "private key or certificate file"],
    ["id_ed25519", "private key or certificate file"],
    [".netrc", "credentials file"],
    [".env.example", undefined],
    [".env.sample", undefined],
    ["id_ed25519.pub", undefined],
    ["environment.ts", undefined],
  ])("file name %s", (file, kind) => {
    expect(GithubSetup.secretFileKind(file)).toBe(kind as string | undefined)
  })
})

test("names and addresses", () => {
  expect(GithubSetup.suggestName("/home/a/My Shop")).toBe("My-Shop")
  expect(GithubSetup.suggestName("/home/a/Café déjà")).toBe("Cafe-deja")
  expect(GithubSetup.suggestName("/home/a/...")).toBe("my-project")
  expect(GithubSetup.validName("shop.site_2-x")).toBe(true)
  expect(GithubSetup.validName("my shop")).toBe(false)
  expect(GithubSetup.validName("..")).toBe(false)
  expect(GithubSetup.webUrl("git@github.com:me/shop.git")).toBe("https://github.com/me/shop")
  expect(GithubSetup.webUrl("https://github.com/me/shop.git")).toBe("https://github.com/me/shop")
  expect(GithubSetup.webUrl("/tmp/x.git")).toBeUndefined()
})
