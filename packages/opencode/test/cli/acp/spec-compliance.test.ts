// Agent Client Protocol conformance, driven against the real `rafikicode acp`
// subprocess over its real stdio transport. The sibling files here cover the
// handshake, auth negotiation, session lifecycle and prompt content; this one
// covers the parts of the specification an editor depends on that nothing
// else asserted:
//
//   - version negotiation when the client asks for a version we do not have
//     (spec, Initialization: "If the Agent supports the requested version, it
//     MUST respond with the same version. Otherwise, the Agent MUST respond
//     with the latest version it supports.")
//   - cancellation (spec, Prompt Turn: "After all ongoing operations have been
//     successfully aborted and pending updates have been sent, the Agent MUST
//     respond to the original `session/prompt` request with the `cancelled`
//     stop reason.") `session/cancel` is a notification, so it carries no id
//     and gets no reply, and the proof is the original request's stop reason.
//     Both are covered: cancelled mid-stream, and cancelled before the model
//     has produced anything at all.
//   - workspace trust under ACP: the warning that project code is being
//     refused has to reach the user, not only a log file.
//   - malformed input: an editor that sends a bad line, an unknown method or
//     wrong params must get a JSON-RPC answer or be ignored, never a crash or
//     a hang that leaves the editor waiting forever.
//   - stdout framing: stdout is the protocol transport, so a stray log line
//     there corrupts ndjson for every client. Nothing but JSON-RPC may appear.
//     Every test here that reads the stream asserts this of everything it saw,
//     rather than relying on nothing having been written.
//   - the first run an editor actually sees: no Rafiki key. initialize must
//     still answer (so the editor can offer the sign in action) while
//     session/new answers auth_required.
import { describe, expect } from "bun:test"
import type { InitializeResponse, PromptResponse, SessionNotification } from "@agentclientprotocol/sdk"
import { Brand } from "@opencode-ai/core/brand/brand"
import { Duration, Effect } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import type { AcpClient } from "./acp-test-client"
import { createAcpClient as createJsonRpcAcpClient, expectOk } from "./acp-test-client"
import { createAcpClient, expectErrorCode, initialize, newSession, verifierConfig } from "./helpers"

// JSON-RPC error codes the SDK's RequestError mints, as the spec's error
// shape requires (JSON-RPC 2.0 Error Object).
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const AUTH_REQUIRED = -32000

type JsonRpcResponse = { readonly id?: number; readonly result?: unknown; readonly error?: unknown }
type SessionUpdateNotification = { readonly method?: string; readonly params?: SessionNotification }

// Reads messages until the response to `id` arrives, keeping every line seen on
// the way. The generic `request` helper cannot be used for a turn that has to be
// cancelled mid-flight (the prompt has to be in the air while we send something
// else, so the send and the wait are separate here), and it also drops the
// notifications, which are part of what these tests assert.
function awaitResponse(acp: AcpClient, id: number, timeout = Duration.seconds(30)) {
  return Effect.gen(function* () {
    const seen: unknown[] = []
    while (true) {
      const received = yield* acp.receive.pipe(Effect.timeout(timeout))
      seen.push(received)
      if (received && typeof received === "object" && "id" in received) {
        const message = received as JsonRpcResponse
        if (message.id === id) return { response: message, seen }
      }
    }
  })
}

// Whatever else the turn produced after its response, so an assertion about the
// stream covers all of it and not just the part before the answer.
function drain(acp: AcpClient, into: unknown[], seconds = 2) {
  return Effect.gen(function* () {
    while (true) {
      into.push(yield* acp.receive.pipe(Effect.timeout(Duration.seconds(seconds))))
    }
  }).pipe(Effect.ignore)
}

// stdout is the protocol transport, so every line on it must be a JSON-RPC
// message. The fixture turns a line it could not parse into { _rawLine }, so a
// stray log line fails here rather than passing unnoticed.
function expectProtocolOnly(messages: readonly unknown[]) {
  expect(messages.length).toBeGreaterThan(0)
  for (const message of messages) {
    expect(message).not.toHaveProperty("_rawLine")
    expect((message as { jsonrpc?: string }).jsonrpc).toBe("2.0")
  }
}

