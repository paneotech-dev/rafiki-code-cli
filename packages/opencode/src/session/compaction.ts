import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"
import * as RafikiPrune from "@/rafiki/prune"
import * as RafikiContext from "@/rafiki/context-size"
import * as RafikiCompactionReplay from "@/rafiki/compaction-replay"

import { Effect, Layer, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt, buildReplayPrompt } from "@opencode-ai/core/session/compaction"
import * as RafikiTpm from "@/rafiki/tpm"
import * as RafikiGateway from "@/rafiki/gateway-errors"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"
import * as RafikiMemory from "@/rafiki/memory"
import * as CachePrefix from "@/rafiki/cache-prefix"
import * as RafikiRouting from "@/rafiki/routing"

export const Event = SessionCompactionEvent

// Tokens kept free for the system text, the tool definitions and the summary instruction when the summary
// request replays the conversation (Run).
const REPLAY_RESERVE = 20_000
// What input read from the cache costs as a share of the full price, rounded up from the Rafiki tiers' price lists
// (rafiki-fast 0.02, rafiki-pro 0.033).
const REPLAY_CACHE_SHARE = 0.05
export const PRUNE_MINIMUM = RafikiPrune.MINIMUM_TOKENS
export const PRUNE_PROTECT = RafikiPrune.PROTECT_TOKENS
const TOOL_OUTPUT_MAX_CHARS = 2_000
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 15_000
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

