// Project config substitution (docs/security/workspace-trust.md): an untrusted
// project file may read plain environment variables and files inside the
// project, but not secret named variables, the Rafiki key variable, or files
// elsewhere on the machine. Global config and trusted workspaces keep full
// substitution.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Guard from "@opencode-ai/core/brand/guard"
import * as Trust from "@opencode-ai/core/brand/trust"
import { ConfigVariable } from "../../src/config/variable"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { TuiConfig } from "../../src/config/tui"
import { CurrentWorkingDirectory } from "../../src/config/tui-cwd"

const loadTui = (directory: string) =>
  Effect.runPromise(
    TuiConfig.Service.use((svc) => svc.get()).pipe(
      Effect.provide(AppNodeBuilder.build(TuiConfig.node).pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, directory)))),
    ),
  )

const root = path.resolve(import.meta.dir, "../..")
const names = ["CI", "GITHUB_ACTIONS", Brand.env.headless, Brand.env.trustWorkspace, "SUBST_TOKEN", "SUBST_PLAIN"]
const saved: Record<string, string | undefined> = {}

let dir: string
let repo: string
let outside: string
let warnings: string[]
let restoreWarn: (m: string) => void

beforeEach(() => {
  for (const n of names) {
    saved[n] = process.env[n]
    delete process.env[n]
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-subst-"))
  repo = path.join(dir, "repo")
  fs.mkdirSync(path.join(repo, "sub"), { recursive: true })
  spawnSync("git", ["init", "-q"], { cwd: repo })
  fs.writeFileSync(path.join(repo, "inside.txt"), "inside-value\n")
  outside = path.join(dir, "outside-secret")
  fs.writeFileSync(outside, "outside-secret-value\n")
  fs.symlinkSync(outside, path.join(repo, "link.txt"))
  process.env["SUBST_TOKEN"] = "token-value"
  process.env["SUBST_PLAIN"] = "plain-value"
  warnings = []
  Trust.resetWarnings()
  restoreWarn = Trust.setWarn((m) => warnings.push(m))
})

afterEach(() => {
  Trust.setWarn(restoreWarn)
  for (const n of names) {
    if (saved[n] === undefined) delete process.env[n]
    else process.env[n] = saved[n]
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

const text = (outsidePath: string) =>
  JSON.stringify({
    a: "{env:SUBST_TOKEN}",
    b: "{env:SUBST_PLAIN}",
    c: "{env:RAFIKICODE_API_KEY}",
    d: "{file:./inside.txt}",
    e: `{file:${outsidePath}}`,
    f: "{file:./link.txt}",
    g: "{file:../outside-secret}",
  })

describe("substitution in project config", () => {
  test("secret names and the Rafiki key variable count as secrets; plain names do not", () => {
    for (const name of ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "MYSQL_PASSWD", "RAFIKICODE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "SSH_PRIVATE", "openai_api_key"]) {
      expect(Guard.secretEnvName(name), name).toBe(true)
    }
    for (const name of ["HOME", "PATH", "NODE_ENV", "SUBST_PLAIN", "PORT"]) expect(Guard.secretEnvName(name), name).toBe(false)
  })

  test("an untrusted project file gets plain variables and project files only, with a warning per reference", async () => {
    const source = path.join(repo, "rafikicode.json")
    const restrict = Guard.substitution(source, { directory: repo, worktree: repo })
    expect(restrict).toBeDefined()
    const out = JSON.parse(await ConfigVariable.substitute({ text: text(outside), type: "path", path: source, restrict }))
    expect(out).toEqual({ a: "", b: "plain-value", c: "", d: "inside-value", e: "", f: "", g: "" })
    const all = warnings.join("\n")
    for (const token of ["{env:SUBST_TOKEN}", "{env:RAFIKICODE_API_KEY}", `{file:${outside}}`, "{file:./link.txt}", "{file:../outside-secret}"]) {
      expect(all).toContain(`Warning: ignored ${token} in ${source}`)
    }
    expect(all).not.toContain("token-value")
    expect(all).not.toContain("outside-secret-value")
  })

  test("without a git worktree the working directory is the project root", async () => {
    const sub = path.join(repo, "sub")
    const source = path.join(sub, "rafikicode.json")
    const restrict = Guard.substitution(source, { directory: sub, worktree: "/" })
    const out = JSON.parse(
      await ConfigVariable.substitute({ text: JSON.stringify({ d: "{file:../inside.txt}" }), type: "path", path: source, restrict }),
    )
    expect(out.d).toBe("")
  })

  test("a trusted workspace and substitution without limits keep upstream behaviour", async () => {
    const source = path.join(repo, "rafikicode.json")
    process.env[Brand.env.trustWorkspace] = repo
    expect(Guard.substitution(source, { directory: repo, worktree: repo })).toBeUndefined()
    const out = JSON.parse(await ConfigVariable.substitute({ text: text(outside), type: "path", path: source }))
    expect(out).toMatchObject({ a: "token-value", b: "plain-value", d: "inside-value", e: "outside-secret-value", f: "outside-secret-value" })
    expect(warnings).toEqual([])
  })

  test("debug config: global config keeps {env:} and {file:}, the project file is limited", async () => {
    const home = path.join(dir, "home")
    fs.mkdirSync(path.join(home, ".rafikicode"), { recursive: true })
    const mcp = (name: string) => ({
      [name]: { type: "remote", url: "https://mcp.example.com/mcp", enabled: false, headers: { T: "{env:SUBST_TOKEN}", F: `{file:${outside}}`, P: "{env:SUBST_PLAIN}" } },
    })
    fs.writeFileSync(path.join(home, ".rafikicode", "config.json"), JSON.stringify({ mcp: mcp("global-mcp") }))
    fs.writeFileSync(path.join(repo, "rafikicode.json"), JSON.stringify({ mcp: mcp("project-mcp") }))
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      SUBST_TOKEN: "token-value",
      SUBST_PLAIN: "plain-value",
    }
    for (const k of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", Brand.env.trustWorkspace, Brand.env.headless]) delete env[k]
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "debug", "config"], {
      cwd: repo,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    expect(await proc.exited).toBe(0)
    const config = JSON.parse(stdout.slice(stdout.indexOf("{")))
    expect(config.mcp["global-mcp"].headers).toEqual({ T: "token-value", F: "outside-secret-value", P: "plain-value" })
    expect(config.mcp["project-mcp"].headers).toEqual({ T: "", F: "", P: "plain-value" })
    expect(stderr).toContain(`Warning: ignored {env:SUBST_TOKEN} in ${path.join(Trust.real(repo), "rafikicode.json")}`)
    expect(stdout + stderr).not.toContain("outside-secret-value\"}")
  }, 120_000)
})

describe("substitution limits for every config file kind", () => {
  const kinds = ["config.json", "rafikicode.json", "rafikicode.jsonc", "opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"]

  test("project files and directories, ~/.opencode and a checkout's home config are limited; the user's config directory is not", () => {
    const saved = { xdg: process.env["XDG_CONFIG_HOME"], home: process.env["OPENCODE_TEST_HOME"], dir: process.env["OPENCODE_CONFIG_DIR"] }
    const home = path.join(dir, "home")
    try {
      delete process.env["XDG_CONFIG_HOME"]
      delete process.env["OPENCODE_CONFIG_DIR"]
      process.env["OPENCODE_TEST_HOME"] = home
      fs.mkdirSync(path.join(home, ".rafikicode"), { recursive: true })
      fs.mkdirSync(path.join(home, ".opencode"), { recursive: true })
      const ctx = { directory: repo, worktree: repo }
      for (const kind of kinds) {
        for (const file of [path.join(repo, kind), path.join(repo, ".rafikicode", kind), path.join(repo, ".opencode", kind), path.join(repo, "sub", kind)]) {
          const restrict = Guard.fileSubstitution(file, ctx)
          expect(restrict, file).toBeDefined()
          expect(restrict!.env("GITHUB_TOKEN")).toBe(false)
          expect(restrict!.file(path.join(repo, "inside.txt"))).toBe(true)
          expect(restrict!.file(outside)).toBe(false)
        }
        expect(Guard.fileSubstitution(path.join(home, ".opencode", kind)), `~/.opencode/${kind}`).toBeDefined()
        expect(Guard.fileSubstitution(path.join(home, ".rafikicode", kind)), `~/.rafikicode/${kind}`).toBeUndefined()
      }
      // The terminal interface passes only its directory: the git root is found from it.
      expect(Guard.fileSubstitution(path.join(repo, "sub", "tui.json"), { directory: path.join(repo, "sub") })!.file(path.join(repo, "inside.txt"))).toBe(true)
      process.env["OPENCODE_CONFIG_DIR"] = path.join(repo, ".rafikicode")
      expect(Guard.fileSubstitution(path.join(repo, ".rafikicode", "tui.json"), ctx)).toBeUndefined()
      delete process.env["OPENCODE_CONFIG_DIR"]
      // HOME is a git checkout: its ~/.rafikicode came with the repository.
      spawnSync("git", ["init", "-q"], { cwd: home })
      for (const kind of kinds) {
        const restrict = Guard.fileSubstitution(path.join(home, ".rafikicode", kind))
        expect(restrict, `checkout ~/.rafikicode/${kind}`).toBeDefined()
        expect(restrict!.env(Brand.env.apiKey)).toBe(false)
        expect(restrict!.file(path.join(home, "notes.txt"))).toBe(true)
        expect(restrict!.file(outside)).toBe(false)
      }
      process.env[Brand.env.trustWorkspace] = home
      expect(Guard.fileSubstitution(path.join(home, ".rafikicode", "config.json"))).toBeUndefined()
    } finally {
      for (const [name, value] of [["XDG_CONFIG_HOME", saved.xdg], ["OPENCODE_TEST_HOME", saved.home], ["OPENCODE_CONFIG_DIR", saved.dir]] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  test("the terminal interface config loader limits project tui.json files and keeps the global one", async () => {
    const globalTui = path.join(Global.Path.config, "tui.json")
    const theme = (value: string) => JSON.stringify({ theme: value })
    try {
      // A project tui.json: a plain variable resolves, a secret named one is empty.
      fs.writeFileSync(path.join(repo, "tui.json"), theme("a{env:SUBST_PLAIN}b{env:SUBST_TOKEN}c"))
      expect((await loadTui(repo)).theme).toBe("aplain-valuebc")
      fs.rmSync(path.join(repo, "tui.json"))
      // A tui.json in the project's .rafikicode directory: no file outside the project.
      fs.mkdirSync(path.join(repo, ".rafikicode"), { recursive: true })
      fs.writeFileSync(path.join(repo, ".rafikicode", "tui.json"), theme(`x{file:${outside}}y{file:../inside.txt}z`))
      expect((await loadTui(repo)).theme).toBe("xyinside-valuez")
      fs.rmSync(path.join(repo, ".rafikicode"), { recursive: true })
      const all = warnings.join("\n")
      expect(all).toContain(`Warning: ignored {env:SUBST_TOKEN} in ${path.join(repo, "tui.json")}`)
      expect(all).toContain(`Warning: ignored {file:${outside}} in ${path.join(repo, ".rafikicode", "tui.json")}`)
      expect(all).not.toContain("token-value")
      // The user's own tui.json keeps full substitution.
      fs.mkdirSync(Global.Path.config, { recursive: true })
      fs.writeFileSync(globalTui, theme(`x{file:${outside}}y{env:SUBST_TOKEN}`))
      expect((await loadTui(repo)).theme).toBe("xoutside-secret-valueytoken-value")
    } finally {
      fs.rmSync(globalTui, { force: true })
    }
  }, 60_000)

  test("debug config: HOME set to a checkout limits its .rafikicode config.json, opencode.json and rafikicode.json", async () => {
    const headers = { T: "{env:SUBST_TOKEN}", F: `{file:${outside}}`, P: "{env:SUBST_PLAIN}" }
    const mcp = (name: string) => ({ mcp: { [name]: { type: "remote", url: "https://mcp.example.com/mcp", enabled: false, headers } } })
    fs.mkdirSync(path.join(repo, ".rafikicode"), { recursive: true })
    fs.writeFileSync(path.join(repo, ".rafikicode", "config.json"), JSON.stringify(mcp("home-config")))
    fs.writeFileSync(path.join(repo, ".rafikicode", "opencode.json"), JSON.stringify(mcp("home-opencode")))
    fs.writeFileSync(path.join(repo, ".rafikicode", "rafikicode.json"), JSON.stringify(mcp("home-rafikicode")))
    const xdg = path.join(dir, "xdg")
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: repo,
      OPENCODE_TEST_HOME: repo,
      XDG_DATA_HOME: path.join(xdg, "share"),
      XDG_STATE_HOME: path.join(xdg, "state"),
      XDG_CACHE_HOME: path.join(xdg, "cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      SUBST_TOKEN: "token-value",
      SUBST_PLAIN: "plain-value",
    }
    for (const k of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", Brand.env.trustWorkspace, Brand.env.headless]) delete env[k]
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "debug", "config"], {
      cwd: repo,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    expect(await proc.exited).toBe(0)
    const config = JSON.parse(stdout.slice(stdout.indexOf("{")))
    for (const name of ["home-config", "home-opencode", "home-rafikicode"]) {
      expect(config.mcp[name]?.headers, name).toEqual({ T: "", F: "", P: "plain-value" })
    }
    const home = path.join(Trust.real(repo), ".rafikicode")
    expect(stderr).toContain(`Warning: ignored {env:SUBST_TOKEN} in ${path.join(home, "config.json")}`)
    expect(stderr).toContain(`Warning: ignored {file:${outside}} in ${path.join(home, "opencode.json")}`)
    expect(stdout + stderr).not.toContain("token-value")
    expect(stdout + stderr).not.toContain("outside-secret-value")
  }, 120_000)
})
