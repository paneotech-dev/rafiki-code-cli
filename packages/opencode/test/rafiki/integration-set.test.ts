// The five October 2026 branches as a set, on one wire: what a request looks
// like when the stable prefix and its cache marker (src/rafiki/cache-prefix.ts),
// the continuation of a cut stream and the idempotency key
// (src/rafiki/resume.ts, src/rafiki/resilience.ts) and the tier headers
// (Brand.provider.config) all apply to it. Each of these has its own suite;
// this one checks that none of them moves what another one promises.
//
// The real session loop and the real HTTP client talk to a scripted local
// model through a proxy that cuts connections. Nothing leaves this machine.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import os from "os"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
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
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SystemPrompt } from "../../src/session/system"
import { Todo } from "../../src/session/todo"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import * as RafikiResilience from "../../src/rafiki/resilience"
import * as RafikiResume from "../../src/rafiki/resume"
import * as CachePrefix from "../../src/rafiki/cache-prefix"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { createFaultProxy, seeded, type Cut, type FaultProxy, type Recorded } from "../lib/fault-proxy"
import { createMockConsole } from "../brand/mock-console.mjs"
import { createMockGateway } from "../brand/mock-gateway.mjs"
import { spawnCli } from "./spawn"
import {
  createScriptedModel,
  events,
  isTitleRequest,
  textOf,
  type Message,
  type ScriptedModel,
} from "../lib/scripted-model"

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

type Tier = "fast" | "max"
const ref = (tier: Tier) => ({ providerID: ProviderV2.ID.make("rafiki"), modelID: ModelV2.ID.make(`rafiki-${tier}`) })

let model: ScriptedModel
let proxy: FaultProxy
const saved: Record<string, string | undefined> = {}
const ENV = ["RAFIKICODE_GATEWAY_URL", "RAFIKICODE_API_KEY", RafikiResilience.WINDOW_ENV, Brand.env.cacheMarkers]

beforeAll(async () => {
  model = await createScriptedModel()
  proxy = await createFaultProxy(model.url, { ignore: (request) => isTitleRequest(request.body) })
  for (const name of ENV) saved[name] = process.env[name]
  process.env["RAFIKICODE_GATEWAY_URL"] = proxy.url + "/v1"
  process.env["RAFIKICODE_API_KEY"] = "sk-test-stub"
  delete process.env[Brand.env.cacheMarkers]
})

afterAll(async () => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  RafikiResilience.markAnswered(false)
  await proxy.close()
  await model.close()
})

beforeEach(() => {
  proxy.reset()
  model.script(() => ({ text: ["ok"] }))
  delete process.env[RafikiResilience.WINDOW_ENV]
  RafikiResilience.markAnswered(false)
})

const boot = Effect.fn("test.boot")(function* (tier: Tier) {
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
        model: ref(tier),
        noReply: true,
        parts: [{ type: "text", text }],
      })
      return yield* prompt.loop({ sessionID: chat.id })
    })
  return { chat, send }
})

type Wire = Message & { cache_control?: unknown }

const all = (request: Recorded) => request.body["messages"] as Wire[]

const conversation = (request: Recorded) => all(request).filter((message) => message.role !== "system")

const key = (request: Recorded) => request.headers[RafikiResilience.IDEMPOTENCY_HEADER.toLowerCase()]

const continuing = (message: Message | undefined) =>
  message?.role === "user" && textOf(message).includes(RafikiResume.CONTINUE_PROMPT)

const succeeded = (messages: Message[]) =>
  messages.some((message) => message.role === "tool" && !/aborted|interrupted/i.test(textOf(message)))

// The request body from its first byte to the end of the first (stable) system message.
const stablePrefix = (request: Recorded) => {
  const first = JSON.stringify(all(request)[0])
  const at = request.raw.indexOf(first)
  expect(at).toBeGreaterThan(0)
  return request.raw.slice(0, at + first.length)
}

// The tool definitions as they were sent.
const toolBytes = (request: Recorded) => {
  const at = request.raw.indexOf(',"tools":[')
  expect(at).toBeGreaterThan(0)
  return request.raw.slice(at)
}

const marked = (request: Recorded) =>
  all(request)
    .filter((message) => message.cache_control !== undefined)
    .map((message) => message.role)

// What every request of a task must carry and keep, whatever happened to the one before it.
function expectPrefix(requests: Recorded[], tier: Tier) {
  const prefix = stablePrefix(requests[0])
  expect(prefix.length).toBeGreaterThan(4000)
  for (const request of requests) {
    expect(stablePrefix(request)).toBe(prefix)
    expect(toolBytes(request)).toBe(toolBytes(requests[0]))
    const messages = all(request)
    // The stable system message first, the date line in a message of its own after it, then the conversation.
    expect(messages.filter((message) => message.role === "system")).toHaveLength(2)
    expect(messages[0].role).toBe("system")
    expect(messages[1]).toEqual({ role: "system", content: CachePrefix.volatile() })
    expect(prefix).not.toContain(CachePrefix.volatile())
    expect(prefix).not.toContain(RafikiResume.CONTINUE_PROMPT)
    if (CachePrefix.marks({ providerID: "rafiki", api: { id: `rafiki-${tier}` } })) {
      // The marker closes the stable prefix and appears nowhere before its end.
      expect(messages[0].cache_control).toEqual({ type: "ephemeral" })
      expect(prefix.endsWith('"cache_control":{"type":"ephemeral"}}')).toBe(true)
      expect(prefix.split('"cache_control"')).toHaveLength(2)
    } else {
      expect(request.raw).not.toContain('"cache_control"')
    }
  }
}

