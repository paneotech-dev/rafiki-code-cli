// History: recent conversations across projects and the folders they were
// worked in, so a task can be picked up again. A section of the sidebar
// shows the latest few, folded like the other sidebar sections; the History
// panel (<leader>o, or "History" in the command list, or a click on the last
// line of the section) lists them all. Keyboard and mouse both work.
//
// The list comes from the local server's session list across projects (the
// one the session commands read), loaded when the section is first drawn or
// the panel opened, never at startup. Picking a conversation of this folder
// opens it here; one of another folder, or a project, restarts the interface
// in that folder (core/brand/history.ts, rafiki/history.ts).
//
// Builds: the latest builder projects of code.rafikiai.io, from the Console
// (GET /api/v1/builder/sessions with the key in use), read on their own the
// first time a view asks, so a slow or missing answer never holds the rest.
// When the Console does not list them (a 404, a refusal, no answer, no key)
// the group is not shown. Picking one opens its builder page in the browser,
// or shows the address when there is no browser; the terminal does not
// resume builder sessions.
import * as Account from "@opencode-ai/core/brand/account"
import * as History from "@opencode-ai/core/brand/history"
import { openUrl } from "@opencode-ai/core/open"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, onMount, Show, untrack } from "solid-js"
import { useExit } from "../context/exit"
import { useRoute } from "../context/route"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import type { BuiltinTuiPlugin } from "./builtins"

const id = "internal:rafiki-history"
export const COMMAND = "recent.open"
// Conversations and projects the sidebar section shows.
const SIDEBAR_CONVERSATIONS = 5
const SIDEBAR_PROJECTS = 3
// Builder projects the group lists, in the sidebar and in the panel.
export const BUILDS = 5
// Room for a title in the sidebar.
const WIDTH = 38

export interface Loaded {
  conversations: History.Conversation[]
  projects: History.Project[]
}

// One read of the session list across projects; an empty list when the
// server does not answer, so the panel says so instead of failing.
export async function load(api: TuiPluginApi, limit = 60): Promise<Loaded> {
  // The client names this folder on every request, and the route then lists
  // this folder only; an empty directory asks for every folder.
  const result = await api.client.experimental.session.list({ directory: "", roots: true, limit }).catch(() => undefined)
  const conversations = History.conversations((result?.data ?? []) as History.SessionLike[], limit)
  return { conversations, projects: History.projects(conversations) }
}

// The builder projects of the key in use, or undefined when there are none
// to show (no key, or the Console does not list them).
export async function loadBuilds(limit = BUILDS): Promise<History.Build[] | undefined> {
  const source = Account.source()
  if (!source) return undefined
  return History.builds(await Account.builderProjects(source, limit), limit)
}

// The list as signals, kept by the plugin for every view: read the first
// time a view asks for it (never at startup), and again a moment after
// sessions change, once the updates of a streaming answer have settled.
// Builds are read apart, when a view first asks and when the panel opens.
export function createHistory(
  api: TuiPluginApi,
  limit = 60,
  settleMs = 2_000,
  readBuilds: () => Promise<History.Build[] | undefined> = () => loadBuilds(),
) {
  const [data, setData] = createSignal<Loaded>()
  const [loading, setLoading] = createSignal(true)
  const [builds, setBuilds] = createSignal<History.Build[]>()
  let started = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = () =>
    load(api, limit).then((value) => {
      setData(value)
      setLoading(false)
    })
  // Never throws, never waited on by the rest of the list.
  const refreshBuilds = () =>
    readBuilds()
      .catch(() => undefined)
      .then((value) => setBuilds(value && value.length > 0 ? value : undefined))
  function ensure() {
    if (started) return
    started = true
    void refresh()
    void refreshBuilds()
  }
  api.event?.on("session.updated", () => {
    if (!started) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void refresh(), settleMs)
  })
  return { data, loading, refresh, ensure, builds, refreshBuilds }
}

export type HistoryStore = ReturnType<typeof createHistory>

// What picking an entry does.
export type Target =
  | { type: "conversation"; item: History.Conversation }
  | { type: "project"; item: History.Project }
  | { type: "build"; item: History.Build }

// A builder project opens in the browser; without one, or when the browser
// cannot be started, its address is shown to copy.
export async function openBuild(
  api: Pick<TuiPluginApi, "ui">,
  item: History.Build,
  input: { browser?: boolean; open?: (url: string) => Promise<unknown> } = {},
) {
  const showAddress = () =>
    api.ui.toast({ variant: "info", title: item.title, message: `Open in a browser: ${item.url}`, duration: 30_000 })
  if (!(input.browser ?? History.browserAvailable())) return showAddress()
  const opened = await (input.open ?? openUrl)(item.url).then(
    () => true,
    () => false,
  )
  if (!opened) return showAddress()
  api.ui.toast({ variant: "info", message: `Opening ${item.title} in the browser: ${item.url}` })
}

export function useOpen(api: TuiPluginApi) {
  const route = useRoute()
  const exit = useExit()
  const dialog = useDialog()
  return (target: Target) => {
    dialog.clear()
    if (target.type === "build") return void openBuild(api, target.item)
    const here = api.state.path.directory
    const directory = target.item.directory
    if (directory === here) {
      if (target.type === "conversation") route.navigate({ type: "session", sessionID: target.item.id })
      else route.navigate({ type: "home" })
      return
    }
    History.requestReopen(target.type === "conversation" ? { directory, sessionID: target.item.id } : { directory })
    exit()
  }
}

