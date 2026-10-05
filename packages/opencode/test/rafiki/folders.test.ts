// The folder doctor, first half: the folders rafikicode needs for itself.
//
// Each case is driven two ways. With a fake file system, so that the states a
// test machine cannot be put into (a home folder that is not writable for root,
// a temporary folder with 0 MB free) are exact. And through the real entry
// point, with fake environments and real folders, so the one line the user
// reads, and the fact that the run carries on, are proven where that is
// possible without root: an unset HOME, a HOME that is a file, a TMPDIR that is
// a file, a data folder that is a file.
import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as Folders from "../../src/rafiki/folders"
import * as Doctor from "../../src/rafiki/doctor"
import type * as Workspace from "../../src/rafiki/workspace"

const root = path.resolve(import.meta.dir, "../..")

// A file system held in memory: folders, files, which folders refuse writes,
// and the free space under each prefix.
function memory(setup: { dirs?: string[]; files?: string[]; readonly?: string[]; free?: Record<string, number> }) {
  const dirs = new Set(setup.dirs ?? [])
  const files = new Set(setup.files ?? [])
  const readonly = setup.readonly ?? []
  const io: Folders.IO = {
    kind: (target) => (files.has(target) ? "file" : dirs.has(target) ? "dir" : undefined),
    writable: (target) => {
      if (files.has(target)) return false
      if (readonly.some((item) => item === "/" || target === item || target.startsWith(item + "/"))) return false
      // mkdir -p: every parent must be a folder or creatable.
      let at = target
      while (at !== "/" && at !== ".") {
        if (files.has(at)) return false
        at = path.dirname(at)
      }
      for (let up = target; up !== "/"; up = path.dirname(up)) dirs.add(up)
      return true
    },
    free: (target) => {
      const match = Object.keys(setup.free ?? {})
        .filter((prefix) => target === prefix || target.startsWith(prefix + "/"))
        .sort((a, b) => b.length - a.length)[0]
      return match ? setup.free![match] : 10 * 1024 * 1024 * 1024
    },
    aside: (target) => {
      if (!files.has(target)) return undefined
      files.delete(target)
      const moved = `${target}.broken-1`
      files.add(moved)
      return moved
    },
  }
  return { io, dirs, files }
}

function run(env: Folders.Env, io: Folders.IO, platform = "linux") {
  return Folders.check({ env, platform, cwd: "/work", systemTemp: "/tmp", user: "ana", io })
}

const byName = (result: Folders.Result, name: string) => result.checks.find((item) => item.name === name)!

