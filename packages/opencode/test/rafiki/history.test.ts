// Starting the interface again in another folder after the History panel
// asked for it (src/rafiki/history.ts).
import { describe, expect, test } from "bun:test"
import * as History from "@opencode-ai/core/brand/history"
import * as RafikiHistory from "../../src/rafiki/history"

describe("reopen", () => {
  test("nothing asked for, nothing started", () => {
    let spawned = 0
    RafikiHistory.reopen({ spawn: (() => (spawned++, { status: 0 })) as never })
    expect(spawned).toBe(0)
  })

  test("a conversation of another folder starts the program there with --session and exits with its status", () => {
    History.requestReopen({ directory: "/w/one", sessionID: "ses_1" })
    const calls: { file: string; args: string[]; cwd?: string }[] = []
    let code: number | undefined
    RafikiHistory.reopen({
      spawn: ((file: string, args: string[], options: { cwd?: string }) => (calls.push({ file, args, cwd: options.cwd }), { status: 3 })) as never,
      exit: ((value: number) => {
        code = value
      }) as never,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args.slice(-3)).toEqual(["/w/one", "--session", "ses_1"])
    expect(code).toBe(3)
  })

  test("a compiled binary is started alone; a run from source starts the runtime with its entry file", () => {
    expect(RafikiHistory.command({ directory: "/w" }, ["/bin/rafikicode", "/$bunfs/root/rafikicode"], "/bin/rafikicode")).toEqual({
      file: "/bin/rafikicode",
      args: ["/w"],
      cwd: "/w",
    })
    expect(RafikiHistory.command({ directory: "/w" }, ["/usr/bin/bun", "/pkg/src/index.ts"], "/usr/bin/bun")).toEqual({
      file: "/usr/bin/bun",
      args: ["/pkg/src/index.ts", "/w"],
      cwd: "/pkg",
    })
  })
})
