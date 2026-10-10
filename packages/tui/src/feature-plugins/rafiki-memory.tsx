// /memory: shows the project memory in .rafiki/memory/ (core/brand/memory.ts)
// and lets the person edit each file in their editor ($VISUAL or $EDITOR).
// Without an editor, a file is shown with its path to edit it elsewhere. A
// saved file goes through the same secret scan as the agent's writes.
import * as Memory from "@opencode-ai/core/brand/memory"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { openEditor } from "../editor"
import type { BuiltinTuiPlugin } from "./builtins"

const id = "internal:rafiki-memory"
export const COMMAND = "memory.show"
const TITLE = "Project memory"
const ENV = "RAFIKICODE_MEMORY"

type Choice = { kind: "file"; section: Memory.Section } | { kind: "about" }

function kb(bytes: number) {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`
}

export function project(api: Pick<TuiPluginApi, "state">) {
  return Memory.root(api.state.path.directory, api.state.path.worktree)
}

function settings(api: Pick<TuiPluginApi, "state">) {
  return (api.state.config as { memory?: Memory.Settings } | undefined)?.memory
}

export function isOn(api: Pick<TuiPluginApi, "state">, env: Record<string, string | undefined> = process.env) {
  return Memory.enabled(settings(api), env[ENV])
}

// The text of the "About" entry: where the memory is, how big, how to turn it off.
export function about(api: Pick<TuiPluginApi, "state">, env: Record<string, string | undefined> = process.env) {
  const root = project(api)
  const status = Memory.status(root, Memory.cap(settings(api)))
  return [
    `Folder: ${status.dir}`,
    `Size: ${kb(status.total)} of ${kb(status.limit)}.`,
    isOn(api, env) ? "State: on. Each session reads it at the start; the agent keeps it current with memory_update." : "State: off.",
    ...(status.error ? [`Problem: ${status.error}.`] : []),
    "",
    "Edit any file here or in your editor. Never put keys or passwords in it: a save that looks like one is refused.",
    ...(status.git ? ["This is a git repository: commit .rafiki/memory/ with the project if you want to keep it. Nothing commits it for you."] : []),
    "",
    'Turn it off with "memory": { "enabled": false } in rafikicode.json, or RAFIKICODE_MEMORY=0.',
  ].join("\n")
}

async function edit(api: TuiPluginApi, section: Memory.Section) {
  const root = project(api)
  const file = Memory.SECTIONS[section].file
  const current = Memory.read(root)[section]
  const value = current.trim() === "" ? Memory.header(section) + "\n" : current
  const editor = process.env.VISUAL || process.env.EDITOR
  if (!editor) {
    api.ui.dialog.replace(() => (
      <api.ui.DialogAlert
        title={`${TITLE}: ${file}`}
        message={[value.trimEnd(), "", `Edit it at ${root}/${Memory.DIR_POSIX}/${file}, or set VISUAL or EDITOR to edit it from here.`].join("\n")}
      />
    ))
    return
  }
  api.ui.dialog.clear()
  const edited = await openEditor({ value, renderer: api.renderer, cwd: root }).catch((error: unknown) => {
    api.ui.toast({ variant: "error", message: error instanceof Error ? error.message : String(error) })
    return undefined
  })
  if (edited === undefined || edited === value) return
  const outcome = Memory.save(root, section, edited)
  api.ui.toast({ variant: outcome.ok ? "success" : "error", message: outcome.message })
}

export function show(api: TuiPluginApi) {
  const root = project(api)
  const status = Memory.status(root, Memory.cap(settings(api)))
  const on = isOn(api)
  const options = [
    ...status.items.map((item) => ({
      title: item.file,
      value: { kind: "file", section: item.section } as Choice,
      description: `${item.purpose} (${item.empty ? "empty" : kb(item.bytes)})`,
    })),
    {
      title: "About the memory",
      value: { kind: "about" } as Choice,
      description: on ? `${kb(status.total)} of ${kb(status.limit)}, on` : "off",
    },
  ]
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect<Choice>
      title={on ? TITLE : `${TITLE} (off)`}
      options={options}
      onSelect={(option) => {
        const choice = option.value
        if (choice.kind === "about") {
          api.ui.dialog.replace(() => <api.ui.DialogAlert title={TITLE} message={about(api)} />)
          return
        }
        void edit(api, choice.section)
      }}
    />
  ))
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: COMMAND,
        title: "Memory: show and edit the project memory",
        category: "Project",
        namespace: "palette",
        slashName: "memory",
        run() {
          show(api)
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