describe("the folder doctor: the folders rafikicode needs", () => {
  test("a healthy machine: every check ok, nothing changed, nothing printed", () => {
    const { io } = memory({ dirs: ["/home/ana", "/tmp"] })
    const result = run({ HOME: "/home/ana", TMPDIR: "/tmp" }, io)
    expect(result.env).toEqual({})
    expect(result.checks.map((item) => [item.name, item.status])).toEqual([
      ["home", "ok"],
      ["temp", "ok"],
      ["config", "ok"],
      ["data", "ok"],
      ["cache", "ok"],
      ["state", "ok"],
    ])
    expect(result.checks.every((item) => item.line === undefined)).toBe(true)
  })

  test("case 5: a home folder that is not set or cannot be written gets a private one, and nothing crashes", () => {
    const unset = run({ TMPDIR: "/tmp" }, memory({ dirs: ["/tmp"] }).io)
    expect(unset.env["HOME"]).toBe("/tmp/rafikicode-home-ana")
    expect(byName(unset, "home").line).toBe("Your home folder is not set, so rafikicode keeps its files in /tmp/rafikicode-home-ana.")
    // And the config and data folders follow it.
    expect(byName(unset, "config").detail).toBe("/tmp/rafikicode-home-ana/.rafikicode is writable")

    const locked = run({ HOME: "/home/ana", TMPDIR: "/tmp" }, memory({ dirs: ["/home/ana", "/tmp"], readonly: ["/home/ana"] }).io)
    expect(byName(locked, "home").line).toBe(
      "Your home folder (/home/ana) cannot be written, so rafikicode keeps its files in /tmp/rafikicode-home-ana.",
    )
    // Windows reads USERPROFILE, and both are set.
    const win = run({ USERPROFILE: "C:/Users/ana", TEMP: "/tmp" }, memory({ dirs: ["/tmp"] }).io, "win32")
    expect(win.env["USERPROFILE"]).toBe(win.env["HOME"])

    const nowhere = run({ HOME: "/home/ana", TMPDIR: "/tmp" }, memory({ readonly: ["/"] }).io)
    expect(byName(nowhere, "home").status).toBe("fail")
    expect(byName(nowhere, "home").line).toContain("Set HOME to a folder you own.")
  })

  test("case 3: a full, missing or unwritable temporary folder is replaced by ~/.rafikicode/tmp, and TMPDIR, TEMP and TMP point there", () => {
    const full = run({ HOME: "/home/ana", TMPDIR: "/tmp" }, memory({ dirs: ["/home/ana", "/tmp"], free: { "/tmp": 0 } }).io)
    expect(full.env).toMatchObject({
      TMPDIR: "/home/ana/.rafikicode/tmp",
      TEMP: "/home/ana/.rafikicode/tmp",
      TMP: "/home/ana/.rafikicode/tmp",
    })
    expect(byName(full, "temp").line).toBe(
      "The temporary folder /tmp has 0 MB free, so rafikicode uses /home/ana/.rafikicode/tmp instead.",
    )
    const unwritable = run({ HOME: "/home/ana", TMPDIR: "/tmp" }, memory({ dirs: ["/home/ana", "/tmp"], readonly: ["/tmp"] }).io)
    expect(byName(unwritable, "temp").line).toContain("/tmp cannot be written")
    const file = run({ HOME: "/home/ana", TMPDIR: "/tmp/x" }, memory({ dirs: ["/home/ana", "/tmp"], files: ["/tmp/x"] }).io)
    expect(byName(file, "temp").line).toContain("/tmp/x is a file, not a folder")
    // Windows: TEMP is the variable that is read.
    const win = run({ USERPROFILE: "/home/ana", TEMP: "/w/temp" }, memory({ dirs: ["/home/ana"], readonly: ["/w"] }).io, "win32")
    expect(byName(win, "temp").detail).toContain("/w/temp cannot be written")
    // Nowhere with room: one clear line, and the start carries on.
    const nowhere = run(
      { HOME: "/home/ana", TMPDIR: "/tmp" },
      memory({ dirs: ["/home/ana", "/tmp"], free: { "/tmp": 0, "/home/ana": 1024 } }).io,
    )
    expect(byName(nowhere, "temp").status).toBe("warn")
    expect(byName(nowhere, "temp").line).toContain("Free some space, or set TMPDIR to a folder with room.")
  })

  test("case 4: a data, cache or state folder that is a file is moved aside and recreated", () => {
    const { io, files } = memory({ dirs: ["/home/ana", "/tmp"], files: ["/home/ana/.local/share/rafikicode"] })
    const result = run({ HOME: "/home/ana", TMPDIR: "/tmp" }, io)
    expect(byName(result, "data").line).toBe(
      "/home/ana/.local/share/rafikicode was a file, not a folder: moved it to /home/ana/.local/share/rafikicode.broken-1 and made a new folder.",
    )
    expect(files.has("/home/ana/.local/share/rafikicode.broken-1")).toBe(true)
  })

  test("case 4: a folder that cannot be written falls back under the home folder, through the XDG variable", () => {
    const result = run(
      { HOME: "/home/ana", TMPDIR: "/tmp", XDG_STATE_HOME: "/srv/state" },
      memory({ dirs: ["/home/ana", "/tmp"], readonly: ["/srv"] }).io,
    )
    expect(result.env["XDG_STATE_HOME"]).toBe("/home/ana/.rafikicode/fallback/state")
    expect(byName(result, "state").line).toBe(
      "the state folder /srv/state/rafikicode cannot be written, so rafikicode uses /home/ana/.rafikicode/fallback/state/rafikicode instead.",
    )
  })

  test("case 4: a read only config folder is kept, because the sign in is read from it", () => {
    const result = run(
      { HOME: "/home/ana", TMPDIR: "/tmp" },
      memory({ dirs: ["/home/ana", "/tmp", "/home/ana/.rafikicode"], readonly: ["/home/ana/.rafikicode"] }).io,
    )
    expect(result.env["XDG_CONFIG_HOME"]).toBeUndefined()
    expect(byName(result, "config").status).toBe("warn")
    expect(byName(result, "config").line).toContain("is read only")
  })

  test("case 6: spaces and accents in every path", () => {
    const home = "/home/Zoë Müller"
    const result = run({ HOME: home, TMPDIR: "/tmp/mon dossier" }, memory({ dirs: [home, "/tmp"], free: { "/tmp": 0 } }).io)
    expect(result.env["TMPDIR"]).toBe("/home/Zoë Müller/.rafikicode/tmp")
    expect(byName(result, "data").detail).toBe("/home/Zoë Müller/.local/share/rafikicode is writable")
  })

  test("doctor prints what was checked and what was fixed, for support to read", async () => {
    const result = run({ HOME: "/home/ana", TMPDIR: "/tmp" }, memory({ dirs: ["/home/ana", "/tmp"], free: { "/tmp": 0 } }).io)
    const probe: Workspace.Probe = {
      access: async () => "ok",
      repository: () => false,
      inRepository: () => false,
      count: async () => ({ files: 1, done: true }),
      free: () => 100 * 1024 * 1024,
    }
    const lines = await Doctor.folderLines("/home/ana", result.checks, probe, "/home/ana")
    const text = lines.map(Doctor.format).join("\n")
    expect(text).toContain("ok    temp        fixed: /tmp has 0 MB free; using /home/ana/.rafikicode/tmp")
    expect(text).toContain("ok    data dir    /home/ana/.local/share/rafikicode is writable")
    expect(text).toContain(
      "ok    folder      /home/ana: the start folder is your home folder; the interface and run work in /home/ana/RafikiCode instead when started here",
    )
    expect(text).toContain("WARN  disk        Only 100 MB free on the disk holding /home/ana/RafikiCode.")
  })
})

