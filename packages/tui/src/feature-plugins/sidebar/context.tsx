import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import * as ContextUsage from "@opencode-ai/core/brand/context"

const id = "internal:sidebar-context"

// The last request of the session as the gateway reported it: what it sent,
// how much of that was read from the cache, the share of the window of the
// tier that answered, and what came back. Spend is in the Spend block below
// (rafiki-cost.tsx), read from the gateway.
function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) return undefined
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return { usage: ContextUsage.usage(last.tokens, model?.limit.context), name: model?.name ?? last.modelID }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <Show when={state()} fallback={<text fg={theme().textMuted}>no request yet</text>}>
        {(value) => (
          <>
            <text fg={theme().textMuted}>Last request sent {value().usage.sent.toLocaleString("en-US")} tokens</text>
            <Show when={value().usage.cached > 0}>
              <text fg={theme().textMuted}>{value().usage.cached.toLocaleString("en-US")} of them cached</text>
            </Show>
            <Show when={value().usage.window}>
              {(window) => (
                <text fg={theme().textMuted}>
                  {value().usage.percent} of the {ContextUsage.windowText(window())} window of {value().name}
                </text>
              )}
            </Show>
            <text fg={theme().textMuted}>{value().usage.received.toLocaleString("en-US")} tokens received</text>
          </>
        )}
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
