// The retry window, the wording and the idempotency key (rafiki/resilience.ts),
// and what counts as a boundary in a cut stream (rafiki/resume.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import * as Resilience from "../../src/rafiki/resilience"
import * as Resume from "../../src/rafiki/resume"

const reset = {
  name: "APIError",
  data: { message: "Connection reset by server", isRetryable: true, metadata: { code: "ECONNRESET" } },
}
const refused = { name: "APIError", data: { message: "Cannot connect to API: Unable to connect", isRetryable: true } }
const unavailable = {
  name: "APIError",
  data: { message: "down", statusCode: 503, metadata: { rafiki_code: "gateway_unavailable" } },
}
const limited = {
  name: "APIError",
  data: { message: "slow down", statusCode: 429, metadata: { rafiki_code: "rate_limited" } },
}

let saved: string | undefined

beforeEach(() => {
  saved = process.env[Resilience.WINDOW_ENV]
  delete process.env[Resilience.WINDOW_ENV]
  Resilience.markAnswered(false)
})

afterEach(() => {
  if (saved === undefined) delete process.env[Resilience.WINDOW_ENV]
  else process.env[Resilience.WINDOW_ENV] = saved
  Resilience.markAnswered(false)
})

describe("retry window", () => {
  test("is two minutes unless RAFIKICODE_RETRY_WINDOW says otherwise", () => {
    expect(Resilience.windowMs({})).toBe(120_000)
    expect(Resilience.windowMs({ RAFIKICODE_RETRY_WINDOW: "30" })).toBe(30_000)
    expect(Resilience.windowMs({ RAFIKICODE_RETRY_WINDOW: "0" })).toBe(0)
    expect(Resilience.windowMs({ RAFIKICODE_RETRY_WINDOW: "1.5" })).toBe(1500)
    expect(Resilience.windowMs({ RAFIKICODE_RETRY_WINDOW: "soon" })).toBe(120_000)
    expect(Resilience.windowMs({ RAFIKICODE_RETRY_WINDOW: "-5" })).toBe(120_000)
    expect(Resilience.windowMs({ RAFIKICODE_RETRY_WINDOW: "999999" })).toBe(3_600_000)
  })

  test("a connection error is a failure with no HTTP answer, on the Rafiki provider", () => {
    expect(Resilience.isConnectionError("rafiki", reset)).toBe(true)
    expect(Resilience.isConnectionError("rafiki", refused)).toBe(true)
    expect(Resilience.isConnectionError("rafiki", unavailable)).toBe(false)
    expect(Resilience.isConnectionError("rafiki", limited)).toBe(false)
    expect(Resilience.isConnectionError("openai", reset)).toBe(false)
    expect(Resilience.isConnectionError("rafiki", { name: "UnknownError", data: { message: "boom" } })).toBe(false)
  })

  test("before the gateway has answered, a connection error keeps the single retry", () => {
    expect(Resilience.keepRetrying("rafiki", refused, { attempt: 1, elapsed: 0, input: {} }, 5)).toBe(true)
    expect(Resilience.keepRetrying("rafiki", refused, { attempt: 2, elapsed: 2000, input: {} }, 5)).toBe(false)
    expect(Resilience.wait("rafiki", refused, { attempt: 1, elapsed: 0, input: {} }, 2000)).toBe(2000)
  })

  test("after the gateway has answered, a connection error is retried until the window has passed", () => {
    Resilience.markAnswered()
    const cause = new Error("socket closed")
    expect(Resilience.keepRetrying("rafiki", reset, { attempt: 1, elapsed: 0, input: cause }, 5)).toBe(true)
    expect(Resilience.keepRetrying("rafiki", reset, { attempt: 9, elapsed: 119_000, input: cause }, 5)).toBe(true)
    expect(Resilience.isExhausted(cause)).toBe(false)
    expect(Resilience.keepRetrying("rafiki", reset, { attempt: 10, elapsed: 120_000, input: cause }, 5)).toBe(false)
    expect(Resilience.isExhausted(cause)).toBe(true)
    // Once given up, it stays given up whatever the clock says.
    expect(Resilience.keepRetrying("rafiki", reset, { attempt: 1, elapsed: 0, input: cause }, 5)).toBe(false)
  })

  test("the last wait is cut short to end with the window", () => {
    Resilience.markAnswered()
    expect(Resilience.wait("rafiki", reset, { attempt: 3, elapsed: 10_000, input: {} }, 8000)).toBe(8000)
    expect(Resilience.wait("rafiki", reset, { attempt: 8, elapsed: 115_000, input: {} }, 30_000)).toBe(5000)
    expect(Resilience.wait("rafiki", reset, { attempt: 9, elapsed: 121_000, input: {} }, 30_000)).toBe(0)
  })

  test("answers with a status, other providers and a window of 0 keep the attempt limits they had", () => {
    Resilience.markAnswered()
    expect(Resilience.keepRetrying("rafiki", unavailable, { attempt: 2, elapsed: 0, input: {} }, 5)).toBe(false)
    expect(Resilience.keepRetrying("openai", reset, { attempt: 5, elapsed: 500_000, input: {} }, 5)).toBe(true)
    expect(Resilience.keepRetrying("openai", reset, { attempt: 6, elapsed: 0, input: {} }, 5)).toBe(false)
    process.env[Resilience.WINDOW_ENV] = "0"
    expect(Resilience.keepRetrying("rafiki", reset, { attempt: 2, elapsed: 0, input: {} }, 5)).toBe(false)
  })
})

