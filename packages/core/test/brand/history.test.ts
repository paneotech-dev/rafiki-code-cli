// Recent conversations and projects (src/brand/history.ts): from the session
// list the server already keeps, newest first, and how a pick in another
// folder is handed to the command that restarts the interface there.
import { describe, expect, test } from "bun:test"
import * as Account from "../../src/brand/account"
import * as History from "../../src/brand/history"

const session = (id: string, directory: string, updated: number, extra: Partial<History.SessionLike> = {}): History.SessionLike => ({
  id,
  title: `title ${id}`,
  directory,
  time: { created: updated - 10, updated },
  ...extra,
})

describe("conversations", () => {
  test("top level, not archived, newest activity first, with the tier when it was a Rafiki tier", () => {
    const list = History.conversations([
      session("a", "/w/one", 100, { model: { id: "rafiki-pro", providerID: "rafiki" } }),
      session("b", "/w/two", 300),
      session("c", "/w/one", 200, { parentID: "a" }),
      session("d", "/w/one", 400, { time: { created: 1, updated: 400, archived: 401 } }),
      session("e", "/w/three", 250, { model: { id: "gpt-x", providerID: "other" } }),
    ])
    expect(list.map((item) => item.id)).toEqual(["b", "e", "a"])
    expect(list[2]).toEqual({ id: "a", title: "title a", directory: "/w/one", updated: 100, tier: "pro" })
    expect(list[1]!.tier).toBeUndefined()
  })

  test("an untitled conversation and the limit", () => {
    expect(History.conversations([session("a", "/w", 1, { title: "" })])[0]!.title).toBe("Untitled")
    expect(History.conversations([session("a", "/w", 1), session("b", "/w", 2)], 1).map((item) => item.id)).toEqual(["b"])
  })
})

describe("projects", () => {
  test("one entry per folder, the folder worked in last first, with its count", () => {
    const list = History.projects(
      History.conversations([session("a", "/w/one", 100), session("b", "/w/two", 300), session("c", "/w/one", 500)]),
    )
    expect(list).toEqual([
      { directory: "/w/one", updated: 500, conversations: 2 },
      { directory: "/w/two", updated: 300, conversations: 1 },
    ])
  })
})

