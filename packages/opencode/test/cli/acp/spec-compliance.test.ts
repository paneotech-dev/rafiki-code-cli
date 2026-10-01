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
//     and gets no reply — the proof is the original request's stop reason.
//   - malformed input: an editor that sends a bad line, an unknown method or
//     wrong params must get a JSON-RPC answer or be ignored, never a crash or
//     a hang that leaves the editor waiting forever.
//   - stdout framing: stdout is the protocol transport, so a stray log line
//     there corrupts ndjson for every client. Nothing but JSON-RPC may appear.
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

// Reads messages until the response to `id` arrives, letting session/update
// notifications past. The generic `request` helper cannot be used for a turn
// that has to be cancelled mid-flight: the prompt has to be in the air while
// we send something else, so the send and the wait are separate here.
function awaitResponse(acp: AcpClient, id: number, timeout = Duration.seconds(30)) {
  return Effect.gen(function* () {
    while (true) {
      const received = yield* acp.receive.pipe(Effect.timeout(timeout))
      if (received && typeof received === "object" && "id" in received) {
        const message = received as JsonRpcResponse
        if (message.id === id) return message
      }
    }
  })
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

        const response = yield* awaitResponse(acp, promptId)
        expect(response.error).toBeUndefined()
        expect((response.result as PromptResponse).stopReason).toBe("cancelled")
      }),
    120_000,
  )

  // KNOWN FAILING — this test documents a real conformance bug, it is not flake.
  //
  // Cancelling before the model has produced any token accounting answers
  //   {"code":-32603,"message":"Internal error: Internal service failure"}
  // instead of a `cancelled` stop reason, which the specification requires
  // unconditionally (Prompt Turn, Cancellation: "After all ongoing operations
  // have been successfully aborted and pending updates have been sent, the
  // Agent MUST respond to the original `session/prompt` request with the
  // `cancelled` stop reason.").
  //
  // Root cause: the aborted assistant message comes back with no `tokens`
  // field, and UsageService.buildUsage (src/acp/usage.ts:91) dereferences
  // `message.tokens.cache.read` unconditionally, so it throws
  //   TypeError: undefined is not an object (evaluating 'message.tokens.cache')
  // from src/acp/service.ts:848. ACPError.fromUnknownDefect then discards the
  // defect, which is why even stderr shows nothing but the generic message.
  //
  // Two separate faults, both needing a decision:
  //   1. buildUsage must tolerate a message with no token accounting.
  //   2. Even without the crash, this message has no MessageAbortedError, so
  //      promptResponse would fall into its `!info?.error` branch and report
  //      `end_turn` — also wrong. Cancellation has to be tracked by the agent
  //      rather than inferred from the backing message's error.
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

        const response = yield* awaitResponse(acp, promptId)
        expect(response.error).toBeUndefined()
        expect((response.result as PromptResponse).stopReason).toBe("cancelled")
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
        const seen: unknown[] = []
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        yield* llm.text("framing holds")
        expectOk(
          yield* acp.request<PromptResponse>("session/prompt", {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Say something." }],
          }),
        )

        // Drain whatever else the turn produced. The fixture turns any stdout
        // line it could not parse into { _rawLine }, so an unparseable line
        // shows up here rather than silently passing.
        yield* Effect.gen(function* () {
          while (true) {
            seen.push(yield* acp.receive.pipe(Effect.timeout(Duration.seconds(2))))
          }
        }).pipe(Effect.ignore)

        for (const message of seen) {
          expect(message).not.toHaveProperty("_rawLine")
          expect((message as { jsonrpc?: string }).jsonrpc).toBe("2.0")
        }
      }),
    120_000,
  )

  // Workspace trust under ACP. The warning must never reach stdout, which is
  // the protocol transport — a bare line there corrupts ndjson framing for
  // every client. It goes to stderr instead, and this test pins the
  // consequence: ACP has no notification for agent diagnostics (the only
  // SessionUpdate kinds are message/thought chunks, tool calls, plans, usage,
  // modes, config and commands), so an editor user is told nothing at all
  // while their project's tools are dropped and the turn reports end_turn.
  cliIt.live(
    "an untrusted workspace warns on stderr only and never on the protocol stream",
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
        const protocolMessages: unknown[] = [
          expectOk(
            yield* acp.request<PromptResponse>("session/prompt", {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "Do something." }],
            }),
          ),
        ]
        yield* Effect.gen(function* () {
          while (true) {
            protocolMessages.push(yield* acp.receive.pipe(Effect.timeout(Duration.seconds(2))))
          }
        }).pipe(Effect.ignore)

        // The warning exists, and it is on stderr.
        const stderr = acp.stderrText()
        expect(stderr).toContain("not trusted")
        expect(stderr).toContain(`${Brand.name} trust`)

        // Nothing about trust reached the client over the protocol. This is
        // the gap: the editor cannot tell the user, because the agent never
        // told the editor.
        const wire = JSON.stringify(protocolMessages)
        expect(wire).not.toContain("not trusted")
        expect(wire).not.toContain("not loading")
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
