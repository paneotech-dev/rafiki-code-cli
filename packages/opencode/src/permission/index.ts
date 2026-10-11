import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import * as Publish from "@opencode-ai/core/brand/publish"
import * as PermissionMode from "@opencode-ai/core/brand/permission-mode"
import * as RafikiAutoMode from "@/rafiki/auto-mode"
import * as RiskCheck from "@/rafiki/risk-check"
import * as Guarded from "@opencode-ai/core/brand/guarded"

export const Event = PermissionV1.Event

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const instance = yield* InstanceState.context
      const permissionConfig = (yield* config.get()).permission
      const { ruleset, ...request } = input
      const mode = PermissionMode.resolve({ directory: instance.directory, config: permissionConfig }).mode
      const metadata: Record<string, unknown> = { ...request.metadata, mode }
      let always = request.always
      let needsAsk = false

      // Publishing code (core/brand/publish.ts) asks every time: a wildcard
      // allow, an allowed shell, an earlier "always" and auto mode do not
      // answer it. Only a rule written for it by name can deny it; plan mode
      // refuses it; `rafikicode run` decides on its own whether a run may
      // push (cli/cmd/run.ts).
      if (request.permission === Publish.PERMISSION) {
        const denied = ruleset.findLast((rule) => rule.permission === Publish.PERMISSION)?.action === "deny"
        if (denied) {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => rule.permission === Publish.PERMISSION),
          })
        }
        if (mode === "plan") {
          const command = typeof request.metadata["command"] === "string" ? request.metadata["command"] : request.patterns.join(" ")
          return yield* new PermissionV1.CorrectedError({ feedback: Guarded.planNote(`the command \`${command}\``) })
        }
        needsAsk = true
      }

      for (const pattern of needsAsk ? [] : request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      // Plan and auto mode (rafiki/auto-mode.ts). A deny rule has already won.
      if (request.permission !== Publish.PERMISSION && (mode !== "ask" || needsAsk)) {
        const cwd = typeof request.metadata["workdir"] === "string" ? request.metadata["workdir"] : instance.directory
        const ctx = RafikiAutoMode.context({ cwd, directory: instance.directory, worktree: instance.worktree, sessionID: request.sessionID })
        const assessment = RafikiAutoMode.assess(request, ctx, instance.worktree)
        if (mode === "plan") {
          const note = RafikiAutoMode.planRefusal(request, assessment, instance.worktree)
          if (note) return yield* new PermissionV1.CorrectedError({ feedback: note })
        }
        // A push was asked about by its own question (the shell tool asks "publish" first).
        const guarded = assessment.findings.filter((item) => !item.publish && !RafikiAutoMode.explicitlyAllowed(item, request, ruleset))
        if (guarded.length) {
          metadata["guard"] = guarded.map((item) => item.reason)
          // In auto mode a guarded action is asked every time.
          if (mode === "auto") always = []
        }
        if (mode === "auto") {
          needsAsk = guarded.length > 0
          const explicit =
            request.patterns.length > 0 &&
            request.patterns.every((pattern) => {
              const rule = evaluate(request.permission, pattern, ruleset)
              return rule.action === "allow" && rule.pattern !== "*" && rule.permission !== "*"
            })
          if (!needsAsk && request.permission === "bash" && assessment.unknown.length && !explicit && PermissionMode.fromConfig(permissionConfig).autoCheck) {
            const command = typeof request.metadata["command"] === "string" ? request.metadata["command"] : request.patterns.join("\n")
            const answer = yield* Effect.promise(() => RiskCheck.cached(request.sessionID, { command, directory: cwd }))
            yield* Effect.logInfo("risk check", { command, answer })
            if (!answer || answer.risk === "high") {
              needsAsk = true
              metadata["guard"] = [
                answer
                  ? `risk check: ${answer.reason || "high risk"}`
                  : `risk check: no answer within ${RiskCheck.TIMEOUT_MS / 1000} seconds`,
              ]
              metadata["risk"] = answer ?? { risk: "unknown" }
              always = []
            }
          }
        }
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata,
        always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once" || existing.info.permission === Publish.PERMISSION) return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        if (item.info.permission === Publish.PERMISSION) continue
        // A guarded action is answered one at a time (rafiki/auto-mode.ts).
        if (item.info.metadata?.["guard"] && item.info.always.length === 0) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    // "mode" and "auto_check" are settings (core/brand/permission-mode.ts), not rules.
    if (PermissionMode.SETTINGS.has(key) || typeof value === "boolean") continue
    if (value === "auto" || value === "plan") continue
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, Config.node] })

export * as Permission from "."
