// Package managers that lag behind GitHub, and an older copy earlier on PATH.
// The package managers and the shell are stand-ins: shell scripts written by
// these tests into their own directories, or a stubbed Run. Nothing here
// touches the network, a real package manager or the real PATH.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import { RafikiChannels } from "../../src/rafiki/channels"
import { RafikiAutoupdate } from "../../src/rafiki/autoupdate"
import { plan, verify } from "../../src/cli/cmd/upgrade"
import * as Doctor from "../../src/rafiki/doctor"

const posix = process.platform !== "win32"
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function tmp() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-channels-")))
  dirs.push(dir)
  return dir
}
function script(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}
// A copy of the product that reports a version, as a build does.
function copy(dir: string, version: string) {
  return script(path.join(dir, Brand.name), `echo ${version}`)
}
// A shell that runs the script it is given with /bin/sh, ignoring -i and -l,
// so the test controls PATH instead of the machine's profile files.
function fakeShell(dir: string) {
  return script(path.join(dir, "fake-shell"), `shift 3\nexec /bin/sh -c "$1"`)
}

const INSTALL_SH = "curl -fsSL https://get.rafikiai.io | bash -s -- --version"
const INSTALL_PS = "& ([scriptblock]::Create((irm https://github.com/paneotech-dev/rafiki-code-cli/releases/latest/download/install.ps1))) -Version"

const BREW_JSON = (version: string) => JSON.stringify({ formulae: [{ name: "rafikicode", versions: { stable: version } }] })
const WINGET_SHOW = (version: string) =>
  ["Found Rafiki Code [PaneoTech.RafikiCode]", `Version: ${version}`, "Publisher: PaneoTech", "Installer:", "  Installer Type: zip"].join("\r\n")

// A Run that answers from a table and records every command.
function stub(table: Record<string, { code?: number; stdout?: string }>) {
  const calls: string[] = []
  const run: RafikiChannels.Run = async (cmd) => {
    const line = cmd.join(" ")
    calls.push(line)
    const key = Object.keys(table).find((k) => line.startsWith(k))
    if (!key) return { code: 127, stdout: "", stderr: "not found" }
    return { code: table[key].code ?? 0, stdout: table[key].stdout ?? "", stderr: "" }
  }
  return { run, calls }
}

describe("what a package manager offers", () => {
  test("Homebrew: brew info, after the tap is brought up to date when asked", async () => {
    const s = stub({ "brew info": { stdout: BREW_JSON("0.1.9") }, "brew tap": {}, "brew update": {} })
    expect(await RafikiChannels.offered("brew", { run: s.run })).toBe("0.1.9")
    expect(s.calls).toEqual([`brew info --json=v2 ${Brand.brew.formula}`])
    s.calls.length = 0
    expect(await RafikiChannels.offered("brew", { run: s.run, refresh: true })).toBe("0.1.9")
    expect(s.calls).toEqual([`brew tap ${Brand.brew.tap}`, "brew update --quiet", `brew info --json=v2 ${Brand.brew.formula}`])
  })

  test("winget: winget show by the exact identifier", async () => {
    const s = stub({ "winget show": { stdout: WINGET_SHOW("0.1.9") } })
    expect(await RafikiChannels.offered("winget", { run: s.run })).toBe("0.1.9")
    expect(s.calls[0]).toStartWith(`winget show --id ${Brand.winget.id} --exact`)
    expect(await RafikiChannels.offered("winget", { run: stub({ "winget show": { code: 1, stdout: "No package found matching input criteria." } }).run })).toBeUndefined()
  })

  test("npm: npm view, and pnpm view when npm is not there", async () => {
    expect(await RafikiChannels.offered("npm", { run: stub({ "npm view": { stdout: "0.1.10\n" } }).run })).toBe("0.1.10")
    expect(await RafikiChannels.offered("pnpm", { run: stub({ "pnpm view": { stdout: "0.1.10\n" } }).run })).toBe("0.1.10")
    expect(await RafikiChannels.offered("npm", { run: stub({}).run })).toBeUndefined()
  })

  test.skipIf(!posix)("a stand-in brew on PATH is asked through the real runner", async () => {
    const bin = tmp()
    script(path.join(bin, "brew"), `[ "$1" = info ] && echo '${BREW_JSON("0.1.9")}'`)
    expect(await RafikiChannels.offered("brew", { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } })).toBe("0.1.9")
  })
})

