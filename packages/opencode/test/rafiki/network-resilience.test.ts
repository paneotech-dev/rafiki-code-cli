// What a task does when the connection to the gateway drops: the real session
// loop and the real HTTP client, talking to a scripted local model through a
// proxy that cuts connections (test/lib/fault-proxy.ts). Nothing leaves this
// machine.
import { afterAll, beforeAll, beforeEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EventV2Bridge } from "@/event-v2-bridge"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Session } from "@/session/session"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { Env } from "../../src/env"
import { Format } from "../../src/format"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Question } from "../../src/question"
import { SessionCompaction } from "../../src/session/compaction"
import { Instruction } from "../../src/session/instruction"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import type { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SystemPrompt } from "../../src/session/system"
import { Todo } from "../../src/session/todo"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import * as RafikiResilience from "../../src/rafiki/resilience"
import * as RafikiResume from "../../src/rafiki/resume"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { createFaultProxy, seeded, type Cut, type FaultProxy, type Recorded } from "../lib/fault-proxy"
import { createScriptedModel, events, isTitleRequest, textOf, type Message, type ScriptedModel } from "../lib/scripted-model"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const ref = { providerID: ProviderV2.ID.make("rafiki"), modelID: ModelV2.ID.make("rafiki-fast") }

let model: ScriptedModel
let proxy: FaultProxy
const saved: Record<string, string | undefined> = {}
const ENV = ["RAFIKICODE_GATEWAY_URL", "RAFIKICODE_API_KEY", RafikiResilience.WINDOW_ENV]

beforeAll(async () => {
  model = await createScriptedModel()
  proxy = await createFaultProxy(model.url, { ignore: (request) => isTitleRequest(request.body) })
  for (const name of ENV) saved[name] = process.env[name]
  process.env["RAFIKICODE_GATEWAY_URL"] = proxy.url + "/v1"
  process.env["RAFIKICODE_API_KEY"] = "sk-test-stub"
})

afterAll(async () => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  await proxy.close()
  await model.close()
})

beforeEach(() => {
  proxy.reset()
  model.script(() => ({ text: ["ok"] }))
  delete process.env[RafikiResilience.WINDOW_ENV]
  RafikiResilience.markAnswered(false)
})

const boot = Effect.fn("test.boot")(function* () {
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({
    title: "Pinned",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  const send = (text: string) =>
    Effect.gen(function* () {
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text }],
      })
      return yield* prompt.loop({ sessionID: chat.id })
    })
  return { prompt, sessions, chat, send }
})

const stored = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return yield* sessions.messages({ sessionID })
  })

const assistants = (messages: SessionV1.WithParts[]) => messages.filter((message) => message.info.role === "assistant")

const texts = (messages: SessionV1.WithParts[]) =>
  assistants(messages)
    .flatMap((message) => message.parts)
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("")

const tools = (messages: SessionV1.WithParts[]) =>
  assistants(messages)
    .flatMap((message) => message.parts)
    .filter((part): part is SessionV1.ToolPart => part.type === "tool")

const sent = (request: Recorded) => (request.body["messages"] as Message[]).filter((message) => message.role !== "system")

const key = (request: Recorded) => request.headers[RafikiResilience.IDEMPOTENCY_HEADER.toLowerCase()]

const continuing = (message: Message | undefined) =>
  message?.role === "user" && textOf(message).includes(RafikiResume.CONTINUE_PROMPT)

const succeeded = (messages: Message[]) =>
  messages.some((message) => message.role === "tool" && !/aborted|interrupted/i.test(textOf(message)))

const lines = (dir: string) =>
  Effect.promise(() =>
    fs.readFile(path.join(dir, "out.txt"), "utf8").then(
      (text) => text.split("\n").filter(Boolean),
      () => [] as string[],
    ),
  )

const APPEND = JSON.stringify({ command: "echo line >> out.txt" })

it.instance(
  "a stream cut in the middle of text is continued from where it stopped",
  () =>
    Effect.gen(function* () {
      const { chat, send } = yield* boot()
      model.script((messages) =>
        continuing(messages.at(-1)) ? { text: ["two, ", "as computed."] } : { text: ["The answer ", "is forty ", "two, ", "as computed."] },
      )
      // The role event and two text deltas arrive, then the connection drops.
      proxy.plan((request) => (request.index === 0 ? { type: "events", events: 3 } : undefined))

      const result = yield* send("what is the answer")

      expect(proxy.requests).toHaveLength(2)
      const again = sent(proxy.requests[1]!)
      expect(again.at(-2)).toMatchObject({ role: "assistant", content: "The answer is forty " })
      expect(continuing(again.at(-1))).toBe(true)

      const messages = yield* stored(chat.id)
      expect(texts(messages)).toBe("The answer is forty two, as computed.")
      expect(assistants(messages)).toHaveLength(2)
      expect(result.info.role === "assistant" && result.info.finish).toBe("stop")
      expect(result.info.role === "assistant" && result.info.error).toBeFalsy()

      // A continuation is a different request, so it carries a new key.
      expect(key(proxy.requests[0]!)).toMatch(/^msg/)
      expect(key(proxy.requests[1]!)).toMatch(/^msg/)
      expect(key(proxy.requests[1]!)).not.toBe(key(proxy.requests[0]!))
    }),
  { git: true },
  60_000,
)