// The text of every agent_message_chunk in a set of received lines: what a
// client renders into the conversation, which is where a user would read it.
function agentMessageText(messages: readonly unknown[]) {
  return messages
    .filter((message): message is SessionUpdateNotification => {
      if (!message || typeof message !== "object") return false
      return (message as SessionUpdateNotification).method === "session/update"
    })
    .map((message) => message.params?.update)
    .filter((update) => update?.sessionUpdate === "agent_message_chunk")
    .map((update) => {
      const content = (update as Extract<SessionNotification["update"], { sessionUpdate: "agent_message_chunk" }>)
        .content
      return content.type === "text" ? content.text : ""
    })
    .join("")
}

describe("rafikicode acp specification conformance subprocess", () => {
  cliIt.live(
    "answers the latest supported protocol version when the client asks for a newer one",
    ({ opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient({ opencode })

        // A client from a future ACP release. The agent may not echo 99 back:
        // it must name the newest version it really speaks.
        const future = expectOk(
          yield* acp.request<InitializeResponse>("initialize", {
            protocolVersion: 99,
            clientCapabilities: {},
            clientInfo: { name: "future-client", version: "9.0.0" },
          }),
        )
        expect(future.protocolVersion).toBe(1)

        // And the supported version is echoed unchanged.
        const current = expectOk(
          yield* acp.request<InitializeResponse>("initialize", {
            protocolVersion: 1,
            clientCapabilities: {},
          }),
        )
        expect(current.protocolVersion).toBe(1)
      }),
    60_000,
  )

  cliIt.live(
    "a prompt turn cancelled while the model is streaming answers with the cancelled stop reason",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)

        // A model that streams a little and then never finishes, so the turn
        // is genuinely in flight when the cancellation arrives.
        yield* llm.push(reply().text("working on it").hang())

        const promptId = 9001
        yield* acp.send({
          jsonrpc: "2.0",
          id: promptId,
          method: "session/prompt",
          params: {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Start something long." }],
          },
        })

        // Wait for the model's own text to arrive. Only an agent_message_chunk
        // proves the turn is mid-stream: available_commands_update and
        // usage_update both fire during session setup, before any model call,
        // so cancelling on those would test nothing.
        yield* acp.waitForNotification<SessionNotification>(
          "session/update",
          (params) =>
            params.sessionId === session.sessionId && params.update.sessionUpdate === "agent_message_chunk",
          30_000,
        )

        // session/cancel is a notification: no id, and no reply is expected.
        // The proof it was honoured is the original request's stop reason.
        yield* acp.send({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId: session.sessionId },
        })

        const { response, seen } = yield* awaitResponse(acp, promptId)
        expect(response.error).toBeUndefined()
        expect((response.result as PromptResponse).stopReason).toBe("cancelled")

        // A turn cancelled this late did produce token accounting, so it is
        // reported. The other cancellation test is the one with none.
        expect((response.result as PromptResponse).usage).toBeDefined()

        yield* drain(acp, seen)
        expectProtocolOnly(seen)
      }),
    120_000,
  )

  // The early cancellation, which used to answer
  //   {"code":-32603,"message":"Internal error: Internal service failure"}
  // instead of the `cancelled` stop reason the specification requires
  // unconditionally (Prompt Turn, Cancellation: "After all ongoing operations
  // have been successfully aborted and pending updates have been sent, the
  // Agent MUST respond to the original `session/prompt` request with the
  // `cancelled` stop reason."). That is why it was written as a failing test
  // first. Two faults were behind it, and this covers both:
  //   1. a turn cancelled this early resolves with a message that carries no
  //      token accounting at all, and UsageService.buildUsage dereferenced it
  //      unconditionally, so the turn died of a TypeError. It now reports no
  //      `usage` rather than inventing zeros, which this asserts.
  //   2. that same message carries no MessageAbortedError, so a stop reason
  //      inferred from it read as `end_turn`. The agent now records the
  //      cancellation itself (a per session flag in ACPSession, set when
  //      session/cancel arrives and cleared at the start of every turn),
  //      which is what makes this path and the mid-stream one agree.
  cliIt.live(
    "a prompt turn cancelled before the model answers still answers with the cancelled stop reason",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        yield* llm.push(reply().text("working on it").hang())

        const promptId = 9002
        yield* acp.send({
          jsonrpc: "2.0",
          id: promptId,
          method: "session/prompt",
          params: {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Start something long." }],
          },
        })

        // No wait at all: the editor user who hits Escape straight away.
        yield* acp.send({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId: session.sessionId },
        })

        const { response, seen } = yield* awaitResponse(acp, promptId)
        expect(response.error).toBeUndefined()
        const result = response.result as PromptResponse
        expect(result.stopReason).toBe("cancelled")

        // No token accounting existed for this turn, and `usage` is optional on
        // PromptResponse precisely so that can be said. Zeros would claim the
        // turn is known to have cost nothing, which is a different fact.
        expect(result.usage ?? undefined).toBeUndefined()

        yield* drain(acp, seen)
        expectProtocolOnly(seen)
      }),
    120_000,
  )

  cliIt.live(
    "malformed input is answered or ignored and never crashes or wedges the connection",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)

        // Lines that are not JSON at all, and a line that is JSON but not a
        // JSON-RPC message. The transport logs and drops these, so no reply
        // comes back — what matters is that the connection stays usable.
        yield* acp.sendRaw("this is not json at all")
        yield* acp.sendRaw('{"jsonrpc":"2.0","id":4242,"method":"initialize","params":{')
        yield* acp.sendRaw("[1,2,3]")

        // An unknown method must answer method not found, not disconnect.
        const unknown = yield* acp.request("session/doesNotExist", { sessionId: "x" })
        expectErrorCode(unknown.error, METHOD_NOT_FOUND)

        // A known method with a session that does not exist must answer
        // invalid params, carrying no secrets.
        const missingSession = yield* acp.request<PromptResponse>("session/prompt", {
          sessionId: "ses_does_not_exist",
          prompt: [{ type: "text", text: "hello" }],
        })
        expectErrorCode(missingSession.error, INVALID_PARAMS)

        // A known method with params of the wrong shape altogether.
        const badParams = yield* acp.request("session/prompt", { nonsense: true })
        expect(badParams.error).toBeDefined()
        expect(typeof (badParams.error as { code?: unknown }).code).toBe("number")

        // The connection still works afterwards: the agent is alive and
        // serving, which is the whole point of the three probes above.
        const session = yield* newSession(acp, home)
        expect(session.sessionId.length).toBeGreaterThan(0)

        yield* llm.text("still here")
        const after = expectOk(
          yield* acp.request<PromptResponse>("session/prompt", {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Are you still there?" }],
          }),
        )
        expect(after.stopReason).toBe("end_turn")
      }),
    120_000,
  )

  cliIt.live(
    "stdout carries only JSON-RPC messages for a whole turn",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        yield* llm.text("framing holds")

        // Sent raw so that every line of the turn, including the notifications
        // the agent streams while answering, is kept and checked. `request`
        // would read those and throw them away.
        const promptId = 9004
        yield* acp.send({
          jsonrpc: "2.0",
          id: promptId,
          method: "session/prompt",
          params: {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Say something." }],
          },
        })
        const { response, seen } = yield* awaitResponse(acp, promptId)
        expect(response.error).toBeUndefined()
        expect((response.result as PromptResponse).stopReason).toBe("end_turn")

        // Then whatever else the turn produced. The fixture turns any stdout
        // line it could not parse into { _rawLine }, so an unparseable line
        // shows up here rather than silently passing.
        yield* drain(acp, seen)
        expectProtocolOnly(seen)
      }),
    120_000,
  )

  // Workspace trust under ACP. The raw warning must never be written to stdout,
  // which is the protocol transport: a bare line there corrupts ndjson framing
  // for every client. stderr alone, though, tells the user nothing, because an
  // editor captures the agent's stderr to a log file at best. ACP 0.21.0 has no
  // logging or diagnostic method, so the warning is delivered as the one
  // session update kind a client is certain to render where the user is
  // looking, agent_message_chunk, and stderr is kept as well. The turn itself
  // still succeeds: refusing the project's code is correct behaviour, and only
  // the silence about it was the bug.
  cliIt.live(
    "an untrusted workspace tells the user over the protocol as well as on stderr",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        // A workspace that is a git checkout and also holds the config
        // directory, which is how a dotfiles repository looks. Trust refuses a
        // config directory inside a checkout (BrandTrust.homeConfigInCheckout),
        // so the project's tool directory is dropped and a warning is raised —
        // the condition this test is about. The workspace is also where the
        // agent is started, the way an editor starts it in the open project.
        const workspace = path.join(home, "project")
        yield* Effect.promise(() => mkdir(path.join(workspace, ".rafikicode", "tool"), { recursive: true }))
        yield* Effect.promise(() => mkdir(path.join(workspace, ".git"), { recursive: true }))
        yield* Effect.promise(() => Bun.write(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n"))
        yield* Effect.promise(() =>
          Bun.write(
            path.join(workspace, ".rafikicode", "tool", "project-tool.ts"),
            'export default { name: "project-tool", description: "x", async execute() { return "ran" } }\n',
          ),
        )

        const acp = createJsonRpcAcpClient(
          yield* opencode.acp({
            cwd: workspace,
            env: {
              OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)),
              HOME: workspace,
              OPENCODE_TEST_HOME: workspace,
              XDG_CONFIG_HOME: path.join(workspace, ".config"),
              // test/preload.ts trusts every workspace so the upstream suites
              // keep exercising project loading. Clear it: this test is about
              // what an untrusted workspace does.
              [Brand.env.trustWorkspace]: "",
            },
          }),
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, workspace)

        yield* llm.text("answered anyway")

        // Sent without the `request` helper on purpose: that one drops every
        // notification it reads while waiting, and the notifications are what
        // this test is about.
        const promptId = 9003
        yield* acp.send({
          jsonrpc: "2.0",
          id: promptId,
          method: "session/prompt",
          params: {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Do something." }],
          },
        })
        const { response, seen } = yield* awaitResponse(acp, promptId)
        yield* drain(acp, seen)

        // The project's code is still refused, and the turn still answers. That
        // behaviour is correct: markHeadless only marks `run` headless, so an
        // ACP session is not headless, and an untrusted workspace falls through
        // to PROJECT_CODE = "trusted", which refuses project code and warns.
        expect(response.error).toBeUndefined()
        expect((response.result as PromptResponse).stopReason).toBe("end_turn")

        // The warning still goes to stderr, which stays the right place for a
        // diagnostic and the fallback when no sink is installed.
        const stderr = acp.stderrText()
        expect(stderr).toContain("not trusted")
        expect(stderr).toContain(`${Brand.name} trust`)

        // And the user is now told, in the one place a client renders for them.
        // It names what was dropped and how to fix it, under the brand name.
        const spoken = agentMessageText(seen)
        expect(spoken).toContain("not trusted")
        expect(spoken).toContain("not loading")
        expect(spoken).toContain(`${Brand.name} trust`)
        expect(spoken).not.toContain("opencode")

        // Still nothing but JSON-RPC on stdout. The warning travels as a
        // session/update notification, which is protocol; the raw line never
        // goes near the transport.
        expectProtocolOnly(seen)
      }),
    120_000,
  )

  cliIt.live(
    "without a Rafiki key initialize still answers and session/new answers auth_required",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // The provider scope is what the shipped binary enforces; the test
        // preload turns it off for every other suite, so this is the only
        // place the real first run of an editor is exercised. The key env var
        // is blanked so a developer machine that has one cannot mask this.
        const acp = yield* createAcpClient(
          { opencode },
          { RAFIKICODE_TEST_PROVIDER_SCOPE: "on", [Brand.env.apiKey]: "" },
        )

        // initialize must still succeed: this is how the editor learns there
        // is a sign in action to offer at all.
        const initialized = yield* initialize(acp)
        expect(initialized.protocolVersion).toBe(1)
        expect(initialized.authMethods?.[0]?.id).toBe(Brand.acp.authMethod)
        expect(initialized.authMethods?.[0]?.name).toContain(Brand.product)

        // Opening a session, though, must fail loudly rather than hand the
        // editor a session that can never answer.
        const refused = yield* acp.request("session/new", { cwd: home, mcpServers: [] })
        expectErrorCode(refused.error, AUTH_REQUIRED)
        const message = JSON.stringify(refused.error)
        expect(message).toContain(Brand.name)
        expect(message).not.toContain("opencode")
      }),
    60_000,
  )
})