function tierText(item: History.Conversation) {
  return item.tier ? ` · ${item.tier}` : ""
}

export function HistoryDialog(props: { api: TuiPluginApi; store: HistoryStore }) {
  const open = useOpen(props.api)
  const { data, loading, builds } = props.store
  onMount(() => {
    void props.store.refresh()
    void props.store.refreshBuilds()
  })
  const options = createMemo(() => {
    const value = data()
    if (!value) return []
    const now = Date.now()
    return [
      ...value.conversations.map((item) => ({
        title: item.title,
        value: { type: "conversation", item } as Target,
        description: item.tier,
        footer: `${History.folder(item.directory)} · ${History.ago(item.updated, now)}`,
        category: "Recent conversations",
      })),
      ...value.projects.map((item) => ({
        title: History.folder(item.directory),
        value: { type: "project", item } as Target,
        description: `${item.conversations} ${item.conversations === 1 ? "conversation" : "conversations"}, new session`,
        footer: History.ago(item.updated, now),
        category: "Recent projects",
      })),
      ...(builds() ?? []).map((item) => ({
        title: item.title,
        value: { type: "build", item } as Target,
        description: History.buildStatus(item),
        footer: `builder · ${History.ago(item.updated, now)}`,
        category: "Builds",
      })),
    ]
  })
  return (
    <DialogSelect<Target>
      title={loading() ? "History (loading)" : options().length ? "History" : "History (nothing yet)"}
      placeholder="Search conversations, projects and builds"
      options={options()}
      onSelect={(option) => open(option.value)}
    />
  )
}

export function showHistory(api: TuiPluginApi, store: HistoryStore) {
  api.ui.dialog.replace(() => <HistoryDialog api={api} store={store} />)
}

function Sidebar(props: { api: TuiPluginApi; store: HistoryStore; session_id: string }) {
  const theme = () => props.api.theme.current
  const [open, setOpen] = createSignal(untrack(() => props.api.kv.get("history_sidebar_open", true)))
  const data = props.store.data
  const choose = useOpen(props.api)
  onMount(() => props.store.ensure())
  const conversations = createMemo(() =>
    (data()?.conversations ?? []).filter((item) => item.id !== props.session_id).slice(0, SIDEBAR_CONVERSATIONS),
  )
  const projects = createMemo(() =>
    (data()?.projects ?? []).filter((item) => item.directory !== props.api.state.path.directory).slice(0, SIDEBAR_PROJECTS),
  )
  const builds = createMemo(() => (props.store.builds() ?? []).slice(0, BUILDS))
  const shortcut = createMemo(() => {
    const binding = props.api.tuiConfig.keybinds.get(COMMAND)[0]
    return binding ? props.api.keys.formatSequence(Array.from(props.api.keymap.parseKeySequence(binding.key))) : ""
  })
  const toggle = () => {
    const next = !open()
    setOpen(next)
    props.api.kv.set("history_sidebar_open", next)
  }
  return (
    <Show when={conversations().length > 0 || projects().length > 0 || builds().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={toggle}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          <text fg={theme().text}>
            <b>History</b>
          </text>
        </box>
        <Show when={open()}>
          <For each={conversations()}>
            {(item) => (
              <box onMouseUp={() => choose({ type: "conversation", item })}>
                <text fg={theme().text} wrapMode="none">
                  {History.clip(item.title, WIDTH)}
                </text>
                <text fg={theme().textMuted} wrapMode="none">
                  {History.clip(`${History.folder(item.directory)}${tierText(item)} · ${History.ago(item.updated)}`, WIDTH)}
                </text>
              </box>
            )}
          </For>
          <Show when={projects().length > 0}>
            <text fg={theme().textMuted}>Projects</text>
            <For each={projects()}>
              {(item) => (
                <box onMouseUp={() => choose({ type: "project", item })}>
                  <text fg={theme().text} wrapMode="none">
                    {History.clip(`${History.folder(item.directory)} · ${History.ago(item.updated)}`, WIDTH)}
                  </text>
                </box>
              )}
            </For>
          </Show>
          <Show when={builds().length > 0}>
            <text fg={theme().textMuted}>Builds</text>
            <For each={builds()}>
              {(item) => (
                <box onMouseUp={() => choose({ type: "build", item })}>
                  <text fg={theme().text} wrapMode="none">
                    {History.clip(item.title, WIDTH)}
                  </text>
                  <text fg={theme().textMuted} wrapMode="none">
                    {History.clip(`${History.buildStatus(item)} · ${History.ago(item.updated)}`, WIDTH)}
                  </text>
                </box>
              )}
            </For>
          </Show>
          <box onMouseUp={() => showHistory(props.api, props.store)}>
            <text fg={theme().textMuted}>
              {shortcut() ? `${shortcut()} ` : ""}all history
            </text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  const store = createHistory(api)
  api.keymap.registerLayer({
    commands: [
      {
        name: COMMAND,
        title: "History: recent conversations, projects and builds",
        category: "Session",
        namespace: "palette",
        run() {
          showHistory(api, store)
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.get(COMMAND),
  })
  api.slots.register({
    // Under the spend block.
    order: 160,
    slots: {
      sidebar_content(_ctx, props) {
        return <Sidebar api={api} store={store} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
