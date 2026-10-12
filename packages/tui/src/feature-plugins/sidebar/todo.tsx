import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal } from "solid-js"
import { TodoItem } from "../../component/todo-item"
import * as RafikiAgents from "../rafiki-agents"

const id = "internal:sidebar-todo"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  // The list of the running subagent while it has one with work left (the
  // work happens there, the conversation's own list does not move), else
  // the conversation's latest list (rafiki-agents.tsx).
  const agent = createMemo(() => {
    const from = RafikiAgents.source(props.api)
    const item = RafikiAgents.active(from, props.session_id)
    if (!item?.sessionID) return undefined
    return from.todo(item.sessionID).some((todo) => todo.status !== "completed" && todo.status !== "cancelled")
      ? item
      : undefined
  })
  const list = createMemo(() => props.api.state.session.todo(agent()?.sessionID ?? props.session_id))
  const show = createMemo(() => list().length > 0 && list().some((item) => item.status !== "completed"))

  return (
    <Show when={show()}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <Show when={list().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text} wrapMode="none">
            <b>Todo</b>
            <Show when={agent()}>
              {(item) => <span style={{ fg: theme().textMuted }}> {RafikiAgents.clip(item().title, 28)}</span>}
            </Show>
          </text>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>{(item) => <TodoItem status={item.status} content={item.content} />}</For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    // Under the project description and the agents (rafiki-agents.tsx).
    order: 30,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
