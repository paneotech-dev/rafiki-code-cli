// The project in two sentences, at the top of the sidebar: from the project
// memory (.rafiki/memory/project.md), else the first paragraph of AGENTS.md
// or README.md (core/brand/about.ts). Files only, no model call. The files
// are checked every few seconds (their size and change time) and read again
// when one changed, so an edit of the memory shows without a restart.
import * as About from "@opencode-ai/core/brand/about"
import * as Memory from "@opencode-ai/core/brand/memory"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, Show } from "solid-js"
import type { BuiltinTuiPlugin } from "./builtins"

const id = "internal:rafiki-about"
export const CHECK_MS = 2_000

export function project(api: Pick<TuiPluginApi, "state">) {
  return Memory.root(api.state.path.directory, api.state.path.worktree)
}

// The description as a signal, read again when a source file changes.
export function createAbout(read: () => string, every = CHECK_MS) {
  let stamp = ""
  const [value, setValue] = createSignal<About.About | undefined>()
  const check = () => {
    const root = read()
    const next = `${root}|${About.stamp(root)}`
    if (next === stamp) return
    stamp = next
    setValue(About.describe(root))
  }
  check()
  const timer = setInterval(check, every)
  onCleanup(() => clearInterval(timer))
  return { value, check }
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const about = createAbout(() => project(props.api))
  return (
    <Show when={about.value()}>
      {(value) => (
        <box>
          <text fg={theme().text}>
            <b>Project</b>
          </text>
          <text fg={theme().textMuted} wrapMode="word">
            {value().text}
          </text>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    // First in the sidebar, under the conversation title.
    order: 10,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