const serialize = (message: SessionV1.WithParts) => {
  if (message.info.role === "user") {
    const text = message.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n")
    const files = message.parts.flatMap((part) =>
      part.type === "file" ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`] : [],
    )
    return [...(text ? [`[User]: ${text}`] : []), ...files].join("\n")
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.state.input)})`
      if (part.state.status === "completed") {
        const attachments = (part.state.attachments ?? []).map(
          (item) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`,
        )
        const output = part.state.time.compacted
          ? RafikiPrune.marker(part)
          : truncate([part.state.output, ...attachments].join("\n"))
        return [call, `[Tool result]: ${output}`]
      }
      if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error}`]
      return [call]
    })
    .join("\n")
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

// Sends the summary request as the session's own turn request (system text, tool definitions, the conversation)
// with the summary instruction as the last message, so it starts with the bytes the provider just cached.
export type Run = (input: {
  user: SessionV1.User
  agent: Agent.Info
  model: Provider.Model
  processor: SessionProcessor.Handle
  messages: SessionV1.WithParts[]
  prompt: string
}) => Effect.Effect<SessionProcessor.Result>

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
    run?: Run
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns
      if (limit !== undefined && limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = limit === undefined ? all : all.slice(-limit)

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        // estimate lazily so cost stays proportional to the retained tail, not the whole session
        const size = yield* estimate({
          messages: input.messages.slice(turn.start, turn.end),
          model: input.model,
        })
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // Replaces old, large tool outputs with a short marker (rafiki/prune.ts
    // has the rule): the latest turn and the newest PRUNE_PROTECT tokens of
    // output stay in full, errors and edits are never replaced, and nothing
    // happens until more than PRUNE_MINIMUM tokens can be freed.
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return
      const lastUser = msgs.findLast((msg) => msg.info.role === "user")
      const providerID = lastUser?.info.role === "user" ? lastUser.info.model?.providerID : undefined
      if (!RafikiPrune.enabled({ configured: cfg.compaction?.prune, providerID })) return
      yield* Effect.logInfo("pruning")

      const point = RafikiContext.compactAt({ compaction: cfg.compaction, providerID })
      const found = RafikiPrune.select(msgs, {
        protect: PRUNE_PROTECT,
        minimum: PRUNE_MINIMUM,
        from: point ? Math.floor(point * RafikiPrune.FROM_SHARE) : 0,
      })
      yield* Effect.logInfo("found", { pruned: found.pruned, total: found.total })
      if (found.parts.length === 0) return
      const now = Date.now()
      for (const part of found.parts) {
        if (part.state.status === "completed") {
          part.state.time.compacted = now
          yield* session.updatePart(part)
        }
      }
      yield* Effect.logInfo("pruned", { count: found.parts.length })
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
      run?: Run
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      // On an unpinned Rafiki session the summary is written by rafiki-fast (rafiki/routing.ts).
      const route = RafikiRouting.choose({
        purpose: "compaction",
        providerID: userMessage.model.providerID,
        tier: userMessage.model.modelID,
        pinned: RafikiRouting.pinned(input.sessionID),
      })
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : yield* provider
            .getModel(userMessage.model.providerID, ModelV2.ID.make(route.tier))
            .pipe(Effect.orDie)
      if (!agent.model) yield* Effect.logInfo("routing", { "session.id": input.sessionID, tier: route.tier, reason: route.reason })
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      // The compaction request must fit under the key's tokens per minute limit
      // too, or it is refused like the request it is making room for.
      // And under the gateway's input cap (rafiki/input-cap.ts), or it is
      // refused with a 413 and the session cannot be compacted at all.
      const conversation = RafikiTpm.fit(
        msgs.map(serialize).filter(Boolean).join("\n\n"),
        RafikiGateway.isRafikiProvider(model.providerID) ? yield* Effect.promise(() => RafikiTpm.limit()) : undefined,
        8_000,
        RafikiGateway.isRafikiProvider(model.providerID) ? model.limit.input : undefined,
      )
      // The summary as a replay of the turn (Run): when the summary goes to the session's own tier and nothing
      // replaces the agent or the prompt. An overflow keeps the transcript above, which is cut to fit. The replay
      // must also fit under the limits the transcript is cut to: the key's tokens per minute and the gateway's
      // input cap, with room for the system text and the tool definitions.
      const replayable =
        input.run !== undefined &&
        !input.overflow &&
        !agent.model &&
        compacting.prompt === undefined &&
        model.id === userMessage.model.modelID &&
        // A tier that caches only what a request marks (rafiki-max, Claude) prices cache reads and writes in
        // another way and has not been measured with the replay: it keeps the transcript.
        !CachePrefix.marks(model)
      const replayAgent = replayable
        ? yield* Effect.gen(function* () {
            const size = (yield* estimate({ messages: history, model })) + REPLAY_RESERVE
            const rafiki = RafikiGateway.isRafikiProvider(model.providerID)
            const tpm = rafiki ? yield* Effect.promise(() => RafikiTpm.limit()) : undefined
            const cap = rafiki ? model.limit.input : undefined
            if ((tpm && size > tpm) || (cap && size > cap)) return undefined
            // And it must cost less than the transcript. The replay sends again, at the full price, only what came
            // after the last request (the last step's output and tool results); the rest is read from the cache
            // at a small share of the price. The transcript is sent whole at the full price, but cuts each tool
            // output short, so it is cheaper while the conversation is small.
            const last = history.findLastIndex(
              (item) => item.info.role === "assistant" && !item.info.summary && !!item.info.finish,
            )
            if (last < 0) return undefined
            const info = history[last].info as SessionV1.Assistant
            const cached = info.tokens.input + info.tokens.cache.read + info.tokens.cache.write
            const added = yield* estimate({ messages: history.slice(last), model })
            if (added + cached * REPLAY_CACHE_SHARE >= Token.estimate(conversation)) return undefined
            return yield* agents.get(userMessage.agent)
          })
        : undefined
      const nextPrompt =
        compacting.prompt ??
        [
          buildPrompt({
            previousSummary,
            context: [conversation],
          }),
          ...compacting.context,
        ]
          .filter(Boolean)
          .join("\n\n")
      const replayPrompt = [buildReplayPrompt({ previousSummary: previousSummary !== undefined }), ...compacting.context]
        .filter(Boolean)
        .join("\n\n")
      // One summary request: the replay of the turn (replay set) or the transcript.
      const attempt = Effect.fn("SessionCompaction.attempt")(function* (replay: Agent.Info | undefined) {
        const ctx = yield* InstanceState.context
        const msg: SessionV1.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: input.parentID,
          sessionID: input.sessionID,
          mode: "compaction",
          agent: "compaction",
          variant: userMessage.model.variant,
          summary: true,
          path: {
            cwd: ctx.directory,
            root: ctx.worktree,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
        }
        yield* session.updateMessage(msg)
        if (replay) RafikiCompactionReplay.begin(msg.id)
        const processor = yield* processors.create({
          assistantMessage: msg,
          sessionID: input.sessionID,
          model,
        })
        const result = replay
          ? yield* input.run!({
              // The turn's own messages, without the request for the summary.
              user: userMessage,
              agent: replay,
              model,
              processor,
              messages: history,
              prompt: replayPrompt,
            })
          : yield* processor.process({
              user: userMessage,
              agent,
              sessionID: input.sessionID,
              tools: {},
              system: [],
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: [
                        nextPrompt,
                        ...(compacting.prompt ? ["The following is the conversation history:", conversation] : []),
                      ]
                        .filter(Boolean)
                        .join("\n\n"),
                    },
                  ],
                },
              ],
              model,
            })
        return { result, processor }
      })
      let { result, processor } = yield* attempt(replayAgent)
      if (replayAgent) RafikiCompactionReplay.end(processor.message.id)
      // A replay that ends without a summary (the model asked for a tool, which a summary may not call, or the
      // request failed) is done again as the transcript, so the session is compacted as before. Not after a stop
      // asked for by the person.
      if (replayAgent && result !== "continue" && processor.message.error?.name !== "MessageAbortedError") {
        yield* Effect.logInfo("compaction replay failed, using the transcript", {
          "session.id": input.sessionID,
          error: processor.message.error?.name,
        })
        yield* session.removeMessage({ sessionID: input.sessionID, messageID: processor.message.id })
        ;({ result, processor } = yield* attempt(undefined))
      }

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              (RafikiMemory.enabled(cfg.memory) ? RafikiMemory.AFTER_COMPACTION + "\n\n" : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        // The next request reads the project memory and the project instructions again, with what was
        // recorded before the compaction.
        RafikiMemory.refresh(input.sessionID)
        CachePrefix.refresh(input.sessionID)
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
  ],
})

export * as SessionCompaction from "./compaction"