it.instance(
  "a cut while tool arguments are arriving drops the incomplete call and the tool runs once",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { chat, send } = yield* boot()
      model.script((messages) => {
        if (succeeded(messages)) return { text: ["Appended."] }
        if (continuing(messages.at(-1))) return { tool: { id: "call_2", name: "bash", args: [APPEND] } }
        return {
          text: ["Appending the line."],
          tool: { id: "call_1", name: "bash", args: [APPEND.slice(0, 20), APPEND.slice(20)] },
        }
      })
      // Role, text, the start of the tool call and half of its arguments.
      proxy.plan((request) => (request.index === 0 ? { type: "events", events: 4 } : undefined))

      const result = yield* send("append a line")

      expect(yield* lines(directory)).toEqual(["line"])
      expect(proxy.requests).toHaveLength(3)
      const messages = yield* stored(chat.id)
      const calls = tools(messages)
      expect(calls.map((part) => part.callID)).toEqual(["call_2"])
      expect(calls[0]?.state.status).toBe("completed")
      // The request after the tool keeps the same history the continuation was built on.
      const last = sent(proxy.requests[2]!)
      expect(last.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "tool"])
      expect(result.info.role === "assistant" && result.info.finish).toBe("stop")
    }),
  { git: true },
  60_000,
)

it.instance(
  "a cut after a tool call was dispatched does not run the tool again",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { chat, send } = yield* boot()
      model.script((messages) =>
        succeeded(messages) ? { text: ["Done."] } : { tool: { id: "call_1", name: "bash", args: [APPEND] } },
      )
      // The whole tool call arrives and runs; the connection drops before the
      // response is finished.
      proxy.plan((request) => (request.index === 0 ? { type: "events", events: 3, hold: 1500 } : undefined))

      const result = yield* send("append a line")

      expect(yield* lines(directory)).toEqual(["line"])
      expect(proxy.requests).toHaveLength(2)
      expect(sent(proxy.requests[1]!).map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(key(proxy.requests[1]!)).not.toBe(key(proxy.requests[0]!))
      const messages = yield* stored(chat.id)
      expect(tools(messages).map((part) => part.state.status)).toEqual(["completed"])
      expect(texts(messages)).toBe("Done.")
      expect(result.info.role === "assistant" && result.info.finish).toBe("stop")
    }),
  { git: true },
  60_000,
)

it.instance(
  "a network that is down when a tool finishes is waited for, and the tool is not run again",
  () =>
    Effect.gen(function* () {
      process.env[RafikiResilience.WINDOW_ENV] = "30"
      const { directory } = yield* TestInstance
      const { chat, send } = yield* boot()
      model.script((messages) =>
        succeeded(messages) ? { text: ["Done."] } : { tool: { id: "call_1", name: "bash", args: [APPEND] } },
      )
      // The tool call arrives whole. The request that carries its result is
      // refused twice, then the network is back.
      proxy.plan((request) => (request.index === 1 || request.index === 2 ? { type: "refuse" } : undefined))

      const result = yield* send("append a line")

      expect(yield* lines(directory)).toEqual(["line"])
      expect(proxy.requests).toHaveLength(4)
      const [, first, second, third] = proxy.requests
      // The same request sent again: same body, same key.
      expect(second!.raw).toBe(first!.raw)
      expect(third!.raw).toBe(first!.raw)
      expect(key(first!)).toMatch(/^msg/)
      expect(key(second!)).toBe(key(first!))
      expect(key(third!)).toBe(key(first!))
      expect(key(first!)).not.toBe(key(proxy.requests[0]!))
      const messages = yield* stored(chat.id)
      expect(tools(messages).map((part) => part.state.status)).toEqual(["completed"])
      expect(result.info.role === "assistant" && result.info.error).toBeFalsy()
      expect(texts(messages)).toBe("Done.")
    }),
  { git: true },
  60_000,
)

