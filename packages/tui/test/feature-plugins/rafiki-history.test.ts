// The History panel's list: read from the server's session list across
// folders (directory left empty so the route does not narrow it to this
// folder), only when a view asks for it, and again once session updates
// settle.
import { describe, expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"
import { createHistory, load } from "../../src/feature-plugins/rafiki-history"
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