describe("wording", () => {
  test("says how long it tried, that the session is saved and how to continue, with no runtime error text", () => {
    const message = Resilience.windowMessage(new Error("The socket connection was closed unexpectedly"), 120_000)
    expect(message).toBe(
      "The connection to the model gateway was lost and did not come back for 2 minutes. The session is saved: send a message to continue, or run rafikicode --resume later.",
    )
    expect(Resilience.windowMessage(new Error("x"), 3000)).toContain("for 3 seconds")
    expect(Resilience.windowMessage(new Error("x"), 60_000)).toContain("for 1 minute.")
  })

  test("names a machine with no network the way doctor does", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND gateway.rafikiai.io"), { code: "ENOTFOUND" })
    const message = Resilience.windowMessage(cause, 120_000)
    expect(message).toContain("no network connection from this machine")
    expect(message).not.toContain("ENOTFOUND")
    expect(message).not.toContain("getaddrinfo")
  })

  test("replaces the message of a failure the retries gave up on and keeps its classification", () => {
    const cause = new Error("socket closed")
    expect(Resilience.describe(reset, cause)).toBe(reset)
    Resilience.exhaust(cause, Resilience.cutsMessage(5))
    const described = Resilience.describe(reset, cause)
    expect(described.data.message).toContain("dropped 5 times in a row")
    expect(described.data.metadata).toEqual({ code: "ECONNRESET" })
    expect(described.name).toBe("APIError")
    expect(reset.data.message).toBe("Connection reset by server")
  })
})

describe("idempotency key", () => {
  test("is the step id, on the Rafiki provider only, and leaves the input untouched", () => {
    const input = {
      model: { providerID: "rafiki", headers: { "X-Other": "1" } as Record<string, string> },
      messages: [],
    }
    const stamped = Resilience.stamp(input, "msg_abc")
    expect(stamped.model.headers).toEqual({ "X-Other": "1", "Idempotency-Key": "msg_abc" })
    expect(input.model.headers).toEqual({ "X-Other": "1" })
    const other = { model: { providerID: "openai" } }
    expect(Resilience.stamp(other, "msg_abc")).toBe(other)
  })
})

function assistant(parts: Array<Record<string, unknown>>, info: Record<string, unknown> = {}): SessionV1.WithParts {
  return {
    info: {
      id: "msg_a",
      sessionID: "ses_1",
      role: "assistant",
      providerID: "rafiki",
      modelID: "rafiki-fast",
      time: { created: 1, completed: 2 },
      ...info,
    },
    parts: parts.map((part, i) => ({ id: `prt_${i}`, sessionID: "ses_1", messageID: "msg_a", ...part })),
  } as unknown as SessionV1.WithParts
}

