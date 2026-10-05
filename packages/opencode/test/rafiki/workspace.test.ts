// The default workspace, and the bound on the working tree snapshot.
//
// Reported on Windows: `rafikicode run "say hello"` started in the home folder
// printed its first line and hung, while the same command answered at once
// from an empty folder. The gateway saw the title request and never the main
// one. On Linux the same hang reproduces in a directory that is a git
// repository with tens of thousands of untracked files: the snapshot taken
// before the first model request staged them one pathspec each, which grows
// with the square of the count.
//
// Each run below is the real entry point against the mock gateway, with HOME
// set to a temporary directory, so "the home folder" is one the test owns.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { createMockGateway } from "../brand/mock-gateway.mjs"
import * as Workspace from "../../src/rafiki/workspace"
import { MAX_FILES } from "../../src/snapshot"

const root = path.resolve(import.meta.dir, "../..")
const KEY = "sk-workspace-stub"

// A probe that answers as a folder would, without touching the disk.
function fake(answers: Partial<Workspace.Probe> & { files?: number } = {}): Workspace.Probe {
  return {
    access: answers.access ?? (async () => "ok"),
    repository: answers.repository ?? (() => false),
    inRepository: answers.inRepository ?? (() => false),
    count:
      answers.count ??
      (async (_dir, limit) => (answers.files !== undefined && answers.files >= limit ? { files: limit, done: false } : { files: answers.files ?? 10, done: true })),
    free: answers.free ?? (() => 10 * 1024 * 1024 * 1024),
  }
}

