// Agents: the subagents of the conversation on screen (each run of the task
// tool, in its own child session), in the sidebar under the project
// description. Each shows its description, its state (running, done,
// failed, stopped) and how long it ran, with its progress when there is a
// real measure of it: the share of its own todo list that is done. Without
// a todo list, the steps it took and what it is doing now; never a made up
// percentage. A click opens the subagent's conversation.
//
// Everything comes from what the interface already holds: the task tool
// parts of the conversation, and the messages, todo list and status of each
// child session, which the event stream keeps current.
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useSync } from "../context/sync"
import { Locale } from "../util/locale"
import type { BuiltinTuiPlugin } from "./builtins"

const id = "internal:rafiki-agents"
// Room for a line in the sidebar.
export const WIDTH = 36
// Agents listed; the oldest finished ones beyond this are counted only.
export const SHOWN = 6

export type Status = "running" | "done" | "failed" | "stopped"

export interface Agent {
  callID: string
  sessionID?: string
  title: string
  agent?: string
  status: Status
  start?: number
  end?: number
}

export type Progress =
  | { kind: "todo"; done: number; total: number; percent: number }
  | { kind: "steps"; steps: number; current?: string }

interface PartLike {
  type: string
  tool?: string
  callID?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    title?: string
    metadata?: Record<string, unknown>
    time?: { start?: number; end?: number }
  }
}

interface MessageLike {
  id: string
  role: string
  time: { created: number; completed?: number }
}

interface TodoLike {
  status: string
}

export interface Source {
  messages(sessionID: string): readonly MessageLike[]
  parts(messageID: string): readonly PartLike[]
  todo(sessionID: string): readonly TodoLike[]
  busy(sessionID: string): boolean
  // The child sessions of a conversation, for task parts that do not name theirs.
  children?(sessionID: string): readonly { id: string; title: string; time: { created: number } }[]
}

