// Update channels: `rafikicode upgrade --pre`, the `channel` setting and
// RAFIKICODE_UPDATE_CHANNEL, the release list with its release page fallback,
// and what the command decides for each install method. The release list is
// a stubbed fetch; nothing here touches the network or installs anything.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { RafikiUpdate } from "../../src/rafiki/update"
import { RafikiAutoupdate } from "../../src/rafiki/autoupdate"
import { plan } from "../../src/cli/cmd/upgrade"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-channel-"))
  dirs.push(dir)
  return dir
}

const API = "https://api.github.com/repos/paneotech-dev/rafiki-code-cli"
const BASE = "https://github.com/paneotech-dev/rafiki-code-cli/releases"

// A GitHub stand-in: the releases API (or its rate limit), the release page,
// and the /latest redirect that names the newest stable release.
function github(input: { api?: unknown[] | number; page?: string[]; latest?: string }) {
  const asked: string[] = []
  const f = (async (url: string) => {
    asked.push(url)
    if (url.startsWith(`${API}/releases?`)) {
      if (typeof input.api === "number") return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: input.api })
      return Response.json(input.api ?? [])
    }
    if (url === BASE) {
      if (!input.page) return new Response("", { status: 503 })
      const links = input.page.map((tag) => `<a href="/paneotech-dev/rafiki-code-cli/releases/tag/v${tag}" class="Link--primary">v${tag}</a>`)
      return new Response(`<html><body>${links.join("\n")}</body></html>`, { status: 200 })
    }
    if (url === `${BASE}/latest`) {
      if (!input.latest) return new Response("", { status: 404 })
      return new Response(null, { status: 302, headers: { location: `${BASE}/tag/v${input.latest}` } })
    }
    return new Response("", { status: 404 })
  }) as unknown as typeof fetch
  return { f, asked }
}

const release = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: `v${tag}`, draft: false, prerelease: tag.includes("-"), ...extra })

describe("the channel", () => {
  test("a pre-release copy follows pre-releases, a stable copy stays stable", () => {
    const dir = tmp()
    expect(RafikiUpdate.channel({ env: {}, configDir: dir, current: "0.1.10-rc.7" })).toBe("pre")
    expect(RafikiUpdate.channel({ env: {}, configDir: dir, current: "0.1.9" })).toBe("stable")
    expect(RafikiUpdate.channel({ env: {}, configDir: dir, current: "local" })).toBe("stable")
  })

  test("the setting wins over the version, the environment over both", () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, "config.json"), `{\n  // testers\n  "channel": "pre",\n}\n`)
    expect(RafikiUpdate.channel({ env: {}, configDir: dir, current: "0.1.9" })).toBe("pre")
    expect(RafikiUpdate.channel({ env: { RAFIKICODE_UPDATE_CHANNEL: "stable" }, configDir: dir, current: "0.1.9" })).toBe("stable")
    expect(RafikiUpdate.channel({ env: { RAFIKICODE_UPDATE_CHANNEL: "PRE" }, configDir: tmp(), current: "0.1.9" })).toBe("pre")
    // An unknown value is ignored rather than guessed at.
    expect(RafikiUpdate.channel({ env: { RAFIKICODE_UPDATE_CHANNEL: "beta" }, configDir: dir, current: "0.1.9" })).toBe("pre")
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ channel: "stable" }))
    expect(RafikiUpdate.channel({ env: {}, configDir: dir, current: "0.1.10-rc.7" })).toBe("stable")
  })
})

