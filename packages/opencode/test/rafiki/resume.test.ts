// rafikicode run killed in the middle of a tool call, then rafikicode run
// --resume: the task, the task list and the file checkpoint are all there.
// The real program runs as a child process against a scripted local model;
// its data and config directories are a temporary directory.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { createFaultProxy, type FaultProxy } from "../lib/fault-proxy"
import { createScriptedModel, isTitleRequest, textOf, type Message, type ScriptedModel } from "../lib/scripted-model"

const root = path.resolve(import.meta.dir, "../..")
let home: string
let project: string
let model: ScriptedModel
let proxy: FaultProxy

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-resume-"))
  project = path.join(home, "project")
  fs.mkdirSync(project)
  const git = (...args: string[]) => spawnSync("git", args, { cwd: project, stdio: "ignore" })
  git("init")
  git("config", "user.email", "test@rafikicode.test")
  git("config", "user.name", "Test")
  git("config", "commit.gpgsign", "false")
  git("commit", "--allow-empty", "-m", "root")
  model = await createScriptedModel()
  // No cuts here: the proxy is used for its record of what was sent.
  proxy = await createFaultProxy(model.url, { ignore: (request) => isTitleRequest(request.body) })
})

afterEach(async () => {
  await proxy.close()
  await model.close()
  fs.rmSync(home, { recursive: true, force: true })
})

function env() {
  const out: Record<string, string | undefined> = {
    ...process.env,
    COLUMNS: "120",
    HOME: home,
    // The program takes its working directory from PWD when it is set.
    PWD: project,
    OPENCODE_TEST_HOME: home,
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    RAFIKICODE_GATEWAY_URL: proxy.url + "/v1",
    RAFIKICODE_API_KEY: "sk-resume-stub",
    RAFIKICODE_TEST_TTY: "1",
  }
  for (const name of ["CI", "GITHUB_ACTIONS", "OPENCODE_DB", "RAFIKICODE_CONSOLE_URL"]) delete out[name]
  return out as Record<string, string>
}

function start(args: string[]) {
  return Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args], {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
    env: env(),
  })
}

async function waitFor(file: string, ms: number) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true
    await Bun.sleep(100)
  }
  return false
}

function database() {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "project" && dir === home) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".db")) found.push(full)
    }
  }
  walk(home)
  expect(found).toHaveLength(1)
  return new Database(found[0]!, { readonly: true })
}

function read(db: Database) {
  const sessions = db.query("select id from session").all() as Array<{ id: string }>
  const todos = db.query("select content, status from todo order by position").all() as Array<{ content: string; status: string }>
  const messages = (db.query("select id, data from message order by time_created, id").all() as Array<{ id: string; data: string }>).map(
    (row) => ({ id: row.id, ...(JSON.parse(row.data) as { role: string; time: { completed?: number }; error?: { name: string } }) }),
  )
  const parts = (db.query("select message_id, data from part order by id").all() as Array<{ message_id: string; data: string }>).map(
    (row) => ({
      messageID: row.message_id,
      ...(JSON.parse(row.data) as { type: string; tool?: string; snapshot?: string; files?: string[]; state?: { status: string } }),
    }),
  )
  return { sessions, todos, messages, parts }
}

const TODOS = {
  todos: [
    { content: "write the marker", status: "in_progress", priority: "high" },
    { content: "report what was done", status: "pending", priority: "low" },
  ],
}
// The shell records its own process id and then becomes the sleep, so the test
// can stop the command the killed program leaves behind.
const COMMAND = "echo $$ > pid.txt; echo started > marker.txt; exec sleep 30"

function script(messages: Message[]) {
  const last = messages.findLast((message) => message.role === "user")
  if (textOf(last).includes("carry on")) return { text: ["Resumed."] }
  const results = messages.filter((message) => message.role === "tool").length
  if (results === 0) return { tool: { id: "call_plan", name: "todowrite", args: [JSON.stringify(TODOS)] } }
  if (results === 1) return { tool: { id: "call_work", name: "bash", args: [JSON.stringify({ command: COMMAND })] } }
  return { text: ["Finished."] }
}

describe("rafikicode run --resume after the process was killed", () => {
  test("restores the task, the task list and the file checkpoint", async () => {
    model.script(script)

    const first = start(["run", "write the marker file"])
    const started = await waitFor(path.join(project, "marker.txt"), 90_000)
    first.kill("SIGKILL")
    await first.exited
    const sleeper = Number(fs.readFileSync(path.join(project, "pid.txt"), "utf8").trim())
    if (sleeper > 1) {
      try {
        process.kill(sleeper, "SIGKILL")
      } catch {}
    }
    expect(started).toBe(true)
    // The plan and the command were requested; nothing after the kill.
    expect(proxy.requests).toHaveLength(2)

    // What the killed process left on disk: everything up to the tool call
    // that was running, and no record yet of the files that step changed.
    const before = database()
    const left = read(before)
    before.close()
    expect(left.sessions).toHaveLength(1)
    expect(left.todos).toEqual([
      { content: "write the marker", status: "in_progress" },
      { content: "report what was done", status: "pending" },
    ])
    const open = left.messages.at(-1)!
    expect(open.role).toBe("assistant")
    expect(open.time.completed).toBeUndefined()
    const openParts = left.parts.filter((part) => part.messageID === open.id)
    expect(openParts.some((part) => part.type === "step-start" && part.snapshot)).toBe(true)
    expect(openParts.some((part) => part.type === "tool" && part.tool === "bash" && part.state?.status === "running")).toBe(true)
    expect(openParts.some((part) => part.type === "patch")).toBe(false)
    expect(left.parts.some((part) => part.type === "tool" && part.tool === "todowrite" && part.state?.status === "completed")).toBe(true)

    const second = start(["run", "--resume", "carry on"])
    const [stdout, stderr] = await Promise.all([new Response(second.stdout).text(), new Response(second.stderr).text()])
    const exitCode = await second.exited
    expect(stdout + stderr).toContain("Resumed.")
    expect(exitCode).toBe(0)

    // The task: the model is sent the whole conversation again, with the
    // interrupted command reported as such.
    expect(proxy.requests).toHaveLength(3)
    const history = (proxy.requests[2]!.body["messages"] as Message[]).filter((message) => message.role !== "system")
    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "user"])
    expect(textOf(history[0])).toContain("write the marker file")
    expect(textOf(history[4])).toMatch(/interrupted|aborted/i)
    expect(textOf(history[5])).toContain("carry on")

    // The same session, the same plan, and now a checkpoint for the step that
    // was cut short: the files it changed are recorded, so undo restores them.
    const after = database()
    const now = read(after)
    after.close()
    expect(now.sessions).toEqual(left.sessions)
    expect(now.todos).toEqual(left.todos)
    const closed = now.messages.find((message) => message.id === open.id)!
    expect(closed.time.completed).toBeGreaterThan(0)
    expect(closed.error?.name).toBe("MessageAbortedError")
    const closedParts = now.parts.filter((part) => part.messageID === open.id)
    expect(closedParts.some((part) => part.type === "tool" && part.state?.status === "running")).toBe(false)
    const patch = closedParts.find((part) => part.type === "patch")
    expect(patch?.files?.some((file) => file.endsWith("marker.txt"))).toBe(true)
  }, 240_000)
})
