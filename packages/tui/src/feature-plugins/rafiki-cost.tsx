// Cost of the task on screen: the status line on the prompt row (tier, spent
// so far, credits left, and the estimate for the next turn before a tier
// change) and a block in the sidebar. The figures and every text come from
// the brand layer (core/brand/cost.ts); this file gathers the task's model
// calls and reads the balance and the price list once per task.
//
// Token counts are measured (the usage block of each gateway answer). USD
// amounts are estimates from the gateway's price list and are worded as such.
import * as Account from "@opencode-ai/core/brand/account"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Cost from "@opencode-ai/core/brand/cost"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js"
import { useLocal } from "../context/local"
import type { BuiltinTuiPlugin } from "./builtins"

const id = "internal:rafiki-cost"

// Subagents of subagents are followed this deep when a session is opened.
const DEPTH = 3
// Room for the line on the prompt row: the terminal's width less the sidebar
// (shown from this width up, unless the person hid it), the frame of the
// prompt, and the agent and model labels on the left of the row. A line that
// does not fit is shortened (Cost.statusLine); the sidebar block has it all.
const SIDEBAR_FROM = 121
const SIDEBAR_WIDTH = 42
const FRAME = 8
const LABELS = 40
export function room(width: number) {
  return width - (width >= SIDEBAR_FROM ? SIDEBAR_WIDTH : 0) - FRAME - LABELS
}

type Start = { balance?: number; prices?: Cost.Prices; spent: number }

export type CostTracker = ReturnType<typeof createCostTracker>

// The part without a screen: which calls belong to a task, and its readings.
export function createCostTracker(api: TuiPluginApi, options: { snapshot?: () => Promise<Account.Snapshot> } = {}) {
  const takeSnapshot = options.snapshot ?? Account.snapshot
  // Subagent session -> the session that started it.
  const parents = new Map<string, string>()
  // Calls made in subagent sessions, by message id.
  const children = new Map<string, { session: string; call: Cost.Call }>()
  const starts = new Map<string, Start>()
  const opened = new Set<string>()
  const [tick, setTick] = createSignal(0)
  const bump = () => setTick((value) => value + 1)

  function rootOf(sessionID: string) {
    let current = sessionID
    for (let depth = 0; depth <= DEPTH + 1 && parents.has(current); depth++) current = parents.get(current)!
    return current
  }

  function link(info: { id: string; parentID?: string }) {
    if (info.parentID && parents.get(info.id) !== info.parentID) {
      parents.set(info.id, info.parentID)
      bump()
    }
  }

  function record(sessionID: string, message: Cost.MessageLike) {
    if (!parents.has(sessionID)) return
    const [call] = Cost.callsOf([message], false)
    if (!call) return
    children.set(call.id, { session: sessionID, call })
    bump()
  }

  api.event?.on("session.created", (event) => link(event.properties.info))
  api.event?.on("session.updated", (event) => link(event.properties.info))
  api.event?.on("message.updated", (event) => record(event.properties.sessionID, event.properties.info))
  // When a turn of a task on screen ends, list its subagent sessions once
  // more: a call the event stream did not carry is still counted.
  api.event?.on("session.status", (event) => {
    if (event.properties.status.type !== "idle" || !opened.has(event.properties.sessionID)) return
    void adopt(event.properties.sessionID, 1).catch(() => undefined)
  })

  function calls(sessionID: string): Cost.Call[] {
    tick()
    const own = Cost.callsOf(api.state.session.messages(sessionID), true)
    const sub = [...children.values()].filter((item) => rootOf(item.session) === sessionID).map((item) => item.call)
    return [...own, ...sub]
  }

  // Subagent sessions that already exist when a session is opened.
  async function adopt(parent: string, depth: number): Promise<void> {
    if (depth > DEPTH) return
    const list = (await api.client.session.children({ sessionID: parent })).data ?? []
    for (const child of list) {
      link({ id: child.id, parentID: parent })
      const messages = (await api.client.session.messages({ sessionID: child.id })).data ?? []
      for (const item of messages) record(child.id, item.info)
      await adopt(child.id, depth + 1)
    }
  }

  // Called when a session comes on screen: the start of the task as far as
  // this interface is concerned. Reads the balance and the price list once.
  async function open(sessionID: string) {
    if (opened.has(sessionID)) return
    opened.add(sessionID)
    await adopt(sessionID, 1).catch(() => undefined)
    const snapshot = await takeSnapshot().catch((): Account.Snapshot => ({ at: Date.now() }))
    starts.set(sessionID, {
      balance: snapshot.balance,
      prices: snapshot.prices,
      // What the task had already spent when the balance was read.
      spent: Cost.summarize(calls(sessionID), snapshot.prices).spent,
    })
    bump()
  }

  function display(sessionID: string, selected?: string): Cost.Display {
    tick()
    const start = starts.get(sessionID)
    return Cost.display({
      calls: calls(sessionID),
      prices: start?.prices,
      start: start?.balance === undefined ? undefined : { balance: start.balance, spent: start.spent },
      selected,
    })
  }

  function start(sessionID: string) {
    tick()
    return starts.get(sessionID)
  }

  return { open, display, start, calls }
}

