# Network resilience: plan

Goal: a dropped connection in the middle of a task costs the user a retry, not the task.

This plan covers the command line program only. It changes nothing on the gateway; what the gateway side has to do is written as a contract in [the idempotency key contract](../contracts/idempotency-key.md).

## What exists today (v0.1.9)

Verified by reading the code and by running it against a local server that cuts connections.

- **Model stream.** One model request is one call of `SessionProcessor.process` (`packages/opencode/src/session/processor.ts`). Tools run while the response is still streaming. When the stream fails, the same request is sent again from the start, inside the same stored message (`Effect.retry` with `SessionRetry.policy`). Two consequences:
  - text that had already arrived stays in the message and the full answer is appended after it;
  - a tool call that had already run is asked for again by the model and runs a second time.
- **Retry.** `packages/opencode/src/session/retry.ts` backs off from 2 seconds, doubling, with 25 percent jitter, at most 30 seconds between attempts, 5 attempts. For the Rafiki gateway a connection failure is retried once (`CONNECTION_RETRIES` in `packages/opencode/src/rafiki/gateway-errors.ts`), so that a gateway that was never reachable is reported in seconds.
- **Runtime errors.** A connection cut in the middle of a response body reaches the program as code `ECONNRESET` whatever the way it was cut (measured: reset, close, half close). A refused connection has code `ConnectionRefused`.
- **Session store.** Every part of a message (text, tool call, tool result, step marker) is written to the local SQLite store when it changes, so a finished tool call is on disk before the next one starts. The task list is written in one transaction per update (`packages/opencode/src/session/todo.ts`). A file snapshot is taken before each model request and its id is stored in the `step-start` part.
- **Resume.** `rafikicode --continue` (`-c`) and `--session <id>` (`-s`) open a stored session, for the terminal interface and for `run`. There is no `--resume` spelling.
- **Gap after a crash.** The list of files a step changed (the `patch` part that undo uses) is written when the step ends. A process killed during a step leaves a `step-start` part with a snapshot id and no `patch` part, tool calls stored as `running`, and a message with no completion time. Undo then does not restore the files of that step.
- **Gateway.** LiteLLM 1.93.0 has no idempotency key support on `/v1/chat/completions`: no request path reads such a header, and the only identifier a client can supply (`x-litellm-call-id`) labels the call for logs and does not deduplicate it. When a client disconnects during a stream the gateway cancels the upstream call and records the request with status 499.

## What changes

All logic lives in two new files, `packages/opencode/src/rafiki/resilience.ts` (retry window, wording, idempotency key) and `packages/opencode/src/rafiki/resume.ts` (stream boundary, recovery after a crash). Both apply to the Rafiki gateway provider only; other providers keep the upstream behaviour.

### 1. Resume a cut stream at a boundary

When a stream fails with a connection error, the stored message is inspected:

- **A tool call had been dispatched** (it is running, completed or failed). The request is not sent again. Tool calls whose arguments were still arriving are removed, the message is closed as a step that ended with tool calls, and the session loop sends the next request with the tool results in the history. The completed tool call does not run twice.
- **Only text had arrived.** The partial text is kept, a reasoning block that was not finished is removed, and the next request carries the partial text as an assistant message followed by one instruction to continue from where it stopped without repeating it. The model generates only the remainder.
- **Nothing usable had arrived** (no text, no dispatched tool call). The request is sent again unchanged, as today.

The gateway serves the OpenAI compatible chat completions interface, which has no way to resume a response by id, so the second form (send again with the partial output kept) is the one used.

A tool that is still running at the moment of the cut is stopped by the existing cancellation of the request scope and is reported to the model as interrupted; only completed tool calls are a boundary. Letting it finish instead needs a change inside `llm.ts` and is left out (see open questions).

Repeated cuts are bounded by the retry window below: if the connection keeps dropping for longer than the window, the task stops and the user is told.

### 2. Retry window

