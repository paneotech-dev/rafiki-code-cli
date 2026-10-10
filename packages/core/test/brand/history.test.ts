// Recent conversations and projects (src/brand/history.ts): from the session
// list the server already keeps, newest first, and how a pick in another
// folder is handed to the command that restarts the interface there.
import { describe, expect, test } from "bun:test"
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
