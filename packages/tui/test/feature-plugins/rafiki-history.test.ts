// The History panel's list: read from the server's session list across
// folders (directory left empty so the route does not narrow it to this
// folder), only when a view asks for it, and again once session updates
// settle.
import { describe, expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"
import { createHistory, load, openBuild } from "../../src/feature-plugins/rafiki-history"
import { createTuiPluginApi } from "../fixture/tui-plugin"

const session = (id: string, directory: string, updated: number, model?: string) => ({
  id,
  title: `t ${id}`,
  directory,
  time: { created: updated, updated },
  ...(model ? { model: { id: model, providerID: "rafiki" } } : {}),
})

function harness(list: unknown[] | Error) {
  const queries: unknown[] = []
  const handlers = new Map<string, (event: any) => void>()
  const api = createTuiPluginApi({
    event: { on: (type: string, handler: (event: any) => void) => (handlers.set(type, handler), () => {}) } as TuiPluginApi["event"],
    client: {
      experimental: {
        session: {
          list: async (query: unknown) => {
            queries.push(query)
            if (list instanceof Error) throw list
            return { data: list }
          },
        },
      },
    } as never,
  })
  return { api, queries, emit: (type: string) => handlers.get(type)?.({ type, properties: {} }) }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("the history plugin", () => {
  test("is one of the built in plugins", () => {
    expect(createBuiltinPlugins({ experimentalEventSystem: false }).map((plugin) => plugin.id)).toContain("internal:rafiki-history")
  })

  test("reads every folder's conversations, newest first, and the folders they were in", async () => {
    const { api, queries } = harness([session("a", "/w/one", 1, "rafiki-max"), session("b", "/w/two", 3), session("c", "/w/one", 2)])
    const value = await load(api, 20)
    expect(queries).toEqual([{ directory: "", roots: true, limit: 20 }])
    expect(value.conversations.map((item) => [item.id, item.tier])).toEqual([
      ["b", undefined],
      ["c", undefined],
      ["a", "max"],
    ])
    expect(value.projects.map((item) => [item.directory, item.conversations])).toEqual([
      ["/w/two", 1],
      ["/w/one", 2],
    ])
  })

  test("a server that does not answer gives an empty list, not an error", async () => {
    const { api } = harness(new Error("down"))
    expect(await load(api)).toEqual({ conversations: [], projects: [] })
  })

  test("nothing is read until a view asks, then again once updates settle", async () => {
    const { api, queries, emit } = harness([session("a", "/w", 1)])
    const store = createHistory(api, 10, 10)
    emit("session.updated")
    await wait(30)
    expect(queries).toHaveLength(0)
    store.ensure()
    store.ensure()
    await wait(5)
    expect(queries).toHaveLength(1)
    expect(store.data()?.conversations).toHaveLength(1)
    emit("session.updated")
    emit("session.updated")
    emit("session.updated")
    await wait(40)
    expect(queries).toHaveLength(2)
  })
})

describe("builds", () => {
  const build = (n: number) => ({
    id: `ses_7d2f9a1e-0000-4000-8000-00000000000${n}`,
    title: `Salon ${n}`,
    status: "stopped",
    updated: n,
    url: `https://code.rafikiai.io/build?session=ses_7d2f9a1e-0000-4000-8000-00000000000${n}`,
  })

  test("read on their own when a view first asks, never before, and hidden when the Console lists none", async () => {
    const { api, queries } = harness([session("a", "/w", 1)])
    let reads = 0
    let answer: unknown = [build(1)]
    const store = createHistory(api, 10, 10, async () => {
      reads++
      if (answer instanceof Error) throw answer
      return answer as never
    })
    await wait(5)
    expect(reads).toBe(0)
    store.ensure()
    await wait(5)
    expect(reads).toBe(1)
    expect(queries).toHaveLength(1)
    expect(store.builds()?.map((item) => item.title)).toEqual(["Salon 1"])
    answer = undefined
    await store.refreshBuilds()
    expect(store.builds()).toBeUndefined()
    answer = new Error("404")
    await store.refreshBuilds()
    expect(store.builds()).toBeUndefined()
    answer = []
    await store.refreshBuilds()
    expect(store.builds()).toBeUndefined()
  })

  test("a slow builds answer does not hold the conversations", async () => {
    const { api } = harness([session("a", "/w", 1)])
    const store = createHistory(api, 10, 10, () => new Promise(() => {}))
    store.ensure()
    await wait(5)
    expect(store.data()?.conversations).toHaveLength(1)
    expect(store.builds()).toBeUndefined()
  })

  test("opens the builder page in the browser, or shows its address", async () => {
    const toasts: { message: string }[] = []
    const api = { ui: { toast: (input: { message: string }) => toasts.push(input) } } as never
    const opened: string[] = []
    await openBuild(api, build(1), { browser: true, open: async (url) => opened.push(url) })
    expect(opened).toEqual([build(1).url])
    expect(toasts.at(-1)?.message).toContain("in the browser")
    await openBuild(api, build(2), { browser: false, open: async (url) => opened.push(url) })
    expect(opened).toHaveLength(1)
    expect(toasts.at(-1)?.message).toBe(`Open in a browser: ${build(2).url}`)
    await openBuild(api, build(3), { browser: true, open: async () => Promise.reject(new Error("no xdg-open")) })
    expect(toasts.at(-1)?.message).toBe(`Open in a browser: ${build(3).url}`)
  })
})
