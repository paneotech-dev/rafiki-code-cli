// Spend of the session on screen, from the gateway's own count: the status
// line on the prompt row (tier, spent this session, share of the key budget)
// and a Spend block in the sidebar (tier path, spent this session, key spent
// and budget, credits left, and when the figures were read). The figures and
// the wording come from the brand layer (core/brand/meter.ts).
//
// The key's spend and budget are read from the gateway (/key/info) and the
// credits from the Console (/api/v1/me): once when the interface starts,
// when a session is opened, and after each completed answer (debounced, and
// once more a little later because the gateway may count a request a moment
// after answering it). Never per streamed chunk, never in the way of the
// interface. A failed reading keeps the last figures and marks them stale.
// "This session" is the key's spend less its spend when the session started:
// the last reading taken before the session was created, or, for a session
// created before this interface started, the first reading after it opened.
import * as Account from "@opencode-ai/core/brand/account"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Cost from "@opencode-ai/core/brand/cost"
import * as Meter from "@opencode-ai/core/brand/meter"
import * as Tier from "@opencode-ai/core/brand/tier"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useLocal } from "../context/local"
import type { BuiltinTuiPlugin } from "./builtins"

const id = "internal:rafiki-cost"

// Room for the line on the prompt row: the terminal's width less the sidebar
// (shown from this width up, unless the person hid it), the frame of the
// prompt, and the agent and model labels on the left of the row. A line that
// does not fit is shortened (Meter.statusLine); the sidebar block has it all.
const SIDEBAR_FROM = 121
const SIDEBAR_WIDTH = 42
const FRAME = 8
const LABELS = 40
export function room(width: number) {
  return width - (width >= SIDEBAR_FROM ? SIDEBAR_WIDTH : 0) - FRAME - LABELS
}

// After an answer completes, the readings wait this long for more answers.
export const DEBOUNCE_MS = 1_500
// And are taken once more this long after, for requests the gateway counts late.
export const FOLLOW_UP_MS = 20_000
// Readings kept to find the one before a session was created.
const HISTORY = 50

type Read = () => Promise<Account.KeyInfoResult>
type Balance = () => Promise<number | undefined>

function defaultBalance() {
  const from = Account.source()
  return from ? Account.balance(from) : Promise.resolve(undefined)
}

export type MeterTracker = ReturnType<typeof createMeterTracker>

// The part without a screen: the readings, the start of each session, and
// when to read again.
export function createMeterTracker(
  api: TuiPluginApi,
  options: { read?: Read; balance?: Balance; now?: () => number; debounceMs?: number; followUpMs?: number } = {},
) {
  const now = options.now ?? Date.now
  const read: Read = options.read ?? (() => Account.keyInfo())
  const balance: Balance = options.balance ?? defaultBalance
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS
  const followUpMs = options.followUpMs ?? FOLLOW_UP_MS
  const [tick, setTick] = createSignal(0)
  const bump = () => setTick((value) => value + 1)

  // Good readings, oldest first; `at` is when the request for it was sent.
  const history: Meter.Reading[] = []
  let shared: Meter.State = Meter.empty()
  const starts = new Map<string, Meter.Reading | undefined>()
  const waiting = new Set<string>()
  let inflight: Promise<void> | undefined
  let again = false
  let debounce: ReturnType<typeof setTimeout> | undefined
  let followUp: ReturnType<typeof setTimeout> | undefined
  const started = now()

  async function once() {
    const at = now()
    const [key, credits] = await Promise.all([
      read().catch((): Account.KeyInfoResult => ({ ok: false, at })),
      balance().catch(() => undefined),
    ])
    if (key.ok) {
      const reading = Meter.reading(key.info, at)
      history.push(reading)
      if (history.length > HISTORY) history.shift()
      shared = Meter.update(shared, { key: reading, balance: credits, at })
      for (const session of waiting) starts.set(session, reading)
      waiting.clear()
    } else {
      shared = Meter.update(shared, { failed: true, balance: credits, at })
    }
    bump()
  }

  // One reading at a time; a request for one while it runs reads again after it.
  function refresh(): Promise<void> {
    if (inflight) {
      again = true
      return inflight
    }
    inflight = once().finally(() => {
      inflight = undefined
      if (again) {
        again = false
        void refresh()
      }
    })
    return inflight
  }

  // After an answer: once things settle, and once more later.
  function schedule() {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = undefined
      void refresh()
    }, debounceMs)
    if (followUp) clearTimeout(followUp)
    followUp = setTimeout(() => {
      followUp = undefined
      void refresh()
    }, followUpMs)
  }

  api.event?.on("message.updated", (event) => {
    const info = event.properties.info as { role?: string; time?: { completed?: number } }
    if (info.role === "assistant" && info.time?.completed) schedule()
  })
  api.event?.on("session.status", (event) => {
    if (event.properties.status.type === "idle") schedule()
  })

  // Called when a session comes on screen.
  function open(sessionID: string, created?: number) {
    if (starts.has(sessionID) || waiting.has(sessionID)) return refresh()
    const before = created !== undefined && created >= started ? history.findLast((item) => item.at <= created) : undefined
    if (before) starts.set(sessionID, before)
    else waiting.add(sessionID)
    bump()
    return refresh()
  }

  function state(sessionID: string): Meter.State {
    tick()
    return { ...shared, start: starts.get(sessionID) }
  }

  function calls(sessionID: string): Cost.Call[] {
    tick()
    return Cost.callsOf(api.state.session.messages(sessionID), true)
  }

  function dispose() {
    if (debounce) clearTimeout(debounce)
    if (followUp) clearTimeout(followUp)
  }

  return { open, state, calls, refresh, schedule, dispose }
}