describe("rafikicode update when the package manager is behind GitHub", () => {
  const feeds = (offered: string | undefined, github: string) => ({
    latest: async () => github,
    newest: async () => github,
    offered: async () => offered,
    github: async () => github,
  })

  test("Homebrew with nothing newer: says it plainly, gives the installer line, upgrades nothing", async () => {
    const result = await plan({ current: "0.1.9", method: "brew", channel: "stable", platform: "darwin", ...feeds("0.1.9", "0.1.11") })
    expect(result).toEqual({
      kind: "stop",
      level: "warn",
      exitCode: 1,
      lines: [
        "Homebrew offers rafikicode 0.1.9, but the newest release is 0.1.11: it has not reached Homebrew yet.",
        `To install 0.1.11, run: ${INSTALL_SH} 0.1.11`,
      ],
    })
  })

  test("winget is never asked for a version it does not have", async () => {
    const result = await plan({ current: "0.1.9", method: "winget", channel: "stable", platform: "win32", ...feeds("0.1.9", "0.1.11") })
    expect(result.kind).toBe("stop")
    if (result.kind !== "stop") return
    expect(result.lines[0]).toBe("winget offers rafikicode 0.1.9, but the newest release is 0.1.11: it has not reached winget yet.")
    expect(result.lines[1]).toBe(`To install 0.1.11, run: ${INSTALL_PS} 0.1.11`)
  })

  test("a channel partly behind installs what it has, and names the newer release", async () => {
    const result = await plan({ current: "0.1.9", method: "winget", channel: "stable", platform: "win32", ...feeds("0.1.10", "0.1.11") })
    expect(result.kind).toBe("install")
    if (result.kind !== "install") return
    expect(result.target).toBe("0.1.10")
    expect(result.notes[0]).toBe("winget offers rafikicode 0.1.10, but the newest release is 0.1.11: it has not reached winget yet.")
  })

  test("a channel up to date installs its version with no note", async () => {
    const result = await plan({ current: "0.1.9", method: "npm", channel: "stable", platform: "linux", ...feeds("0.1.11", "0.1.11") })
    expect(result).toEqual({ kind: "install", target: "0.1.11", notes: [] })
  })

  test("a channel that cannot be read stops for Homebrew and winget with the installer line", async () => {
    const result = await plan({ current: "0.1.9", method: "brew", channel: "stable", platform: "linux", ...feeds(undefined, "0.1.11") })
    expect(result.kind).toBe("stop")
    if (result.kind !== "stop") return
    expect(result.lines).toEqual([
      "Could not read the version Homebrew offers for rafikicode.",
      `The newest release is 0.1.11. To install it, run: ${INSTALL_SH} 0.1.11`,
    ])
  })

  test("an explicit version the channel does not have is refused with the installer line", async () => {
    const result = await plan({ current: "0.1.9", method: "winget", channel: "stable", target: "0.1.11", platform: "win32", ...feeds("0.1.9", "0.1.11") })
    expect(result.kind).toBe("stop")
    if (result.kind !== "stop") return
    expect(result.lines[0]).toBe("winget offers rafikicode 0.1.9; 0.1.11 has not been published there.")
  })
})

describe("the daily check when the package manager is behind", () => {
  const check = async (offered: string | undefined) => {
    const notices: RafikiAutoupdate.Notice[] = []
    await RafikiAutoupdate.check({
      autoupdate: true,
      current: "0.1.9",
      release: true,
      dir: tmp(),
      now: () => 1_700_000_000_000,
      env: {},
      latest: async () => "0.1.11",
      method: async () => "brew",
      offered: async () => offered,
      execPath: "/nonexistent/rafikicode",
      platform: "darwin",
      notify: (notice) => notices.push(notice),
    })
    return notices
  }

  test("points at the installer line, not a brew command that finds nothing", async () => {
    const notices = await check("0.1.9")
    expect(notices).toEqual([{ kind: "manual", version: "0.1.11", command: `${INSTALL_SH} 0.1.11`, reason: "Homebrew has only 0.1.9 so far" }])
    const toast = RafikiAutoupdate.toastFor(notices[0] as Exclude<RafikiAutoupdate.Notice, { kind: "available" }>)
    expect(toast.message).toBe(`Version 0.1.11 is available, but Homebrew has only 0.1.9 so far, so it was not installed. Update with: ${INSTALL_SH} 0.1.11`)
  })

  test("keeps the brew command when Homebrew has the release, or cannot be asked", async () => {
    expect((await check("0.1.11"))[0]).toMatchObject({ command: `brew upgrade ${Brand.brew.formula}` })
    expect((await check(undefined))[0]).toMatchObject({ command: `brew upgrade ${Brand.brew.formula}` })
  })
})

