// Send now on the server (rafiki/steer.ts): when the running step may be cut.
import { afterEach, expect, test } from "bun:test"
import * as RafikiSteer from "../../src/rafiki/steer"
import * as Steer from "@opencode-ai/core/brand/steer"

afterEach(() => RafikiSteer.forget())

test("a marked message newer than the step's input stops the step, once no tool runs", async () => {
  expect(RafikiSteer.marked([{ type: "text", text: "now", metadata: Steer.metadata() }])).toBe(true)
  expect(RafikiSteer.stop("s", "msg_0002", 0)).toBe(false)
  RafikiSteer.request("s", "msg_0005")
  // The step answers an older message: the queued one is not in its input.
  expect(RafikiSteer.stop("s", "msg_0002", 0)).toBe(true)
  // A tool call still being written or run keeps the step going.
  expect(RafikiSteer.stop("s", "msg_0002", 1)).toBe(false)
  let release!: () => void
  const tools = RafikiSteer.guard(
    { slow: { execute: () => new Promise<string>((resolve) => (release = () => resolve("ok"))) } } as never,
    "s",
  ) as unknown as { slow: { execute: () => Promise<string> } }
  const run = tools.slow.execute()
  expect(RafikiSteer.busy("s")).toBe(true)
  expect(RafikiSteer.stop("s", "msg_0002", 0)).toBe(false)
  release()
  expect(await run).toBe("ok")
  expect(RafikiSteer.stop("s", "msg_0002", 0)).toBe(true)
  // The next step reads the queued message: the request is done.
  RafikiSteer.settle("s", "msg_0005")
  expect(RafikiSteer.stop("s", "msg_0005", 0)).toBe(false)
  expect(RafikiSteer.stop("other", "msg_0001", 0)).toBe(false)
})