describe("the release list", () => {
  test("semver with pre-release ordering", () => {
    expect(RafikiUpdate.newestOf(["v0.1.9", "v0.1.10-rc.7", "v0.1.10-rc.10", "v0.1.10-rc.8"])).toBe("0.1.10-rc.10")
    expect(RafikiUpdate.newestOf(["v0.1.10-rc.10", "v0.1.10", "v0.1.9"])).toBe("0.1.10")
    expect(RafikiUpdate.newestOf(["nightly", "v0.1.9"])).toBe("0.1.9")
    expect(RafikiUpdate.newestOf([])).toBeUndefined()
  })

  test("from the releases API, drafts left out", async () => {
    const { f } = github({ api: [release("0.1.9"), release("0.1.10-rc.7"), release("0.1.10-rc.8", { draft: true })] })
    expect(await RafikiUpdate.newest({ fetch: f })).toBe("0.1.10-rc.7")
  })

  test("from the release page when the API is rate limited", async () => {
    for (const status of [403, 429]) {
      const { f, asked } = github({ api: status, page: ["0.1.10-rc.7", "0.1.9", "0.1.10-rc.6"] })
      expect(await RafikiUpdate.newest({ fetch: f })).toBe("0.1.10-rc.7")
      expect(asked).toContain(BASE)
    }
  })

  test("the pre channel falls back to the stable answer when no list can be read", async () => {
    const { f } = github({ api: 403, latest: "0.1.9" })
    expect(await RafikiUpdate.latestOf("pre", { fetch: f })).toBe("0.1.9")
    const { f: g } = github({ api: [release("0.1.10-rc.7")], latest: "0.1.9" })
    expect(await RafikiUpdate.latestOf("stable", { fetch: g })).toBe("0.1.9")
    expect(await RafikiUpdate.latestOf("pre", { fetch: g })).toBe("0.1.10-rc.7")
  })
})

// The upgrade command's decision, with the registries stubbed.
function feeds(stable: string, newest: string | undefined) {
  const asked: string[] = []
  return {
    asked,
    latest: async (channel: RafikiUpdate.Channel) => {
      asked.push(channel)
      return channel === "pre" && newest ? newest : stable
    },
    newest: async () => newest,
  }
}

describe("rafikicode upgrade", () => {
  test("on stable with nothing newer, one line names the newer pre-release and the command", async () => {
    const result = await plan({ current: "0.1.9", method: "curl", channel: "stable", platform: "linux", ...feeds("0.1.9", "0.1.10-rc.7") })
    expect(result.kind).toBe("stop")
    if (result.kind !== "stop") return
    expect(result.lines).toEqual([
      "rafikicode upgrade skipped: 0.1.9 is already installed",
      "A newer pre-release, 0.1.10-rc.7, is available: rafikicode upgrade --pre",
    ])
  })

  test("--pre installs the newest pre-release with the installer method", async () => {
    const stub = feeds("0.1.9", "0.1.10-rc.7")
    const result = await plan({ current: "0.1.9", method: "curl", channel: "stable", pre: true, ...stub })
    expect(result).toEqual({ kind: "install", target: "0.1.10-rc.7", notes: [] })
    expect(stub.asked).toEqual(["pre"])
  })

  test("a pre-release copy keeps receiving pre-releases", async () => {
    const result = await plan({ current: "0.1.10-rc.7", method: "curl", channel: "pre", ...feeds("0.1.9", "0.1.10-rc.8") })
    expect(result).toEqual({ kind: "install", target: "0.1.10-rc.8", notes: [] })
  })

  test("a newer stable release reaches a pre-release copy", async () => {
    const result = await plan({ current: "0.1.10-rc.8", method: "curl", channel: "pre", ...feeds("0.1.10", "0.1.10") })
    expect(result).toEqual({ kind: "install", target: "0.1.10", notes: [] })
  })

  test("a pre-release copy put on stable is not taken back to an older release", async () => {
    const result = await plan({ current: "0.1.10-rc.7", method: "curl", channel: "stable", ...feeds("0.1.9", "0.1.10-rc.7") })
    expect(result.kind).toBe("stop")
    if (result.kind !== "stop") return
    expect(result.lines[0]).toBe("rafikicode upgrade skipped: 0.1.10-rc.7 is newer than the latest stable release, 0.1.9")
    expect(result.lines).toHaveLength(1)
  })

  for (const method of ["npm", "pnpm", "bun", "brew", "winget"] as const) {
    test(`--pre with ${method} says it has stable releases only and gives the installer line`, async () => {
      const platform = method === "winget" ? "win32" : "linux"
      const result = await plan({ current: "0.1.9", method, channel: "stable", pre: true, platform, ...feeds("0.1.9", "0.1.10-rc.7") })
      expect(result.kind).toBe("stop")
      if (result.kind !== "stop") return
      expect(result.exitCode).toBe(1)
      expect(result.lines[0]).toBe(`Pre-releases are published only through the installer script; ${method} has stable releases only.`)
      expect(result.lines[1]).toBe(
        platform === "win32"
          ? "To install 0.1.10-rc.7, run: & ([scriptblock]::Create((irm https://github.com/paneotech-dev/rafiki-code-cli/releases/latest/download/install.ps1))) -Version 0.1.10-rc.7"
          : "To install 0.1.10-rc.7, run: curl -fsSL https://get.rafikiai.io | bash -s -- --version 0.1.10-rc.7",
      )
    })
  }

  test("the pre channel on npm says so, then updates on the stable releases npm has", async () => {
    const stub = feeds("0.1.10", "0.1.11-rc.1")
    const result = await plan({ current: "0.1.9", method: "npm", channel: "pre", platform: "linux", ...stub })
    expect(result.kind).toBe("install")
    if (result.kind !== "install") return
    expect(result.target).toBe("0.1.10")
    expect(result.notes[1]).toBe("To install 0.1.11-rc.1, run: curl -fsSL https://get.rafikiai.io | bash -s -- --version 0.1.11-rc.1")
    expect(stub.asked).toEqual(["stable"])
  })

  test("on stable with npm, the newer pre-release line gives the installer command", async () => {
    const result = await plan({ current: "0.1.9", method: "npm", channel: "stable", platform: "linux", ...feeds("0.1.9", "0.1.10-rc.7") })
    if (result.kind !== "stop") throw new Error("expected stop")
    expect(result.lines[1]).toBe(
      "A newer pre-release, 0.1.10-rc.7, is available through the installer script: curl -fsSL https://get.rafikiai.io | bash -s -- --version 0.1.10-rc.7",
    )
  })

  test("an explicit version is installed as asked", async () => {
    expect(await plan({ current: "0.1.9", method: "curl", channel: "stable", target: "v0.1.10-rc.7", ...feeds("0.1.9", undefined) })).toEqual({
      kind: "install",
      target: "0.1.10-rc.7",
      notes: [],
    })
    expect(await plan({ current: "0.1.10-rc.7", method: "npm", channel: "pre", target: "0.1.8", ...feeds("0.1.9", undefined) })).toEqual({
      kind: "install",
      target: "0.1.8",
      notes: [],
    })
    const same = await plan({ current: "0.1.9", method: "curl", channel: "stable", target: "0.1.9", ...feeds("0.1.9", undefined) })
    expect(same.kind).toBe("stop")
    const npmPre = await plan({ current: "0.1.9", method: "npm", channel: "stable", target: "0.1.10-rc.7", platform: "linux", ...feeds("0.1.9", undefined) })
    expect(npmPre.kind).toBe("stop")
    if (npmPre.kind === "stop") expect(npmPre.lines[1]).toContain("--version 0.1.10-rc.7")
  })

  test("no newer pre-release, no extra line", async () => {
    const result = await plan({ current: "0.1.10", method: "curl", channel: "stable", ...feeds("0.1.10", "0.1.10-rc.8") })
    if (result.kind !== "stop") throw new Error("expected stop")
    expect(result.lines).toEqual(["rafikicode upgrade skipped: 0.1.10 is already installed"])
  })
})