describe.skipIf(!posix)("which copy a new shell runs", () => {
  test("PATH is searched in order, the first executable wins", () => {
    const root = tmp()
    const older = copy(path.join(root, "usr-local-bin"), "0.1.9")
    copy(path.join(root, "home-bin"), "0.1.11")
    fs.mkdirSync(path.join(root, "not-exec"))
    fs.writeFileSync(path.join(root, "not-exec", Brand.name), "", { mode: 0o644 })
    const env = { PATH: [path.join(root, "not-exec"), path.join(root, "usr-local-bin"), path.join(root, "home-bin")].join(":") }
    expect(RafikiChannels.onPath(Brand.name, { env, platform: "linux" })).toBe(older)
  })

  test("the shell is asked, and its answer is read past anything its startup files print", async () => {
    const root = tmp()
    const older = copy(path.join(root, "old"), "0.1.9")
    copy(path.join(root, "new"), "0.1.11")
    const env = { ...process.env, SHELL: fakeShell(root), PATH: `${path.join(root, "old")}:${path.join(root, "new")}:/usr/bin:/bin` }
    expect(await RafikiChannels.newShell({ env, platform: "linux" })).toBe(older)
    const none = { ...env, PATH: "/usr/bin:/bin" }
    expect(await RafikiChannels.newShell({ env: none, platform: "linux" })).toBeNull()
  })

  test("a shell that cannot be started falls back to this PATH", async () => {
    const root = tmp()
    const only = copy(path.join(root, "bin"), "0.1.11")
    const env = { SHELL: path.join(root, "no-such-shell"), PATH: path.join(root, "bin") }
    expect(await RafikiChannels.newShell({ env, platform: "linux" })).toBe(only)
  })

  test("Windows asks PowerShell with the PATH a new terminal gets", async () => {
    const s = stub({ powershell: { stdout: `__${Brand.name}_path__C:\\Users\\a\\AppData\\Roaming\\npm\\${Brand.name}.cmd\r\n` } })
    expect(await RafikiChannels.newShell({ env: {}, platform: "win32", run: s.run })).toBe(`C:\\Users\\a\\AppData\\Roaming\\npm\\${Brand.name}.cmd`)
    expect(s.calls[0]).toContain("GetEnvironmentVariable('Path','User')")
  })

  test("the removal command follows the installer's rules", () => {
    expect(RafikiChannels.removal("/usr/lib/node_modules/rafikicode/bin/rafikicode", "linux").remove).toBe("npm uninstall -g rafikicode")
    expect(RafikiChannels.removal("/opt/homebrew/Cellar/rafikicode/0.1.9/bin/rafikicode", "darwin").remove).toBe(`brew uninstall ${Brand.brew.formula}`)
    const root = tmp()
    const older = copy(path.join(root, "bin"), "0.1.9")
    expect(RafikiChannels.removal(older, "linux")).toEqual({ how: "an older copy", remove: `rm '${older}'` })
  })
})

