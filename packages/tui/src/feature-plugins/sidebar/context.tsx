import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import * as ContextUsage from "@opencode-ai/core/brand/context"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) return ContextUsage.usage(undefined, undefined)
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return ContextUsage.usage(last.tokens, model?.limit.context)
  })

  // "2% of 1M used": the window is named, so the share can be checked.
  const used = createMemo(() => {
    const value = state()
    return `${value.percent ?? "0%"}${value.window ? ` of ${ContextUsage.windowText(value.window)}` : ""} used`
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <Show when={state().cached > 0}>
        <text fg={theme().textMuted}>{state().cached.toLocaleString()} cached</text>
      </Show>
      <text fg={theme().textMuted}>{used()}</text>
      {/* The Rafiki tiers carry no price here, so this would always read $0.00; the cost block below it has the estimate. */}
      <Show when={cost() > 0}>
        <text fg={theme().textMuted}>{money.format(cost())} spent</text>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
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
