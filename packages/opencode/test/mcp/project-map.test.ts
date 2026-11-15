// The project map's MCP server (rafiki/project-map.ts): with the map off the
// session gets no graphify server; the server the map registers shows only
// the code graph tools; a "graphify" server someone configured by hand keeps
// all of its tools.
import path from "node:path"
import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as ProjectMap from "@opencode-ai/core/brand/project-map"
import { Effect } from "effect"
import { MCP } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const fixture = path.join(import.meta.dir, "../fixture/mcp-graphify-stdio.ts")
delete process.env[ProjectMap.ENV]

it.instance("map off: no graphify server and no map tools", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    expect(Object.keys(yield* mcp.status())).not.toContain(ProjectMap.NAME)
    expect(Object.keys(yield* mcp.tools()).filter((name) => name.startsWith("graphify_"))).toEqual([])
  }),
)

it.instance("the map's server shows only the code graph tools", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    yield* mcp.add(ProjectMap.NAME, {
      type: "local",
      command: [process.execPath, fixture],
      environment: { [ProjectMap.MARKER]: "1" },
    })
    const tools = yield* mcp.tools()
    expect(Object.keys(tools).sort()).toEqual(ProjectMap.TOOLS.map((name) => `graphify_${name}`).sort())
    expect(tools["graphify_query_graph"]?.def.description).toContain("Project map")
    yield* mcp.disconnect(ProjectMap.NAME)
    expect(Object.keys(yield* mcp.tools())).toEqual([])
  }),
)

it.instance("a graphify server configured by hand keeps every tool", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    yield* mcp.add(ProjectMap.NAME, { type: "local", command: [process.execPath, fixture] })
    expect(Object.keys(yield* mcp.tools())).toHaveLength(10)
  }),
)