describe("wording", () => {
  test("a folder under home is written from ~", () => {
    expect(History.folder("/home/ann/work/app", "/home/ann")).toBe("~/work/app")
    expect(History.folder("/home/ann", "/home/ann")).toBe("~")
    expect(History.folder("/srv/app", "/home/ann")).toBe("/srv/app")
  })

  test("how long ago", () => {
    const now = 10_000_000_000
    expect(History.ago(now - 5_000, now)).toBe("just now")
    expect(History.ago(now - 5 * 60_000, now)).toBe("5 min ago")
    expect(History.ago(now - 3 * 3_600_000, now)).toBe("3 h ago")
    expect(History.ago(now - 86_400_000, now)).toBe("1 day ago")
    expect(History.ago(now - 2 * 86_400_000, now)).toBe("2 days ago")
    expect(History.ago(now - 40 * 86_400_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test("a long title is clipped", () => {
    expect(History.clip("abcdef", 4)).toBe("abc…")
    expect(History.clip("abc", 4)).toBe("abc")
  })
})

describe("reopening in another folder", () => {
  test("is asked for once, then taken", () => {
    History.requestReopen({ directory: "/w/one", sessionID: "ses_1" })
    expect(History.takeReopen()).toEqual({ directory: "/w/one", sessionID: "ses_1" })
    expect(History.takeReopen()).toBeUndefined()
  })

  test("a conversation reopens with --session, a project with the folder alone", () => {
    expect(History.reopenArgs({ directory: "/w/one", sessionID: "ses_1" })).toEqual(["/w/one", "--session", "ses_1"])
    expect(History.reopenArgs({ directory: "/w/one" })).toEqual(["/w/one"])
  })
})

// Builder projects: the Console's page (GET /api/v1/builder/sessions), read
// with the key in use from a stub Console on loopback.
const SES = (n: number) => `ses_7d2f9a1e-0000-4000-8000-${String(n).padStart(12, "0")}`
const buildItem = (n: number, extra: Record<string, unknown> = {}) => ({
  id: SES(n),
  title: `Build ${n}`,
  template: "booking",
  status: "stopped",
  created_at: "2026-10-10T09:00:00.000Z",
  last_activity_at: new Date(Date.parse("2026-10-10T09:00:00.000Z") + n * 60_000).toISOString(),
  published_url: null,
  files_kept: true,
  builder_url: `https://code.rafikiai.io/build?session=${SES(n)}`,
  ...extra,
})

describe("builds", () => {
  test("newest first, at most the limit, with the builder page and the live address", () => {
    const list = History.builds({ object: "list", data: [1, 2, 3, 4, 5, 6].map((n) => buildItem(n, n === 6 ? { published_url: "https://salon.rafiki.site" } : {})) })!
    expect(list.map((item) => item.title)).toEqual(["Build 6", "Build 5", "Build 4", "Build 3", "Build 2"])
    expect(list[0]).toEqual({
      id: SES(6),
      title: "Build 6",
      status: "stopped",
      updated: Date.parse(buildItem(6).last_activity_at),
      url: `https://code.rafikiai.io/build?session=${SES(6)}`,
      published: "https://salon.rafiki.site/",
    })
    expect(History.buildStatus(list[0]!)).toBe("published")
    expect(History.buildStatus(list[1]!)).toBe("stopped")
    expect(History.buildStatus({ ...list[1]!, status: "ready" })).toBe("open")
  })

  test("entries that cannot be opened are left out, and a body that is not a page gives nothing", () => {
    const list = History.builds({
      data: [
        buildItem(1, { id: "../x" }),
        buildItem(2, { builder_url: "javascript:alert(1)" }),
        buildItem(3, { last_activity_at: "soon", created_at: "never" }),
        buildItem(4, { title: "  ", status: "" }),
        "nope",
      ],
    })!
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ title: "Untitled build", status: "unknown" })
    expect(History.builds(undefined)).toBeUndefined()
    expect(History.builds({ error: { message: "Not found" } })).toBeUndefined()
    expect(History.builds({ data: [] })).toEqual([])
  })
})

describe("browserAvailable", () => {
  test("a display, WSL or BROWSER on Linux; not over ssh on macOS or Windows", () => {
    expect(History.browserAvailable({}, "linux")).toBe(false)
    expect(History.browserAvailable({ DISPLAY: ":0" }, "linux")).toBe(true)
    expect(History.browserAvailable({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true)
    expect(History.browserAvailable({ WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toBe(true)
    expect(History.browserAvailable({ BROWSER: "w3m" }, "freebsd")).toBe(true)
    expect(History.browserAvailable({}, "darwin")).toBe(true)
    expect(History.browserAvailable({ SSH_CONNECTION: "1 2 3 4" }, "darwin")).toBe(false)
    expect(History.browserAvailable({ SSH_TTY: "/dev/pts/1" }, "win32")).toBe(false)
  })
})

describe("builderProjects against a stub Console", () => {
  test("asks for five with the key, and gives undefined on a 404, a refusal or no answer", async () => {
    const seen: { path: string; auth: string | null }[] = []
    let status = 200
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        seen.push({ path: url.pathname + url.search, auth: request.headers.get("authorization") })
        if (status !== 200) return Response.json({ error: { message: "Not found", type: "not_found_error" } }, { status })
        return Response.json({ object: "list", data: [buildItem(1)], next_cursor: null, total: 1 })
      },
    })
    try {
      const source = { key: "sk-test-not-a-real-key", consoleURL: `http://127.0.0.1:${server.port}/` }
      const body = await Account.builderProjects(source)
      expect(seen[0]).toEqual({ path: "/api/v1/builder/sessions?limit=5", auth: "Bearer sk-test-not-a-real-key" })
      expect(History.builds(body)?.map((item) => item.id)).toEqual([SES(1)])
      status = 404
      expect(await Account.builderProjects(source)).toBeUndefined()
      status = 403
      expect(await Account.builderProjects(source)).toBeUndefined()
    } finally {
      server.stop(true)
    }
    expect(await Account.builderProjects({ key: "k", consoleURL: "http://127.0.0.1:9" }, 5, undefined, 500)).toBeUndefined()
  })
})
