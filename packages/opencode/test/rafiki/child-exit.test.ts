// A binary that started itself again (fixed temporary folder, update, another
// folder) must never return to the prompt in silence: a child ended by a signal
// the user did not send is reported in one line and the exit code is non-zero.
import { describe, expect, test } from "bun:test"
import * as ChildExit from "../../src/rafiki/child-exit"

function pass(run: { status: number | null; signal: string | null }) {
  const written: string[] = []
  let code: number | undefined
  try {
    ChildExit.passOn(
      run,
      ((value: number) => {
        code = value
        throw new Error("exit")
      }) as (code: number) => never,
      (text) => written.push(text),
    )
  } catch {}
  return { code, written: written.join("") }
}

describe("passing on how the restarted child ended", () => {
  test("a status is passed on as it is, with nothing printed", () => {
    expect(pass({ status: 0, signal: null })).toEqual({ code: 0, written: "" })
    expect(pass({ status: 6, signal: null })).toEqual({ code: 6, written: "" })
  })

  test("killed by the system: one line with the cause and the fix, and 137", () => {
    const result = pass({ status: null, signal: "SIGKILL" })
    expect(result.code).toBe(137)
    expect(result.written.trim().split("\n")).toHaveLength(1)
    expect(result.written).toContain("rafikicode was stopped by the system (SIGKILL)")
    expect(result.written).toContain("memory limit")
  })

  test("a crash names the signal and the next step", () => {
    const result = pass({ status: null, signal: "SIGSEGV" })
    expect(result.code).toBe(139)
    expect(result.written).toContain("stopped unexpectedly (SIGSEGV)")
    expect(result.written).toContain("rafikicode doctor")
  })

  test("a signal the user sent stays quiet, and the code still says it was stopped", () => {
    expect(pass({ status: null, signal: "SIGINT" })).toEqual({ code: 130, written: "" })
    expect(pass({ status: null, signal: "SIGTERM" })).toEqual({ code: 143, written: "" })
  })

  test("neither a status nor a signal is still reported, never silent", () => {
    const result = pass({ status: null, signal: null })
    expect(result.code).toBe(1)
    expect(result.written).toContain("rafikicode doctor")
  })
})