// The real entry point, with real folders. `--version` is enough: the checks
// run before any command, and every fix prints its line on stderr.
async function start(env: Record<string, string | undefined>, args = ["--version"]) {
  const full: Record<string, string | undefined> = { ...process.env, ...env }
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete full[key]
  delete full["RAFIKICODE_SKIP_FOLDER_CHECKS"]
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: full as Record<string, string>,
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { exitCode: await proc.exited, stdout, stderr }
}

describe("the folder doctor through the real entry point", () => {
  test("a HOME that is a file, a TMPDIR that is a file and a data folder that is a file: three lines, and it runs", async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-folders-")))
    try {
      const homeFile = path.join(base, "home-is-a-file")
      fs.writeFileSync(homeFile, "")
      const tmpFile = path.join(base, "tmp-is-a-file")
      fs.writeFileSync(tmpFile, "")
      const data = path.join(base, "data")
      fs.mkdirSync(data)
      fs.writeFileSync(path.join(data, "rafikicode"), "not a folder")
      const result = await start(
        {
          HOME: homeFile,
          OPENCODE_TEST_HOME: undefined,
          TMPDIR: tmpFile,
          XDG_DATA_HOME: data,
          XDG_CONFIG_HOME: undefined,
          XDG_CACHE_HOME: undefined,
          XDG_STATE_HOME: undefined,
        },
        ["--version"],
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).not.toBe("")
      const fallbackHome = result.stderr.match(/keeps its files in (\S+)\./)?.[1]
      expect(result.stderr).toContain(`Your home folder (${homeFile}) cannot be written, so rafikicode keeps its files in`)
      expect(fallbackHome).toBeTruthy()
      expect(result.stderr).toContain(`The temporary folder ${tmpFile} is a file, not a folder, so rafikicode uses ${fallbackHome}/.rafikicode/tmp instead.`)
      expect(result.stderr).toContain(`${data}/rafikicode was a file, not a folder: moved it to ${data}/rafikicode.broken-`)
      expect(fs.statSync(path.join(data, "rafikicode")).isDirectory()).toBe(true)
      if (fallbackHome && fallbackHome.includes("rafikicode-home-")) fs.rmSync(fallbackHome, { recursive: true, force: true })
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  }, 60_000)

  test("an unset HOME: one line, and doctor --folders reports it", async () => {
    const result = await start({ HOME: undefined, OPENCODE_TEST_HOME: undefined, XDG_CONFIG_HOME: undefined }, [
      "doctor",
      "--folders",
    ])
    expect(result.stderr).toContain("Your home folder is not set, so rafikicode keeps its files in")
    const fallbackHome = result.stderr.match(/keeps its files in (\S+)\./)?.[1]
    if (fallbackHome && fallbackHome.includes("rafikicode-home-")) fs.rmSync(fallbackHome, { recursive: true, force: true })
    // doctor writes its report through the UI module, to stderr.
    const plain = result.stderr.replace(/\x1b\[[0-9;]*m/g, "")
    expect(plain).toContain("home        fixed: the home folder is not set; using")
    expect(plain).toContain("folder      ")
    expect(plain).toContain("All checks passed.")
    expect(result.exitCode).toBe(0)
  }, 60_000)

  test("a healthy start prints nothing about folders", async () => {
    const result = await start({}, ["--version"])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).not.toContain("rafikicode keeps its files")
    expect(result.stderr).not.toContain("instead.")
  }, 60_000)
})
