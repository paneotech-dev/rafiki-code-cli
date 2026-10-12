/** @jsxImportSource @opentui/solid */
// The todo list after a conversation is opened: an update that arrives while
// the conversation is being read stays, instead of the older list the read
// returns (context/sync.tsx). Before, the sidebar kept that older list, the
// tasks the work started with, until the next update.
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const sessionID = "ses_todo_race"
const session = {
  id: sessionID,
  title: "todo race",
  time: { created: 0, updated: 0 },
  version: "0.1.10",
  directory: "/tmp/opencode/packages/opencode",
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

test("a todo update during a slow session read is not replaced by the older list", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveDiff!: (response: Response) => void
  const diff = new Promise<Response>((resolve) => {
    resolveDiff = resolve
  })
  let requested = false
  const started = [{ content: "Plan the work", status: "in_progress", priority: "high" }]
  const latest = [
    { content: "Plan the work", status: "completed", priority: "high" },
    { content: "Write the fix", status: "in_progress", priority: "high" },
  ]
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json([])
    // The list as it was when the read started.
    if (url.pathname === `/session/${sessionID}/todo`) return json(started)
    // The diff of a large worktree answers last.
    if (url.pathname === `/session/${sessionID}/diff`) {
      requested = true
      return diff
    }
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(global({ id: "evt_todo", type: "todo.updated", properties: { sessionID, todos: latest } }))
    await wait(() => sync.data.todo[sessionID]?.length === 2)
    resolveDiff(json([]))
    await hydrate
    expect(sync.data.todo[sessionID].map((item) => item.status)).toEqual(["completed", "in_progress"])
  } finally {
    app.renderer.destroy()
  }
})