const user = {
  info: {
    id: "msg_u",
    sessionID: "ses_1",
    role: "user",
    agent: "build",
    model: { providerID: "rafiki", modelID: "rafiki-fast" },
    time: { created: 0 },
  },
  parts: [{ id: "prt_u", sessionID: "ses_1", messageID: "msg_u", type: "text", text: "do it" }],
} as unknown as SessionV1.WithParts

const start = { type: "step-start" }
const finish = { type: "step-finish" }
const text = (value: string) => ({ type: "text", text: value })
const tool = (status: string, extra: Record<string, unknown> = {}) => ({
  type: "tool",
  tool: "bash",
  callID: "c",
  state: { status },
  ...extra,
})

describe("boundary of a cut stream", () => {
  test("a dispatched tool call is a boundary, an incomplete one is not", () => {
    expect(Resume.boundary(assistant([start, tool("completed")]).parts)).toBe("tools")
    expect(Resume.boundary(assistant([start, tool("running")]).parts)).toBe("tools")
    expect(Resume.boundary(assistant([start, tool("error")]).parts)).toBe("tools")
    expect(Resume.boundary(assistant([start, tool("pending")]).parts)).toBe("none")
    expect(Resume.boundary(assistant([start, tool("completed", { metadata: { providerExecuted: true } })]).parts)).toBe(
      "none",
    )
  })

  test("text is a boundary whether stored or still arriving, blank text and reasoning are not", () => {
    expect(Resume.boundary(assistant([start, text("partial")]).parts)).toBe("text")
    expect(Resume.boundary(assistant([start, text("")]).parts, "partial")).toBe("text")
    expect(Resume.boundary(assistant([start, text("  ")]).parts, " \n")).toBe("none")
    expect(Resume.boundary(assistant([start, { type: "reasoning", text: "thinking" }]).parts)).toBe("none")
    expect(Resume.boundary(assistant([start, text("partial"), tool("pending")]).parts)).toBe("text")
  })

  test("a cut text step is one that started, never ended, has no error and holds only text", () => {
    expect(Resume.isCutText(assistant([start, text("partial")]))).toBe(true)
    expect(Resume.isCutText(assistant([start, text("whole"), finish], { finish: "stop" }))).toBe(false)
    expect(
      Resume.isCutText(assistant([start, text("partial")], { error: { name: "MessageAbortedError", data: {} } })),
    ).toBe(false)
    expect(Resume.isCutText(assistant([start, text("partial"), tool("completed")]))).toBe(false)
    expect(Resume.isCutText(assistant([start, text("partial")], { time: { created: 1 } }))).toBe(false)
    expect(Resume.isCutText(assistant([start, text("partial")], { providerID: "openai" }))).toBe(false)
    expect(Resume.isCutText(assistant([text("seeded")]))).toBe(false)
  })

  test("the instruction to continue follows every cut text step and nothing else", () => {
    const whole = assistant([start, text("whole"), finish], { finish: "stop" })
    expect(Resume.withContinuations([user, whole])).toEqual([user, whole])

    const cut = assistant([start, text("partial")])
    const next = assistant([start, tool("completed"), finish], { id: "msg_b", finish: "tool-calls" })
    const out = Resume.withContinuations([user, cut, next])
    expect(out.map((message) => message.info.role)).toEqual(["user", "assistant", "user", "assistant"])
    const inserted = out[2]
    expect(inserted.parts).toHaveLength(1)
    expect(inserted.parts[0]).toMatchObject({ type: "text", text: Resume.CONTINUE_PROMPT, synthetic: true })
    expect((inserted.info as { model?: unknown }).model).toEqual({ providerID: "rafiki", modelID: "rafiki-fast" })
    expect(inserted.info.id).not.toBe(user.info.id)
  })

  test("counts the cut steps in a row at the end of the history", () => {
    const cut = assistant([start, text("partial")])
    const cutTools = assistant([start, tool("completed")])
    const whole = assistant([start, text("whole"), finish], { finish: "stop" })
    expect(Resume.streak([user])).toBe(0)
    expect(Resume.streak([user, cut])).toBe(1)
    expect(Resume.streak([user, cut, cutTools, cut])).toBe(3)
    expect(Resume.streak([user, cut, whole, cut])).toBe(1)
    expect(Resume.streak([user, cut, whole])).toBe(0)
  })
})