describe("the folder doctor: the start folder", () => {
  const base: Workspace.Input = {
    command: "run",
    cwd: "/home/ana",
    home: "/home/ana",
    env: {},
    platform: "linux",
    probe: fake(),
  }
  const moved = async (input: Partial<Workspace.Input>) => (await Workspace.decide({ ...base, ...input }))?.directory

  test("the home folder and a filesystem root move to <home>/RafikiCode, with one line that says so", async () => {
    expect(await Workspace.decide(base)).toEqual({
      directory: "/home/ana/RafikiCode",
      finding: "the start folder is your home folder",
      message: "Working in /home/ana/RafikiCode (started from your home folder). Run rafikicode inside a project folder to work on it.",
    })
    expect(await moved({ cwd: "/home/ana/" })).toBe("/home/ana/RafikiCode")
    expect((await Workspace.decide({ ...base, cwd: "/" }))?.message).toBe(
      "Working in /home/ana/RafikiCode (started from /, the root of the file system). Run rafikicode inside a project folder to work on it.",
    )
    // The interface as well as run.
    expect(await moved({ command: undefined })).toBe("/home/ana/RafikiCode")
    // Already in the workspace: nothing to do.
    expect(await moved({ cwd: "/home/ana/RafikiCode" })).toBeUndefined()
  })

  test("system folders, Desktop, Downloads and OneDrive roots are not projects", async () => {
    for (const cwd of ["/usr", "/usr/lib/x86_64-linux-gnu", "/etc", "/root", "/var", "/home/ana/Desktop", "/home/ana/Downloads"])
      expect({ cwd, to: await moved({ cwd }) }).toEqual({ cwd, to: "/home/ana/RafikiCode" })
    // A project below them is a project.
    for (const cwd of ["/home/ana/Downloads/app", "/var/www/site", "/root/project", "/opt/tool"])
      expect({ cwd, to: await moved({ cwd }) }).toEqual({ cwd, to: undefined })
    expect((await Workspace.decide({ ...base, cwd: "/home/ana/Downloads" }))?.message).toContain("your Downloads folder")
    expect(await moved({ cwd: "/Library/Caches", platform: "darwin" })).toBe("/home/ana/RafikiCode")
  })

  test("on Windows: the profile folder in any case, a drive root, Windows, Program Files and OneDrive", async () => {
    const win: Partial<Workspace.Input> = {
      platform: "win32",
      home: "C:\\Users\\Ana",
      env: {
        SystemRoot: "C:\\Windows",
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        OneDrive: "C:\\Users\\Ana\\OneDrive - Paneo",
      },
    }
    const to = "C:\\Users\\Ana\\RafikiCode"
    for (const cwd of [
      "C:\\Users\\Ana",
      "c:\\users\\ana\\",
      "D:\\",
      "C:\\",
      "C:\\Windows\\System32",
      "C:\\Program Files\\Git",
      "C:\\Users\\Ana\\OneDrive - Paneo",
      "C:\\Users\\Ana\\OneDrive",
      "C:\\Users\\Ana\\OneDrive - Paneo\\Desktop",
      "C:\\Users\\Ana\\Desktop",
      "\\\\server\\share\\",
    ])
      expect({ cwd, to: await moved({ ...win, cwd }) }).toEqual({ cwd, to })
    for (const cwd of ["C:\\Users\\Ana\\code\\app", "C:\\Users\\Ana\\OneDrive - Paneo\\Projets\\site", "D:\\work"])
      expect({ cwd, to: await moved({ ...win, cwd }) }).toEqual({ cwd, to: undefined })
    expect((await Workspace.decide({ ...base, ...win, cwd: "D:\\" }))?.message).toBe(
      `Working in ${to} (started from D:\\, the root of a drive). Run rafikicode inside a project folder to work on it.`,
    )
  })

  test("a folder that was deleted, cannot be written, or does not answer moves too", async () => {
    const cwd = "/home/ana/project"
    expect((await Workspace.decide({ ...base, cwd, probe: fake({ access: async () => "missing" }) }))?.message).toContain(
      "the folder you started in no longer exists",
    )
    expect((await Workspace.decide({ ...base, cwd, probe: fake({ access: async () => "unwritable" }) }))?.message).toContain(
      "which this account cannot write to",
    )
    expect((await Workspace.decide({ ...base, cwd, probe: fake({ access: async () => "unreachable" }) }))?.message).toContain(
      "perhaps a disconnected network drive",
    )
  })

  test("a folder too big to be a project moves, unless it is in a git repository", async () => {
    const cwd = "/data/everything"
    const big = fake({ files: Workspace.TOO_MANY_FILES })
    expect((await Workspace.decide({ ...base, cwd, probe: big }))?.message).toContain("which holds more than 50,000 files and is not a git repository")
    expect(await moved({ cwd, probe: fake({ files: Workspace.TOO_MANY_FILES, inRepository: () => true }) })).toBeUndefined()
    expect(await moved({ cwd, probe: fake({ files: 400 }) })).toBeUndefined()
  })

  test("the real probe: the count stops at its limit, skips node_modules, and a missing folder is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-count-"))
    try {
      fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true })
      for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, "node_modules", "pkg", `f${i}`), "")
      for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `f${i}`), "")
      expect(await Workspace.realProbe.count(dir, 100, 2000)).toEqual({ files: 5, done: true })
      expect(await Workspace.realProbe.count(dir, 3, 2000)).toEqual({ files: 3, done: false })
      expect(await Workspace.realProbe.access(dir)).toBe("ok")
      expect(await Workspace.realProbe.access(path.join(dir, "gone"))).toBe("missing")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("paths with spaces, accents and long Windows paths are handled like any other", async () => {
    const home = "/home/Zoë Müller"
    expect(await moved({ home, cwd: home })).toBe("/home/Zoë Müller/RafikiCode")
    expect(await moved({ home, cwd: "/home/Zoë Müller/projets/été 2026" })).toBeUndefined()
    const long = "C:\\Users\\Ana\\" + Array.from({ length: 30 }, (_, i) => `dossier numéro ${i}`).join("\\")
    expect(long.length).toBeGreaterThan(260)
    expect(await moved({ platform: "win32", home: "C:\\Users\\Ana", cwd: long, env: {} })).toBeUndefined()
  })

  test("a disk nearly full where the workspace lives gets one clear warning", () => {
    expect(Workspace.diskWarning("/home/ana/RafikiCode", fake({ free: () => 120 * 1024 * 1024 }))).toBe(
      "Only 120 MB free on the disk holding /home/ana/RafikiCode. rafikicode saves sessions and checkpoints there; free some space so they do not fail.",
    )
    expect(Workspace.diskWarning("/home/ana/RafikiCode", fake())).toBeUndefined()
  })

  test("a directory the user named always wins, and the opt out is honoured", async () => {
    expect(await Workspace.decide({ ...base, explicit: "." })).toBeUndefined()
    expect(await Workspace.decide({ ...base, command: undefined, explicit: "." })).toBeUndefined()
    expect(await Workspace.decide({ ...base, env: { RAFIKICODE_NO_DEFAULT_WORKSPACE: "1" } })).toBeUndefined()
    expect(await Workspace.decide({ ...base, attach: true })).toBeUndefined()
  })

  test("a home folder that is itself a git repository, a project folder, and every other command are left alone", async () => {
    expect(await moved({ probe: fake({ repository: () => true }) })).toBeUndefined()
    expect(await moved({ cwd: "/home/ana/project" })).toBeUndefined()
    for (const command of ["doctor", "login", "models", "serve", "attach", "usage"])
      expect(await Workspace.decide({ ...base, command })).toBeUndefined()
  })
})

