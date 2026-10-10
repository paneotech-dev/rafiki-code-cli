// Publishing code asks every time: the permission service ignores a wildcard
// allow, an allowed shell and an earlier "always" for it, and only a rule
// written for "publish" by name can deny it. The shell tool builds the
// question from the command (rafiki/publish-guard.ts).
import { expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import * as PublishGuard from "../../src/rafiki/publish-guard"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)
const session = SessionID.make("session_publish")

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    while (true) {
      const list = yield* permission.list()
      if (list.length === count) return list
      yield* Effect.sleep("10 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "1 second",
      orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending request(s)`)),
    }),
  )

function publishAsk(ruleset: PermissionV1.Ruleset, command = "git push origin main") {
  return Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask({
      sessionID: session,
      permission: "publish",
      patterns: [command],
      always: [],
      metadata: { command },
      ruleset,
    })
  })
}

const reply = (reply: "once" | "always" | "reject") =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (const item of yield* permission.list()) yield* permission.reply({ requestID: item.id, reply })
  })

it.instance(
  "a wildcard allow and an allowed shell still ask",
  () =>
    Effect.gen(function* () {
      const ruleset: PermissionV1.Ruleset = [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "publish", pattern: "*", action: "allow" },
      ]
      const fiber = yield* publishAsk(ruleset).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      expect(pending[0].permission).toBe("publish")
      yield* reply("once")
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "an answer of always is not remembered: the next push asks again",
  () =>
    Effect.gen(function* () {
      const ruleset: PermissionV1.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }]
      const first = yield* publishAsk(ruleset).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply("always")
      expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
      const second = yield* publishAsk(ruleset).pipe(Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* reply("reject")
      expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true)
    }),
  { git: true },
)

it.instance(
  "a rejection fails the call",
  () =>
    Effect.gen(function* () {
      const fiber = yield* publishAsk([{ permission: "*", pattern: "*", action: "allow" }]).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply("reject")
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

it.instance(
  "a rule written for publish can deny it without a question; a wildcard deny cannot stand in for it",
  () =>
    Effect.gen(function* () {
      const exit = yield* publishAsk([
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "publish", pattern: "*", action: "deny" },
      ]).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeniedError)
      const permission = yield* Permission.Service
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true },
)

test("the shell tool's question: what it names, and nothing for other commands", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-publish-guard-"))
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir })
    spawnSync("git", ["config", "alias.ship", "push -u origin HEAD"], { cwd: dir })
    const request = PublishGuard.request("npm test && git ship", ["npm test", "git ship"], dir)
    expect(request).toBeDefined()
    expect(request!.permission).toBe("publish")
    expect(request!.always).toEqual([])
    expect(request!.patterns).toEqual(["npm test && git ship"])
    expect(request!.metadata.publish).toEqual(["git push, through the git alias ship"])
    expect(PublishGuard.request("git status && ls", ["git status", "ls"], dir)).toBeUndefined()
    const force = PublishGuard.request("git -C . push --force", ["git -C . push --force"], dir)
    expect(force!.metadata.publish).toEqual(["git push (force)"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