it.instance(
  "when the retry window runs out the task stops, says the session is saved, and can be continued",
  () =>
    Effect.gen(function* () {
      process.env[RafikiResilience.WINDOW_ENV] = "3"
      const { chat, send } = yield* boot()
      model.script(() => ({ text: ["Hello."] }))
      yield* send("hello")
      expect(proxy.requests).toHaveLength(1)

      proxy.plan(() => ({ type: "refuse" }))
      const started = Date.now()
      const failed = yield* send("and again")
      const seconds = (Date.now() - started) / 1000

      const error = failed.info.role === "assistant" ? failed.info.error : undefined
      const message = String((error?.data as { message?: unknown } | undefined)?.message)
      expect(message).toContain("did not come back for 3 seconds")
      expect(message).toContain("The session is saved")
      expect(message).toContain("rafikicode --resume")
      expect(message).not.toMatch(/Unable to connect|ECONN|socket/i)
      // The first attempt, one after the first backoff and one at the end of the window.
      expect(proxy.requests.length).toBeGreaterThanOrEqual(3)
      expect(seconds).toBeGreaterThanOrEqual(2.9)
      expect(seconds).toBeLessThan(8)

      proxy.plan(undefined)
      const resumed = yield* send("continue")
      expect(resumed.info.role === "assistant" && resumed.info.error).toBeFalsy()
      const messages = yield* stored(chat.id)
      expect(messages.filter((item) => item.info.role === "user")).toHaveLength(3)
    }),
  { git: true },
  60_000,
)

it.instance(
  "a gateway that never answered in this process is still reported after one retry",
  () =>
    Effect.gen(function* () {
      const { send } = yield* boot()
      proxy.plan(() => ({ type: "refuse" }))
      const started = Date.now()
      const failed = yield* send("hello")
      const seconds = (Date.now() - started) / 1000

      expect(proxy.requests).toHaveLength(2)
      const error = failed.info.role === "assistant" ? failed.info.error : undefined
      expect(error?.name).toBe("APIError")
      expect(String((error?.data as { message?: unknown } | undefined)?.message)).not.toContain("The session is saved")
      expect(seconds).toBeLessThan(8)
    }),
  { git: true },
  60_000,
)

// A whole task under random cuts. The scripted model answers from what it is
// sent, the way a real one would: it asks for the tool until it has a result,
// continues its own text when asked to, and then gives the final answer.
const BEFORE = ["I will append ", "the line ", "to out.txt ", "now. "]
const AFTER = ["The line was ", "appended to out.txt ", "and nothing else ", "was changed."]
const ARGS = [APPEND.slice(0, 12), APPEND.slice(12, 30), APPEND.slice(30)]

function remainder(target: string[], written: string) {
  const full = target.join("")
  if (!full.startsWith(written)) return target
  const rest = full.slice(written.length)
  return rest ? [rest.slice(0, Math.ceil(rest.length / 2)), rest.slice(Math.ceil(rest.length / 2))].filter(Boolean) : []
}

function task(messages: Message[]) {
  const done = succeeded(messages)
  const lastTool = messages.findLastIndex((message) => message.role === "tool")
  const phase = done ? messages.slice(lastTool + 1) : messages
  const written = phase
    .filter((message) => message.role === "assistant")
    .map(textOf)
    .join("")
  if (done) return { text: remainder(AFTER, written) }
  const attempt = messages.filter((message) => message.role === "tool").length + 1
  return { text: remainder(BEFORE, written), tool: { id: `call_${attempt}_${messages.length}`, name: "bash", args: ARGS } }
}

const SIZE = events(task([])).join("").length

for (const seed of [11, 23, 37, 41, 59, 73]) {
  it.instance(
    `random cuts over a whole task leave it complete with the tool run once (seed ${seed})`,
    () =>
      Effect.gen(function* () {
        process.env[RafikiResilience.WINDOW_ENV] = "60"
        const { directory } = yield* TestInstance
        const { chat, send } = yield* boot()
        const random = seeded(seed)
        const cuts: string[] = []
        model.script(task)
        proxy.plan((request): Cut | undefined => {
          if (cuts.length >= 3 || random() > 0.6) return undefined
          const bytes = Math.floor(random() * SIZE)
          cuts.push(`request ${request.index} after ${bytes} bytes`)
          return { type: "bytes", bytes }
        })

        const result = yield* send("append a line to out.txt")
        const messages = yield* stored(chat.id)
        const calls = tools(messages)
        const completed = calls.filter((part) => part.state.status === "completed")
        const interrupted = calls.filter((part) => part.state.status === "error")
        const written = yield* lines(directory)
        const context = `seed ${seed}: ${cuts.join("; ") || "no cuts"}; ${proxy.requests.length} requests`
        console.log(context)

        expect(result.info.role === "assistant" && result.info.error, context).toBeFalsy()
        // Nothing lost and nothing repeated in what the user reads.
        expect(texts(messages), context).toBe(BEFORE.join("") + AFTER.join(""))
        // A tool call that completed is never asked for again. One that was
        // stopped by the cut is reported as such and may be asked for again.
        expect(completed, context).toHaveLength(1)
        expect(written.length, context).toBeGreaterThanOrEqual(1)
        expect(written.length, context).toBeLessThanOrEqual(1 + interrupted.length)
        expect(calls.every((part) => part.state.status !== "pending" && part.state.status !== "running"), context).toBe(true)
      }),
    { git: true },
    120_000,
  )
}