function expectHeaders(requests: Recorded[], tier: Tier) {
  for (const request of requests) {
    expect(request.headers["x-rafiki-surface"]).toBe("cli")
    expect(request.headers["x-rafiki-tier"]).toBe(tier)
    expect(request.headers["x-rafiki-escalation"]).toBe("0")
    expect(key(request)).toMatch(/^msg/)
  }
}

const APPEND = JSON.stringify({ command: "echo line >> out.txt" })

for (const tier of ["max", "fast"] as const) {
  it.instance(
    `${tier}: a continuation after a cut keeps the stable prefix and the tier headers, and carries a new key`,
    () =>
      Effect.gen(function* () {
        const { send } = yield* boot(tier)
        model.script((messages) =>
          continuing(messages.at(-1))
            ? { text: ["two, ", "as computed."] }
            : { text: ["The answer ", "is forty ", "two, ", "as computed."] },
        )
        // The role event and two text deltas arrive, then the connection drops.
        proxy.plan((request) => (request.index === 0 ? { type: "events", events: 3 } : undefined))

        const result = yield* send("what is the answer")

        expect(result.info.role === "assistant" && result.info.error).toBeFalsy()
        expect(proxy.requests).toHaveLength(2)
        const [first, second] = proxy.requests
        expectPrefix(proxy.requests, tier)
        expectHeaders(proxy.requests, tier)
        expect(key(second)).not.toBe(key(first))

        // The partial answer and the instruction to continue are conversation: they follow the two system
        // messages, and the first request's conversation is repeated ahead of them.
        const tail = conversation(second)
        expect(tail.map((message) => message.role)).toEqual(["user", "assistant", "user"])
        expect(tail[1].content).toBe("The answer is forty ")
        expect(continuing(tail[2])).toBe(true)
        expect(textOf(tail[0])).toBe(textOf(conversation(first)[0]))
        if (tier === "max") {
          // The conversation markers move to the last two messages, the continuation included.
          expect(marked(first)).toEqual(["system", "user"])
          expect(marked(second)).toEqual(["system", "assistant", "user"])
        }
      }),
    { git: true },
    60_000,
  )

  it.instance(
    `${tier}: a request sent again after a refused connection is the same bytes under the same key and headers`,
    () =>
      Effect.gen(function* () {
        process.env[RafikiResilience.WINDOW_ENV] = "30"
        const { send } = yield* boot(tier)
        model.script((messages) =>
          succeeded(messages) ? { text: ["Done."] } : { tool: { id: "call_1", name: "bash", args: [APPEND] } },
        )
        // The tool call arrives whole. The request that carries its result is refused twice, then the network is back.
        proxy.plan((request) => (request.index === 1 || request.index === 2 ? { type: "refuse" } : undefined))

        const result = yield* send("append a line")

        expect(result.info.role === "assistant" && result.info.error).toBeFalsy()
        expect(proxy.requests).toHaveLength(4)
        const [step, first, second, third] = proxy.requests
        expectPrefix(proxy.requests, tier)
        expectHeaders(proxy.requests, tier)
        expect(second.raw).toBe(first.raw)
        expect(third.raw).toBe(first.raw)
        expect(key(second)).toBe(key(first))
        expect(key(third)).toBe(key(first))
        expect(key(first)).not.toBe(key(step))
        for (const name of ["x-rafiki-surface", "x-rafiki-tier", "x-rafiki-escalation"]) {
          expect(second.headers[name]).toBe(first.headers[name])
          expect(third.headers[name]).toBe(first.headers[name])
        }
      }),
    { git: true },
    60_000,
  )
}

// The closing line of `rafikicode run` when the stream of a task was cut: the
// cut call ends without a usage block, the continuation reports its own. The
// line must count the first and say it is not in the amount.
describe("rafikicode run through a connection that is cut once", () => {
  // What the mock gateway reports for every complete answer: 10,000 prompt
  // tokens of which 6,000 were read from the cache, 2,000 completion tokens.
  const USAGE = {
    prompt_tokens: 10_000,
    completion_tokens: 2_000,
    total_tokens: 12_000,
    prompt_tokens_details: { cached_tokens: 6_000 },
  }

  test("the closing line names the call that reported no usage", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "rafikicode-set-"))
    const gateway = createMockGateway({ quiet: true, usage: USAGE })
    const account = createMockConsole({ quiet: true, anyKey: true })
    await Promise.all([gateway.ready, account.ready])
    // Only the model requests of the task are planned and recorded: the price
    // list lookup and the title request pass through untouched.
    const wire = await createFaultProxy(gateway.url, {
      ignore: (request) => !request.path.startsWith("/v1/chat/completions") || isTitleRequest(request.body),
    })
    // The role event and two words of the answer arrive, then the connection drops.
    wire.plan((request) => (request.index === 0 ? { type: "events", events: 3 } : undefined))
    try {
      const result = await spawnCli(home, ["run", "say hello"], {
        RAFIKICODE_API_KEY: "sk-test-not-a-real-key",
        RAFIKICODE_GATEWAY_URL: wire.url + "/v1",
        RAFIKICODE_CONSOLE_URL: account.url,
      })
      expect(result.exitCode).toBe(0)
      expect(wire.requests).toHaveLength(2)
      expect(wire.requests[0].complete).toBe(false)
      expect(continuing(conversation(wire.requests[1]).at(-1))).toBe(true)
      expect(key(wire.requests[1])).not.toBe(key(wire.requests[0]))
      expect(result.stdout).not.toContain("Task cost")
      expect(result.stderr).toContain(
        "Task cost: tier fast · about 0.0086 USD (estimate) · 1 call reported no usage and is not included · caching saved about 0.0054 USD · at most about 12.39 USD of credits left",
      )
    } finally {
      await wire.close()
      await account.close()
      await gateway.close()
      rmSync(home, { recursive: true, force: true })
    }
  }, 120_000)
})