describe("the daily check", () => {
  test("a pre-release found for a package manager install names the installer line", async () => {
    const notices: RafikiAutoupdate.Notice[] = []
    const outcome = await RafikiAutoupdate.check({
      autoupdate: true,
      current: "0.1.10-rc.7",
      release: true,
      dir: tmp(),
      now: () => 1_700_000_000_000,
      env: {},
      latest: async () => "0.1.10-rc.8",
      method: async () => "npm",
      execPath: "/nonexistent/rafikicode",
      platform: "linux",
      notify: (notice) => notices.push(notice),
    })
    expect(outcome).toBe("manual")
    expect(notices).toEqual([
      { kind: "manual", version: "0.1.10-rc.8", command: "curl -fsSL https://get.rafikiai.io | bash -s -- --version 0.1.10-rc.8" },
    ])
  })

  test("a stable release found for npm keeps the npm command", async () => {
    const notices: RafikiAutoupdate.Notice[] = []
    await RafikiAutoupdate.check({
      autoupdate: true,
      current: "0.1.9",
      release: true,
      dir: tmp(),
      now: () => 1_700_000_000_000,
      env: {},
      latest: async () => "0.1.10",
      method: async () => "npm",
      execPath: "/nonexistent/rafikicode",
      notify: (notice) => notices.push(notice),
    })
    expect(notices[0]).toMatchObject({ kind: "manual", command: "npm install -g rafikicode@latest" })
  })
})
