// /map: the plugin registers /map and the "map off" command, "/map off" typed
// in the prompt reaches it, a missing graphify gives the one-line install
// command and nothing else, a build registers the map's MCP server, and
// "map off" disconnects it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as ProjectMap from "@opencode-ai/core/brand/project-map"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"
import plugin, { COMMAND, COMMAND_OFF, TYPED, build, off, type Io } from "../../src/feature-plugins/rafiki-map"

let dir: string
let cache: string

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-tui-map-")))
  cache = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-tui-map-cache-")))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(cache, { recursive: true, force: true })
})

function fake(mcpStatus = "connected") {
  const calls = { added: [] as any[], disconnected: [] as string[], dialogs: 0, toasts: [] as string[] }
  const api = {
    state: { path: { directory: dir, worktree: "/", state: "", config: "" }, config: {} },
    ui: {
      dialog: { replace: () => calls.dialogs++ },
      toast: (toast: { message: string }) => calls.toasts.push(toast.message),
      DialogAlert: () => null,
    },
    client: {
      mcp: {
        add: async (input: { name: string; config: unknown }) => {
          calls.added.push(input)
          return { data: { [input.name]: { status: mcpStatus } } }
        },
        disconnect: async (input: { name: string }) => {
          calls.disconnected.push(input.name)
          return { data: true }
        },
      },
    },
  } as unknown as TuiPluginApi
  return { api, calls }
}

function io(overrides: Partial<Io> = {}): Io {
  return {
    platform: "linux",
    cache,
    detect: () => ({ via: "path", cli: ["graphify"], mcp: ["graphify-mcp"] }),
    which: () => null,
    build: async (_launcher, root, base, options) => {
      options?.onLine?.("[graphify extract] found 2 code, 0 docs, 0 papers, 0 images")
      return { ok: true, files: 2, nodes: 6, edges: 8, ms: 650, graph: ProjectMap.graphFile(root, base) }
    },
    ...overrides,
  }
}

describe("the map plugin", () => {
  test("is a built in plugin with /map and the off command", async () => {
    expect(createBuiltinPlugins({ experimentalEventSystem: false }).map((item) => item.id)).toContain("internal:rafiki-map")
    const layers: any[] = []
    await plugin.tui({ keymap: { registerLayer: (layer: unknown) => layers.push(layer) } } as unknown as TuiPluginApi, undefined, {} as never)
    const names = layers[0].commands.map((command: { name: string }) => command.name)
    expect(names).toEqual([COMMAND, COMMAND_OFF])
    expect(layers[0].commands[0].slashName).toBe("map")
  })

  test('"/map off" typed in the prompt runs the off command; nothing else does', () => {
    expect(TYPED["/map off"]).toBe(COMMAND_OFF)
    expect(Object.hasOwn(TYPED, "/map")).toBe(false)
    expect(Object.hasOwn(TYPED, "constructor")).toBe(false)
  })

  test("graphify missing: the install line, no build, no server", async () => {
    const { api, calls } = fake()
    let built = false
    const result = await build(
      api,
      io({
        detect: () => undefined,
        platform: "win32",
        build: async () => {
          built = true
          throw new Error("no")
        },
      }),
    )
    expect(result?.status).toBe("missing")
    expect(result?.message).toContain('py -m pip install --user "graphifyy[mcp]"')
    expect(built).toBe(false)
    expect(calls.added).toEqual([])
  })

  test("a build registers the map server with the code-only, no-backend environment", async () => {
    const { api, calls } = fake()
    const result = await build(api, io())
    expect(result?.status).toBe("ready")
    expect(result?.message).toContain("2 code files")
    expect(result?.message).toContain("graphify_query_graph")
    expect(calls.added).toHaveLength(1)
    expect(calls.added[0].name).toBe("graphify")
    expect(calls.added[0].config.environment.GRAPHIFY_BACKEND).toBe("none")
    expect(calls.added[0].config.command.at(-1)).toBe(ProjectMap.graphFile(dir, cache))
    expect(calls.toasts.some((message) => message.includes("found 2 code"))).toBe(true)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  test("a failed build registers nothing", async () => {
    const { api, calls } = fake()
    const result = await build(
      api,
      io({ build: async (_l, root, base) => ({ ok: false, files: 0, nodes: 0, edges: 0, ms: 5, graph: ProjectMap.graphFile(root, base), error: "boom" }) }),
    )
    expect(result?.status).toBe("failed")
    expect(calls.added).toEqual([])
  })

  test("off disconnects the map server", async () => {
    const { api, calls } = fake()
    const message = await off(api)
    expect(calls.disconnected).toEqual(["graphify"])
    expect(message).toContain("off for this session")
  })
})