function useDisplay(props: { tracker: CostTracker; session_id: string }) {
  const local = useLocal()
  onMount(() => void props.tracker.open(props.session_id))
  return createMemo(() => {
    const selected = local.model.current()
    return props.tracker.display(props.session_id, selected?.providerID === Brand.provider.id ? selected.modelID : undefined)
  })
}

// Shown only for a task that runs on Rafiki tiers.
const relevant = (view: Cost.Display) => view.summary.path.length > 0

function StatusLine(props: { api: TuiPluginApi; tracker: CostTracker; session_id: string }) {
  const theme = () => props.api.theme.current
  const dimensions = useTerminalDimensions()
  const view = useDisplay(props)
  // The end of task line, printed with the exit lines of the interface (app.tsx).
  createEffect(() => Cost.remember(Cost.taskLine(view())))
  const line = createMemo(() => (relevant(view()) ? Cost.statusLine(view(), room(dimensions().width)) : ""))
  return (
    <Show when={line()}>
      <text fg={view().next ? theme().warning : theme().textMuted} wrapMode="none">
        {line()}
      </text>
    </Show>
  )
}

function Sidebar(props: { api: TuiPluginApi; tracker: CostTracker; session_id: string }) {
  const theme = () => props.api.theme.current
  const view = useDisplay(props)
  const start = createMemo(() => props.tracker.start(props.session_id))
  return (
    <Show when={relevant(view())}>
      <box>
        <text fg={theme().text}>
          <b>Cost</b>
        </text>
        <text fg={theme().textMuted}>Tiers: {Cost.pathText(view().summary.path)}</text>
        <text fg={theme().textMuted}>{Cost.spentText(view().summary)}</text>
        <Show when={Cost.savedText(view().summary)}>{(text) => <text fg={theme().textMuted}>{text()}</text>}</Show>
        <Show when={Cost.leftText(view().left, view().summary)}>{(text) => <text fg={theme().textMuted}>{text()}</text>}</Show>
        <Show when={view().summary.priced > 0 && start()?.balance !== undefined}>
          <text fg={theme().textMuted}>{Cost.usd(start()!.balance!)} when the task started</text>
        </Show>
        <Show when={Cost.nextText(view().next)}>{(text) => <text fg={theme().warning}>{text()}</text>}</Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  const tracker = createCostTracker(api)
  api.slots.register({
    // Right under the context block.
    order: 150,
    slots: {
      session_prompt_right(_ctx, props) {
        return <StatusLine api={api} tracker={tracker} session_id={props.session_id} />
      },
      sidebar_content(_ctx, props) {
        return <Sidebar api={api} tracker={tracker} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