export function source(
  api: Pick<TuiPluginApi, "state">,
  sessions?: () => readonly { id: string; parentID?: string; title: string; time: { created: number } }[],
): Source {
  return {
    children: (sessionID) =>
      (sessions?.() ?? []).filter((item) => item.parentID === sessionID).toSorted((a, b) => a.time.created - b.time.created),
    messages: (sessionID) => api.state.session.messages(sessionID),
    parts: (messageID) => api.state.part(messageID) as readonly PartLike[],
    todo: (sessionID) => api.state.session.todo(sessionID),
    busy: (sessionID) => {
      const status = api.state.session.status(sessionID)?.type
      return status === "busy" || status === "retry"
    },
  }
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

// The subagents started from a conversation, oldest first.
export function list(from: Source, sessionID: string): Agent[] {
  const children = [...(from.children?.(sessionID) ?? [])]
  const used = new Set<string>()
  return from.messages(sessionID).flatMap((message) => {
    if (message.role !== "assistant") return []
    return from.parts(message.id).flatMap((part): Agent[] => {
      if (part.type !== "tool" || part.tool !== "task" || !part.state) return []
      const state = part.state
      const metadata = state.metadata ?? {}
      const title = text(state.title) ?? text(state.input?.["description"]) ?? "Subagent"
      const agent = text(state.input?.["subagent_type"])
      // The part names its child session once the tool reports it; until
      // then (and for parts stored without it) the child session is found by
      // its title, "<description> (@<agent> subagent)", oldest unused first.
      const child =
        text(metadata["sessionId"]) ??
        children.find((item) => !used.has(item.id) && item.title.startsWith(`${title} (@${agent ?? ""}`))?.id
      if (child) used.add(child)
      const status = ((): Status => {
        if (state.status === "error") return metadata["interrupted"] === true ? "stopped" : "failed"
        // A background run returns at once; its child session says whether it still works.
        if (state.status === "completed") return metadata["background"] === true && child && from.busy(child) ? "running" : "done"
        return "running"
      })()
      return [
        {
          callID: part.callID ?? `${message.id}:${child ?? ""}`,
          sessionID: child,
          title,
          agent,
          status,
          start: state.time?.start ?? message.time.created,
          end: status === "running" ? undefined : state.time?.end,
        },
      ]
    })
  })
}

// The running subagent seen last: the one whose todo list the sidebar shows.
export function active(from: Source, sessionID: string): Agent | undefined {
  return list(from, sessionID).findLast((item) => item.status === "running" && item.sessionID)
}

export function progress(from: Source, agent: Agent): Progress | undefined {
  if (!agent.sessionID) return undefined
  const todos = from.todo(agent.sessionID).filter((item) => item.status !== "cancelled")
  if (todos.length > 0) {
    const done = todos.filter((item) => item.status === "completed").length
    return { kind: "todo", done, total: todos.length, percent: Math.round((done / todos.length) * 100) }
  }
  const steps = from.messages(agent.sessionID).filter((item) => item.role === "assistant")
  if (steps.length === 0) return undefined
  const last = steps.at(-1)!
  const parts = from.parts(last.id)
  const tool = parts.findLast((part) => part.type === "tool")
  const current =
    agent.status !== "running"
      ? undefined
      : tool && (tool.state?.status === "running" || tool.state?.status === "pending")
        ? [tool.tool, text(tool.state?.title)].filter(Boolean).join(" ")
        : last.time.completed
          ? undefined
          : parts.some((part) => part.type === "text")
            ? "writing"
            : "thinking"
  return { kind: "steps", steps: steps.length, current }
}

export function elapsed(agent: Agent, now: number) {
  if (agent.start === undefined) return undefined
  const ms = Math.max(0, (agent.end ?? now) - agent.start)
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  return Locale.duration(ms)
}

export function clip(value: string, width = WIDTH) {
  return value.length <= width ? value : value.slice(0, width - 1).trimEnd() + "…"
}

// The second line of an entry: agent, state, time, progress.
export function detail(agent: Agent, value: Progress | undefined, now: number) {
  const time = elapsed(agent, now)
  const measure =
    value?.kind === "todo"
      ? `${value.percent}% (${value.done}/${value.total})`
      : value?.kind === "steps"
        ? `${Locale.pluralize(value.steps, "{} step", "{} steps")}${value.current ? `, ${value.current}` : ""}`
        : undefined
  return [agent.agent, agent.status, time, measure].filter(Boolean).join(" · ")
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const sync = useSync()
  const from = source(props.api, () => sync.data.session)
  const all = createMemo(() => list(from, props.session_id))
  // Running first, then the latest finished ones.
  const shown = createMemo(() => {
    const items = all()
    const running = items.filter((item) => item.status === "running")
    const finished = items.filter((item) => item.status !== "running").reverse()
    return [...running, ...finished].slice(0, Math.max(SHOWN, running.length))
  })
  const hidden = createMemo(() => all().length - shown().length)
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => {
    if (all().some((item) => item.status === "running")) setNow(Date.now())
  }, 1000)
  onCleanup(() => clearInterval(timer))
  const color = (status: Status) =>
    status === "running"
      ? theme().warning
      : status === "done"
        ? theme().success
        : status === "failed"
          ? theme().error
          : theme().textMuted

  return (
    <Show when={all().length > 0}>
      <box>
        <text fg={theme().text}>
          <b>Agents</b>
        </text>
        <For each={shown()}>
          {(item) => (
            <box
              onMouseUp={() => item.sessionID && props.api.route.navigate("session", { sessionID: item.sessionID })}
            >
              <text fg={theme().text} wrapMode="none">
                <span style={{ fg: color(item.status) }}>•</span> {clip(item.title, WIDTH - 2)}
              </text>
              <text fg={theme().textMuted} wrapMode="word">
                {"  "}
                {detail(item, progress(from, item), now())}
              </text>
            </box>
          )}
        </For>
        <Show when={hidden() > 0}>
          <text fg={theme().textMuted}>
            {hidden()} earlier {hidden() === 1 ? "agent" : "agents"}
          </text>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    // Under the project description, above the todo list.
    order: 20,
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
