// /memory: the plugin registers the slash command, and its text says where the
// memory is, how big it is against the cap, whether it is on, and how to turn
// it off; in a git repository it says the memory is never committed for you.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as Memory from "@opencode-ai/core/brand/memory"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"
import plugin, { COMMAND, about, isOn, project } from "../../src/feature-plugins/rafiki-memory"

let dir: string

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-tui-memory-")))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function api(config: unknown = {}, worktree = "/") {
  return { state: { path: { directory: dir, worktree, state: "", config: "" }, config } } as unknown as Pick<TuiPluginApi, "state">
}

describe("the memory plugin", () => {
  test("is one of the built in plugins, and /memory is its command", async () => {
    expect(createBuiltinPlugins({ experimentalEventSystem: false }).map((item) => item.id)).toContain("internal:rafiki-memory")
    const layers: any[] = []
    await plugin.tui({ keymap: { registerLayer: (layer: unknown) => layers.push(layer) } } as unknown as TuiPluginApi, undefined, {} as never)
    expect(layers[0].commands[0].name).toBe(COMMAND)
    expect(layers[0].commands[0].slashName).toBe("memory")
  })

  test("the project is the repository root, or the folder outside git", () => {
    expect(project(api({}, "/"))).toBe(dir)
    expect(project(api({}, "/work/repo"))).toBe("/work/repo")
  })

  test("on by default; the config and RAFIKICODE_MEMORY turn it off, the variable wins", () => {
    expect(isOn(api(), {})).toBe(true)
    expect(isOn(api({ memory: { enabled: false } }), {})).toBe(false)
    expect(isOn(api({ memory: { enabled: false } }), { RAFIKICODE_MEMORY: "1" })).toBe(true)
    expect(isOn(api(), { RAFIKICODE_MEMORY: "0" })).toBe(false)
  })

  test("about: folder, size against the cap, state, the secret rule, git and how to turn it off", () => {
    Memory.update(dir, { section: "notes", operation: "append", text: "Use pnpm." })
    const text = about(api(), {})
    expect(text).toContain(`Folder: ${path.join(dir, ".rafiki", "memory")}`)
    expect(text).toMatch(/Size: \d+ bytes of 8\.0 KB\./)
    expect(text).toContain("State: on.")
    expect(text).toContain("Never put keys or passwords in it")
    expect(text).not.toContain("git repository")
    expect(text).toContain('"memory": { "enabled": false }')
    fs.mkdirSync(path.join(dir, ".git"))
    expect(about(api({ memory: { enabled: false } }), {})).toContain("Nothing commits it for you.")
    expect(about(api({ memory: { enabled: false } }), {})).toContain("State: off.")
  })
})