export interface View {
  summary: Cost.Summary
  state: Meter.State
  // The tier selected for the next turn, when it differs from the last turn's.
  next?: string
}

export function view(tracker: MeterTracker, sessionID: string, selected?: string): View {
  const summary = Cost.summarize(tracker.calls(sessionID))
  const tier = Cost.tierOf(selected)
  return {
    summary,
    state: tracker.state(sessionID),
    next: tier && summary.tier && tier !== summary.tier ? `next turn on ${tier} (${Tier.credits(selected)})` : undefined,
  }
}

export function statusLine(value: View, width = Number.POSITIVE_INFINITY) {
  if (value.summary.path.length === 0) return ""
  return Meter.statusLine({ tier: value.summary.tier, next: value.next, state: value.state }, width)
}

function useView(props: { api: TuiPluginApi; tracker: MeterTracker; session_id: string }) {
  const local = useLocal()
  onMount(() => void props.tracker.open(props.session_id, props.api.state.session.get(props.session_id)?.time.created))
  return createMemo(() => {
    const selected = local.model.current()
    return view(props.tracker, props.session_id, selected?.providerID === Brand.provider.id ? selected.modelID : undefined)
  })
}

function StatusLine(props: { api: TuiPluginApi; tracker: MeterTracker; session_id: string }) {
  const theme = () => props.api.theme.current
  const dimensions = useTerminalDimensions()
  const value = useView(props)
  // The line printed with the exit lines of the interface (app.tsx).
  createEffect(() => {
    const text = statusLine(value())
    Cost.remember(text ? `Last session: ${text}` : undefined)
  })
  const line = createMemo(() => statusLine(value(), room(dimensions().width)))
  return (
    <Show when={line()}>
      <text fg={value().next || value().state.stale ? theme().warning : theme().textMuted} wrapMode="none">
        {line()}
      </text>
    </Show>
  )
}

function Sidebar(props: { api: TuiPluginApi; tracker: MeterTracker; session_id: string }) {
  const theme = () => props.api.theme.current
  const value = useView(props)
  const rows = createMemo(() => Meter.lines(value().state))
  return (
    <Show when={value().summary.path.length > 0 || rows().length > 0}>
      <box>
        <text fg={theme().text}>
          <b>Spend</b>
        </text>
        <Show when={value().summary.path.length > 0}>
          <text fg={theme().textMuted}>Tiers: {Cost.pathText(value().summary.path)}</text>
        </Show>
        <For each={rows()}>
          {(row) => (
            <text fg={theme().textMuted}>
              {row.label}: {row.value}
            </text>
          )}
        </For>
        <Show when={Meter.freshness(value().state)}>
          {(text) => <text fg={value().state.stale ? theme().warning : theme().textMuted}>{text()}</text>}
        </Show>
        <Show when={value().next}>{(text) => <text fg={theme().warning}>{text()}</text>}</Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  const tracker = createMeterTracker(api)
  // A first reading when the interface starts: the start of a session created from here.
  void tracker.refresh()
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