describe.skipIf(!posix)("after the upgrade", () => {
  // Homebrew's prefix with the copy it manages, and a stand-in brew that
  // reports that prefix.
  function layout(input: { brewVersion: string; older?: string }) {
    const root = tmp()
    const prefix = path.join(root, "homebrew")
    const updated = copy(path.join(prefix, "bin"), input.brewVersion)
    const tools = path.join(root, "tools")
    script(path.join(tools, "brew"), `[ "$1" = --prefix ] && echo '${prefix}'`)
    const dirs = [path.join(prefix, "bin"), tools, "/usr/bin", "/bin"]
    let older: string | undefined
    if (input.older) {
      older = copy(path.join(root, "usr-local-bin"), input.older)
      dirs.unshift(path.dirname(older))
    }
    const env = { ...process.env, SHELL: fakeShell(root), PATH: dirs.join(":") }
    return { updated, older, env }
  }

  test("a version that did not change is never called complete", async () => {
    const { env, updated } = layout({ brewVersion: "0.1.9" })
    const result = await verify({ method: "brew", target: "0.1.11", before: "0.1.9", execPath: "/x", platform: "darwin", env })
    expect(result.status).toBe("unchanged")
    expect(result.lines[0]).toBe(`Homebrew finished, but ${updated} still reports 0.1.9: nothing was upgraded.`)
    expect(result.lines[1]).toBe(`To install 0.1.11, run: ${INSTALL_SH} 0.1.11`)
    expect(result.shadow).toEqual([])
  })

  test("the new version is confirmed with --version", async () => {
    const { env } = layout({ brewVersion: "0.1.11" })
    const result = await verify({ method: "brew", target: "0.1.11", before: "0.1.9", execPath: "/x", platform: "darwin", env })
    expect(result).toEqual({ status: "changed", version: "0.1.11", lines: [], shadow: [] })
  })

  test("an older copy first on PATH is named, with its version and the command that removes it", async () => {
    const { env, updated, older } = layout({ brewVersion: "0.1.11", older: "0.1.9" })
    const result = await verify({ method: "brew", target: "0.1.11", before: "0.1.9", execPath: "/x", platform: "darwin", env })
    expect(result.status).toBe("changed")
    expect(result.shadow[0]).toBe(`A new terminal runs ${older} (an older copy, version 0.1.9), not ${updated}, which was just updated.`)
    expect(result.shadow[1]).toBe(`To remove the other copy: rm '${older}'`)
    expect(result.shadow[2]).toStartWith(`Or put ${path.dirname(updated)} first on PATH: `)
  })

  test("the installer method checks the running binary", async () => {
    const root = tmp()
    const exec = copy(path.join(root, ".rafikicode", "bin"), "0.1.11")
    const older = copy(path.join(root, "usr-local-bin"), "0.1.9")
    const env = { ...process.env, SHELL: fakeShell(root), PATH: `${path.dirname(older)}:${path.dirname(exec)}:/usr/bin:/bin` }
    const result = await verify({ method: "curl", target: "0.1.11", before: "0.1.9", execPath: exec, platform: "linux", env })
    expect(result.status).toBe("changed")
    expect(result.shadow[0]).toContain(`A new terminal runs ${older}`)
  })
})

describe.skipIf(!posix)("doctor: what a new terminal runs", () => {
  test("ok when it is this binary, a failure with the removal command when it is another", () => {
    const root = tmp()
    const exec = copy(path.join(root, ".rafikicode", "bin"), "0.1.11")
    const older = copy(path.join(root, "usr-local-bin"), "0.1.9")
    expect(Doctor.checkNewShell(exec, exec, "latest")).toMatchObject({ name: "new shell", status: "ok" })
    const line = Doctor.checkNewShell(older, exec, "latest", "0.1.9", "0.1.11")
    expect(line).toMatchObject({ name: "new shell", status: "fail" })
    expect(line.detail).toBe(`a new terminal runs ${older} (an older copy, version 0.1.9), not ${exec}`)
    expect(line.fix).toContain(`rm '${older}'`)
    expect(Doctor.checkNewShell(null, exec, "latest").status).toBe("warn")
  })

  test("doctor runs the check when this terminal reaches this binary", async () => {
    const root = tmp()
    const exec = copy(path.join(root, ".rafikicode", "bin"), "0.1.11")
    const older = copy(path.join(root, "usr-local-bin"), "0.1.9")
    const report = await Doctor.run({
      env: {},
      configDir: root,
      cwd: root,
      execPath: exec,
      channel: "latest",
      version: "0.1.11",
      which: () => exec,
      newShell: async () => older,
      fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
      validate: () => undefined,
      windowsConsole: () => undefined,
      folders: async () => [],
      timeoutMs: 100,
    })
    const line = report.lines.find((l) => l.name === "new shell")
    expect(line).toMatchObject({ status: "fail" })
    expect(line?.detail).toContain("version 0.1.9")
  })
})