describe("rafikicode run from the home folder, against the mock gateway", () => {
  let home: string
  let gateway: ReturnType<typeof createMockGateway>

  beforeEach(async () => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-workspace-")))
    gateway = createMockGateway({ quiet: true })
    await gateway.ready
  })

  afterEach(async () => {
    await gateway.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function run(cwd: string, args: string[], extra: Record<string, string | undefined> = {}) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      COLUMNS: "120",
      PWD: cwd,
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      RAFIKICODE_DISABLE_AUTOUPDATE: "1",
      RAFIKICODE_GATEWAY_URL: gateway.url + "/v1",
      RAFIKICODE_API_KEY: KEY,
    }
    for (const k of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", Workspace.OPT_OUT])
      delete env[k]
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const started = Date.now()
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", "--model", "rafiki/rafiki-fast", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { exitCode, stdout, stderr, all: stdout + stderr, seconds: (Date.now() - started) / 1000 }
  }

  const chats = () => gateway.requests.filter((r: any) => r.path === "/v1/chat/completions").length
  const workspace = () => path.join(home, Workspace.FOLDER)
  const LINE = (dir: string) =>
    `Working in ${dir} (started from your home folder). Run rafikicode inside a project folder to work on it.`

  test("works in ~/RafikiCode, creates it private, and says so on stderr only", async () => {
    const result = await run(home, ["say hello"])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain(LINE(workspace()))
    expect(result.stdout).not.toContain("Working in")
    expect(fs.statSync(workspace()).isDirectory()).toBe(true)
    if (process.platform !== "win32") expect(fs.statSync(workspace()).mode & 0o777).toBe(0o700)
    // The title request and the answer itself both reached the gateway.
    expect(chats()).toBeGreaterThanOrEqual(2)
  }, 120_000)

  test("--dir given explicitly wins, and the opt out variable keeps the home folder", async () => {
    const explicit = await run(home, ["--dir", ".", "say hello"])
    expect(explicit.exitCode).toBe(0)
    expect(explicit.all).not.toContain("Working in")
    expect(fs.existsSync(workspace())).toBe(false)

    const optedOut = await run(home, ["say hello"], { [Workspace.OPT_OUT]: "1" })
    expect(optedOut.exitCode).toBe(0)
    expect(optedOut.all).not.toContain("Working in")
    expect(fs.existsSync(workspace())).toBe(false)
  }, 180_000)

  test("a real project folder is untouched", async () => {
    const project = path.join(home, "project")
    fs.mkdirSync(project)
    spawnSync("git", ["init", "-q"], { cwd: project })
    const result = await run(project, ["say hello"])
    expect(result.exitCode).toBe(0)
    expect(result.all).not.toContain("Working in")
    expect(fs.existsSync(workspace())).toBe(false)
  }, 120_000)

  // The interface, on a real pseudo terminal: the same line, then it draws in
  // the workspace instead of the home folder.
  test.skipIf(process.platform === "win32")(
    "the interface started from the home folder says where it works, then draws",
    async () => {
      const chunks: string[] = []
      // Started in the home folder, which has no bunfig.toml: the preload the
      // package's own bunfig names is passed by its absolute path instead.
      const preload = Bun.resolveSync("@opentui/solid/preload", root)
      const proc = Bun.spawn(
        ["sh", "-c", 'stty rows 30 cols 120 && exec bun run --preload "$1" "$0"', path.join(root, "src/index.ts"), preload],
        {
        cwd: home,
        env: {
          ...(process.env as Record<string, string>),
          PWD: home,
          HOME: home,
          OPENCODE_TEST_HOME: home,
          XDG_DATA_HOME: path.join(home, ".local/share"),
          XDG_STATE_HOME: path.join(home, ".local/state"),
          XDG_CACHE_HOME: path.join(home, ".cache"),
          TERM: "xterm-256color",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          RAFIKICODE_DISABLE_AUTOUPDATE: "1",
          RAFIKICODE_GATEWAY_URL: gateway.url + "/v1",
          RAFIKICODE_CONSOLE_URL: "http://127.0.0.1:9",
          RAFIKICODE_API_KEY: KEY,
        },
        terminal: {
          cols: 120,
          rows: 30,
          data(_terminal, data) {
            chunks.push(Buffer.from(data).toString())
          },
        },
      },
      )
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && !chunks.join("").includes("\x1b[?1049h")) await Bun.sleep(200)
      proc.kill("SIGKILL")
      await proc.exited
      const output = chunks.join("").replace(/\r?\n/g, " ")
      expect(output).toContain(LINE(workspace()))
      expect(chunks.join("")).toContain("\x1b[?1049h")
      expect(fs.statSync(workspace()).isDirectory()).toBe(true)
    },
    90_000,
  )

  // The hang itself: a git repository with more untracked files than one
  // snapshot may stage, run in explicitly. Before the bound, staging these
  // took about 30 seconds on this machine before the main request was sent.
  test("a git repository with more untracked files than a snapshot stages still answers at once", async () => {
    const big = path.join(home, "big")
    fs.mkdirSync(big)
    spawnSync("git", ["init", "-q"], { cwd: big })
    const count = Math.round(MAX_FILES * 4)
    for (let d = 0; d < count / 500; d++) {
      const dir = path.join(big, `d${d}`)
      fs.mkdirSync(dir)
      for (let f = 0; f < 500; f++) fs.writeFileSync(path.join(dir, `f${f}.txt`), `${d} ${f}\n`)
    }
    const result = await run(big, ["say hello"])
    expect(result.exitCode).toBe(0)
    expect(chats()).toBeGreaterThanOrEqual(2)
    // Bounded: about 29 seconds before the bound, a few after it.
    expect(result.seconds).toBeLessThan(15)
    // And no git process was left running in that tree behind it.
    const left = spawnSync("pgrep", ["-f", `--work-tree ${big}`]).stdout?.toString().trim()
    expect(left ?? "").toBe("")
  }, 180_000)
})
