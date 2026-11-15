// /map: builds or refreshes the project map (core/brand/project-map.ts), a
// code graph made by graphify on this machine (code only, no model), and
// gives the agent its tools for this session. "/map off" takes the tools
// away again. The map is never added to the prompt: the agent calls a tool
// when it needs to know where something lives or what calls it.
// graphify is never installed from here; when it is missing, the one-line
// install command for this system is shown.
import { Global } from "@opencode-ai/core/global"
import * as ProjectMap from "@opencode-ai/core/brand/project-map"
import { which } from "@opencode-ai/core/util/which"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "./builtins"

const id = "internal:rafiki-map"
export const COMMAND = "map.build"
export const COMMAND_OFF = "map.off"
const TITLE = "Project map"

// Typed text that runs a map command (a keymap slash command takes no arguments).
export const TYPED: Record<string, string> = {
  "/map off": COMMAND_OFF,
}

// Set by the prompt (component/prompt/index.tsx): reloads the MCP status the
// interface shows (/mcps, the status bar), which is read once at start.
export const refresh: { mcp?: () => Promise<void> } = {}

export interface Io {
  platform: NodeJS.Platform
  cache: string
  detect(): ProjectMap.Launcher | undefined
  which(cmd: string): string | null
  build: typeof ProjectMap.build
}

export function defaults(): Io {
  return {
    platform: process.platform,
    cache: Global.Path.cache,
    detect: () =>
      ProjectMap.detect({ platform: process.platform, which: (cmd) => which(cmd), probe: ProjectMap.defaultProbe }),
    which: (cmd) => which(cmd),
    build: ProjectMap.build,
  }
}

let running = false

export async function build(api: TuiPluginApi, io: Io = defaults()) {
  if (running) return
  running = true
  try {
    const directory = api.state.path.directory
    const launcher = io.detect()
    if (!launcher) {
      const message = ProjectMap.missingMessage(io.platform, io.which)
      api.ui.dialog.replace(() => <api.ui.DialogAlert title={`${TITLE}: graphify missing`} message={message} />)
      return { status: "missing" as const, message }
    }
    api.ui.toast({ variant: "info", message: `${TITLE}: building with graphify (code only, on this machine)` })
    let last = 0
    const result = await io.build(launcher, directory, io.cache, {
      onLine(line) {
        // One progress toast every second at most.
        if (Date.now() - last < 1000) return
        last = Date.now()
        api.ui.toast({ variant: "info", message: `${TITLE}: ${line.replace(/^\[graphify extract\]\s*/, "")}` })
      },
    })
    const summary = ProjectMap.summary(result)
    if (!result.ok) {
      api.ui.dialog.replace(() => <api.ui.DialogAlert title={`${TITLE}: not built`} message={summary} />)
      return { status: "failed" as const, message: summary }
    }
    const entry = ProjectMap.mcpEntry(launcher, directory, io.cache)
    const added = await api.client.mcp.add({ name: ProjectMap.NAME, config: entry }).catch(() => undefined)
    await refresh.mcp?.().catch(() => {})
    const status = (added?.data as Record<string, { status: string; error?: string }> | undefined)?.[ProjectMap.NAME]
    const connected = status?.status === "connected"
    const message = [
      summary,
      `Folder: ${directory}`,
      `Saved in: ${ProjectMap.outDir(directory, io.cache)} (nothing is written into the project)`,
      connected
        ? `The agent can now call ${ProjectMap.TOOLS.map((tool) => `${ProjectMap.NAME}_${tool}`).join(", ")} for this session. Nothing is added to the prompt.`
        : `The map server did not start${status?.error ? `: ${status.error}` : ""}.`,
      "",
      '"/map" again refreshes it after big changes; "/map off" removes the tools for this session.',
    ].join("\n")
    api.ui.dialog.replace(() => <api.ui.DialogAlert title={TITLE} message={message} />)
    return { status: connected ? ("ready" as const) : ("failed" as const), message }
  } finally {
    running = false
  }
}

export async function off(api: TuiPluginApi) {
  const result = await api.client.mcp.disconnect({ name: ProjectMap.NAME }).catch(() => undefined)
  await refresh.mcp?.().catch(() => {})
  const message = result?.data
    ? `${TITLE} off for this session: the agent no longer has the map tools. "/map" turns it back on.`
    : `${TITLE} was not on in this session.`
  api.ui.toast({ variant: "info", message })
  return message
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: COMMAND,
        title: "Map: build or refresh the project map (graphify) for the agent",
        category: "Project",
        namespace: "palette",
        slashName: "map",
        run() {
          void build(api)
        },
      },
      {
        name: COMMAND_OFF,
        title: "Map: turn the project map off for this session",
        category: "Project",
        namespace: "palette",
        run() {
          void off(api)
        },
      },
    ],
    bindings: [],
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