For the Rafiki gateway, once the gateway has answered at least once in this process, connection errors are retried with the existing backoff and jitter until a window has passed since the first failure, default 120 seconds, set with `RAFIKICODE_RETRY_WINDOW` (seconds, `0` restores the single retry). The last wait is shortened to fit the window. When the window is used up the task stops with a message that says the session is saved and how to continue.

A gateway that has not answered yet in this process keeps the single retry, so a wrong address or a machine with no network is still reported in seconds (the existing test for that stays as it is).

Messages do not show raw runtime error text. The wording follows `rafiki/doctor.ts` ("no network connection from this machine").

### 3. Idempotency key

Every request of a task step carries `Idempotency-Key: <id of the stored message the step writes into>`. The same request sent again after a failure carries the same key; a request with different content (the next step, or a continuation after a cut) carries a new one. Title and summary requests carry none.

The client half is all this repository can do. The key has no effect until the gateway or the usage collector honours it; the contract document states what is required.

### 4. Session recovery and `--resume`

- `--resume` becomes an alias of `--continue` on the terminal interface and on `run`.
- When a stored session is continued or undone and its last assistant message was left open by a process that died, the message is repaired first: tool calls stored as pending or running are marked interrupted, the files changed since the step's snapshot are recorded as a `patch` part so undo restores them, and the message is closed as interrupted.

## Upstream files touched

Each is a one or two line call into the fork layer.

| File | Change |
| --- | --- |
| `packages/opencode/src/session/processor.ts` | call the stream boundary hook before the retry policy; stamp the idempotency key on the request; pass the error through the wording function |
| `packages/opencode/src/session/retry.ts` | pass the elapsed time to the existing `retryLimit` hook and let it shorten the wait |
| `packages/opencode/src/session/prompt.ts` | append the continuation instruction when the last stored message is a cut one; call the recovery at the start of the loop |
| `packages/opencode/src/session/revert.ts` | call the recovery before an undo |
| `packages/opencode/src/cli/cmd/tui.ts`, `packages/opencode/src/cli/cmd/run.ts` | `resume` alias on the `continue` option |

`packages/opencode/src/provider/provider.ts` and `packages/opencode/src/session/llm.ts` are not touched.

## Tests

- `packages/opencode/test/lib/fault-proxy.ts`: a local proxy that forwards to a test server and cuts the connection after a chosen or a seeded random number of response bytes, and records the headers of every request.
- `packages/opencode/test/rafiki/network-resilience.test.ts`, through the real session loop and the real HTTP client:
  - a cut during streamed text: the answer is continued, the partial text is sent back once, nothing is repeated;
  - a cut while tool arguments are arriving: the incomplete call is dropped and asked for again, the tool runs once;
  - a cut after a tool call was dispatched: the tool is not run a second time and the next request carries its result;
  - seeded random cuts over a whole task: the task completes and its tool ran exactly once per requested call;
  - the idempotency key: equal on an identical request sent again, different after a continuation;
  - the retry window: retries continue inside the window and stop after it, with the saved session message.
- `packages/opencode/test/rafiki/resilience.test.ts`: unit tests of the window, the wait, the wording and the boundary classification.
- `packages/opencode/test/rafiki/resume.test.ts`: a `run` process killed during a tool call, then `--resume`: the task, the task list and the file checkpoint are restored, and undo restores the file.

## What stays for the gateway side

- Honouring `Idempotency-Key` (replay or single charge), as specified in the contract document.
- Whether a request cut by the client is charged, and for how many tokens, is decided by the gateway's handling of status 499. It is not changed or measured here.

## Open questions for the owner

1. After the retry window the task stops with a message. An interactive question ("keep trying?") is possible in the terminal interface but would block `run` in scripts. The message was chosen.
2. The window applies only after the gateway has answered once in the process. Applying it from the first request would make a wrong gateway address take two minutes to report.
3. A tool still running when the stream is cut is stopped, as on any failed request today. Letting it finish needs a hook inside `llm.ts`.
