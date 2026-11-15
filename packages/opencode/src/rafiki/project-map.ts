// The project map for a session (core/brand/project-map.ts holds the
// details): when it is on and graphify is installed, the map is built or
// refreshed and graphify's MCP server is registered under the name
// "graphify", so the agent can call its tools. When it is off nothing here
// runs: no detection, no process, no tool.
import fs from "fs"
import { Global } from "@opencode-ai/core/global"
import * as ProjectMap from "@opencode-ai/core/brand/project-map"
import { which } from "@opencode-ai/core/util/which"

export type Start =
  | { kind: "off" }
  | { kind: "configured" }
  | { kind: "missing"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "ready"; entry: ReturnType<typeof ProjectMap.mcpEntry>; build: ProjectMap.BuildResult }

export interface StartInput {
  settings: ProjectMap.Settings | undefined
  directory: string
  // An "mcp" entry named graphify that the person configured: theirs wins.
  configured: boolean
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  cache?: string
  detect?: () => ProjectMap.Launcher | undefined
  build?: typeof ProjectMap.build
}

export function detect(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env) {
  return ProjectMap.detect({ platform, which: (cmd) => which(cmd, env), probe: ProjectMap.defaultProbe })
}

export async function start(input: StartInput): Promise<Start> {
  const env = input.env ?? process.env
  if (!ProjectMap.enabled(input.settings, env[ProjectMap.ENV])) return { kind: "off" }
  if (input.configured) return { kind: "configured" }
  const platform = input.platform ?? process.platform
  const launcher = input.detect ? input.detect() : detect(platform, env as NodeJS.ProcessEnv)
  if (!launcher)
    return { kind: "missing", message: ProjectMap.missingMessage(platform, (cmd) => which(cmd, env as NodeJS.ProcessEnv)) }
  const cache = input.cache ?? Global.Path.cache
  const build = await (input.build ?? ProjectMap.build)(launcher, input.directory, cache, {
    timeoutMs: ProjectMap.START_BUILD_MS,
    env,
  })
  // A failed refresh still serves the last good graph; with none there is nothing to serve.
  if (!build.ok && !fs.existsSync(build.graph)) return { kind: "failed", message: ProjectMap.summary(build) }
  return { kind: "ready", entry: ProjectMap.mcpEntry(launcher, input.directory, cache, env), build }
}
