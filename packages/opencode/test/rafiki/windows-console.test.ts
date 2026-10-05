// Which Windows consoles are refused, decided without Windows: the console
// mode and the console window are stubbed, the environment is injected, and
// the decision is the real one. The rule under test: refuse only a console
// that cannot draw (virtual terminal processing refused) or the visible
// classic console host; start everywhere else, including when the probe
// itself fails.
import { describe, expect, test } from "bun:test"
import * as WindowsConsole from "../../src/rafiki/windows-console"

const { CLASSIC_WINDOW, PSEUDO_WINDOW } = WindowsConsole

function probe(vt: boolean | undefined | "throws", window?: WindowsConsole.Window | "throws"): WindowsConsole.Probe & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    enableVirtualTerminal() {
      calls.push("vt")
      if (vt === "throws") throw new Error("SetConsoleMode exploded")
      return vt
    },
    window() {
      calls.push("window")
      if (window === "throws") throw new Error("user32 missing")
      return window
    },
  }
}

describe("the Windows console decision", () => {
  test("terminals that work are never refused", () => {
    const cases: [string, Record<string, string>, WindowsConsole.Probe][] = [
      ["Windows Terminal", { WT_SESSION: "b5a1" }, probe(true, { className: PSEUDO_WINDOW, visible: false })],
      ["VS Code", { TERM_PROGRAM: "vscode" }, probe(true, { className: PSEUDO_WINDOW, visible: false })],
      ["WezTerm", { TERM_PROGRAM: "WezTerm" }, probe(true, { className: PSEUDO_WINDOW, visible: false })],
      ["OpenSSH server", { SSH_CONNECTION: "10.0.0.2 5000 10.0.0.1 22" }, probe(true, { className: PSEUDO_WINDOW, visible: false })],
      ["SSH with no console window", { SSH_CLIENT: "10.0.0.2 5000 22" }, probe(true, undefined)],
      ["Git Bash mintty through winpty", { MSYSTEM: "MINGW64", TERM: "xterm" }, probe(true, { className: CLASSIC_WINDOW, visible: false })],
      ["ConEmu over a hidden console", { ConEmuANSI: "ON" }, probe(true, { className: CLASSIC_WINDOW, visible: false })],
      ["ConEmu with its real console shown", { ConEmuANSI: "ON" }, probe(true, { className: CLASSIC_WINDOW, visible: true })],
      ["an unknown console window", {}, probe(true, { className: "SomeOtherHost", visible: true })],
      ["output that is not a console handle", {}, probe(undefined, undefined)],
    ]
    for (const [name, env, p] of cases) {
      const verdict = WindowsConsole.decide(env, p)
      expect({ name, ok: verdict.ok }).toEqual({ name, ok: true })
    }
  })

  test("virtual terminal processing is turned on first, and a console that refuses it is refused", () => {
    const p = probe(false, { className: PSEUDO_WINDOW, visible: false })
    expect(WindowsConsole.decide({}, p)).toEqual({
      ok: false,
      reason: "no_virtual_terminal",
      host: "a console that refuses virtual terminal processing",
    })
    // Nothing else is asked once the console cannot draw at all.
    expect(p.calls).toEqual(["vt"])
  })

  test("the visible classic console host is refused, even when it inherited Windows Terminal's variable", () => {
    for (const env of [{}, { WT_SESSION: "b5a1" }, { TERM_PROGRAM: "vscode" }]) {
      const p = probe(true, { className: CLASSIC_WINDOW, visible: true })
      expect(WindowsConsole.decide(env, p)).toEqual({
        ok: false,
        reason: "classic_console",
        host: "the classic Windows console host (conhost.exe)",
      })
      expect(p.calls).toEqual(["vt", "window"])
    }
  })

  test("a probe that fails starts the interface: when in doubt, it starts as it always has", () => {
    expect(WindowsConsole.decide({}, probe("throws", "throws")).ok).toBe(true)
    expect(WindowsConsole.decide({}, probe(true, "throws")).ok).toBe(true)
    expect(WindowsConsole.decide({}, probe("throws", { className: PSEUDO_WINDOW, visible: false })).ok).toBe(true)
  })

  test("RAFIKICODE_FORCE_TUI=1 starts the interface without asking the console anything", () => {
    const p = probe(false, { className: CLASSIC_WINDOW, visible: true })
    expect(WindowsConsole.decide({ RAFIKICODE_FORCE_TUI: "1" }, p).ok).toBe(true)
    expect(p.calls).toEqual([])
  })

  test("the question only arises on Windows, unless a test asks for a fixed console", () => {
    expect(WindowsConsole.check({}, "linux")).toBeUndefined()
    expect(WindowsConsole.check({}, "darwin")).toBeUndefined()
    expect(WindowsConsole.check({ RAFIKICODE_TEST_CONSOLE: "conhost" }, "linux")).toMatchObject({ ok: false, reason: "classic_console" })
    expect(WindowsConsole.check({ RAFIKICODE_TEST_CONSOLE: "legacy" }, "linux")).toMatchObject({ ok: false, reason: "no_virtual_terminal" })
    expect(WindowsConsole.check({ RAFIKICODE_TEST_CONSOLE: "terminal" }, "linux")).toMatchObject({ ok: true })
    // An unknown test value is ignored, not treated as a refusal.
    expect(WindowsConsole.check({ RAFIKICODE_TEST_CONSOLE: "nonsense" }, "linux")).toBeUndefined()
  })

  test("where the Windows libraries cannot be loaded, the interface starts", () => {
    // On this platform dlopen of kernel32.dll fails, which is the same path a
    // broken Windows install would take.
    if (process.platform === "win32") return
    expect(WindowsConsole.check({}, "win32")).toEqual({
      ok: true,
      host: "not checked, the console functions could not be loaded",
    })
  })
})
