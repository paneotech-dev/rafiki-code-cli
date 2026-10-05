// Can this Windows console draw the full screen interface?
//
// Why this file exists: on Windows 10, Windows PowerShell and cmd open in the
// classic console host (conhost.exe) unless Windows Terminal is installed and
// chosen as the default. The full screen interface does not draw there, and a
// user who started rafikicode in such a window saw nothing at all, with no
// word as to why. This module names the condition before the interface is
// loaded, so startup can say so and point at Windows Terminal and the run
// command, and doctor can report it.
//
// The decision, Windows only, in this order:
//
// 1. RAFIKICODE_FORCE_TUI=1 starts the interface whatever the console is.
// 2. Virtual terminal processing is turned on for the output handle, the way
//    Microsoft documents it (GetConsoleMode, then SetConsoleMode with
//    ENABLE_VIRTUAL_TERMINAL_PROCESSING). A console that refuses it (Windows
//    before 10 version 1511, or the "Use legacy console" option) cannot
//    interpret a single escape sequence, so nothing can be drawn.
// 3. The console window is read: a terminal that hosts the program through a
//    pseudo console (Windows Terminal, VS Code, WezTerm, Alacritty, the OpenSSH
//    server) gives it an invisible "PseudoConsoleWindow"; winpty (mintty in Git
//    Bash) and ConEmu keep a hidden "ConsoleWindowClass" window and draw their
//    own. Only a visible "ConsoleWindowClass" window is the classic console host
//    the user is looking at, and that is refused, unless ConEmu says it is
//    drawing over it.
// 4. Everything else starts, including every case where the probe itself
//    fails: when in doubt the interface starts, as it always has.
//
// Environment variables alone decide nothing: WT_SESSION and TERM_PROGRAM are
// inherited by every process started from Windows Terminal or VS Code,
// including a classic console window opened from there with
// `start powershell`, so they say where a parent ran, not what this window is.
import { dlopen, ptr } from "bun:ffi"

export const FORCE = "RAFIKICODE_FORCE_TUI"
// Test only: replaces the probe with a fixed answer, so the refusal can be
// driven end to end on a machine that is not in that state (Linux, Wine).
export const TEST = "RAFIKICODE_TEST_CONSOLE"

export const CLASSIC_WINDOW = "ConsoleWindowClass"
export const PSEUDO_WINDOW = "PseudoConsoleWindow"

export interface Window {
  className: string
  visible: boolean
}

// What the Windows calls report. Every member may be undefined when the call
// is not possible (no console attached, output redirected, the library would
// not load); undefined never leads to a refusal.
export interface Probe {
  // Turns virtual terminal processing on for the output handle. true when the
  // mode now carries the flag, false when the console refused it, undefined
  // when the output is not a console handle at all.
  enableVirtualTerminal(): boolean | undefined
  // The console window, or undefined when there is none.
  window(): Window | undefined
}

export type Reason = "no_virtual_terminal" | "classic_console"

export type Verdict =
  | { ok: true; host: string }
  | { ok: false; reason: Reason; host: string }

type Env = Record<string, string | undefined>

export function decide(env: Env, probe: Probe): Verdict {
  if (env[FORCE] === "1") return { ok: true, host: `not checked, ${FORCE}=1` }

  const vt = safely(() => probe.enableVirtualTerminal())
  if (vt === false)
    return {
      ok: false,
      reason: "no_virtual_terminal",
      host: "a console that refuses virtual terminal processing",
    }

  const window = safely(() => probe.window())
  if (!window) return { ok: true, host: vt ? "a console with no window of its own" : "no console attached" }
  if (window.className === PSEUDO_WINDOW) return { ok: true, host: "a pseudo console (Windows Terminal or another modern terminal)" }
  if (window.className === CLASSIC_WINDOW && !window.visible)
    return { ok: true, host: "a hidden console drawn by another terminal (Git Bash, ConEmu or similar)" }
  if (window.className === CLASSIC_WINDOW) {
    if (env["ConEmuANSI"] === "ON") return { ok: true, host: "ConEmu" }
    return { ok: false, reason: "classic_console", host: "the classic Windows console host (conhost.exe)" }
  }
  return { ok: true, host: `a console window of class ${window.className}` }
}

function safely<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

const STD_OUTPUT_HANDLE = -11
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004

// The real Windows calls. Loaded on first use only, and only on Windows.
export function windowsProbe(): Probe {
  const kernel = dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
    GetConsoleWindow: { args: [], returns: "ptr" },
  })
  const user = dlopen("user32.dll", {
    GetClassNameW: { args: ["ptr", "ptr", "i32"], returns: "i32" },
    IsWindowVisible: { args: ["ptr"], returns: "i32" },
  })
  return {
    enableVirtualTerminal() {
      const handle = kernel.symbols.GetStdHandle(STD_OUTPUT_HANDLE)
      // INVALID_HANDLE_VALUE comes back as -1 or as the all ones pointer.
      if (!handle || handle === -1 || handle === 0xffffffffffffffff) return undefined
      const mode = new Uint32Array(1)
      if (kernel.symbols.GetConsoleMode(handle, ptr(mode)) === 0) return undefined
      if (mode[0]! & ENABLE_VIRTUAL_TERMINAL_PROCESSING) return true
      if (kernel.symbols.SetConsoleMode(handle, mode[0]! | ENABLE_VIRTUAL_TERMINAL_PROCESSING) === 0) return false
      if (kernel.symbols.GetConsoleMode(handle, ptr(mode)) === 0) return undefined
      return (mode[0]! & ENABLE_VIRTUAL_TERMINAL_PROCESSING) !== 0
    },
    window() {
      const hwnd = kernel.symbols.GetConsoleWindow()
      if (!hwnd) return undefined
      const name = new Uint16Array(64)
      const length = user.symbols.GetClassNameW(hwnd, ptr(name), name.length)
      if (length <= 0) return undefined
      return {
        className: String.fromCharCode(...name.subarray(0, length)),
        visible: user.symbols.IsWindowVisible(hwnd) !== 0,
      }
    },
  }
}

// A probe that answers as a given console would, for RAFIKICODE_TEST_CONSOLE.
export function fixedProbe(kind: string): Probe | undefined {
  if (kind === "legacy") return { enableVirtualTerminal: () => false, window: () => undefined }
  if (kind === "conhost")
    return { enableVirtualTerminal: () => true, window: () => ({ className: CLASSIC_WINDOW, visible: true }) }
  if (kind === "terminal")
    return { enableVirtualTerminal: () => true, window: () => ({ className: PSEUDO_WINDOW, visible: false }) }
  return undefined
}

// The verdict for this process, or undefined where the question does not
// arise (any platform but Windows, unless the test switch asks for it).
export function check(env: Env = process.env, platform: string = process.platform): Verdict | undefined {
  const fixed = env[TEST] ? fixedProbe(env[TEST]!) : undefined
  if (fixed) return decide(env, fixed)
  if (platform !== "win32") return undefined
  const probe = safely(windowsProbe)
  if (!probe) return { ok: true, host: "not checked, the console functions could not be loaded" }
  return decide(env, probe)
}
