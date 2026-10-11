// Permission modes: how tool calls are approved.
//
//   ask   asks whenever the permission rules say "ask" (the behaviour before modes)
//   auto  asks only for the guarded actions (guarded.ts); everything else runs
//   plan  read-only: edits and commands that change things are refused with a note
//
// Where the mode comes from, first match wins:
//   1. this process was started for it: `rafikicode run --auto`
//   2. a mode picked in the interface (Shift+Tab) since this process started
//   3. RAFIKICODE_PERMISSION_MODE
//   4. the mode last picked in the interface for this project
//   5. "permission": { "mode": "..." } in the config
//   6. ask
//
// The interface keeps the last pick per project in the state folder
// (<state>/permission-mode.json, keyed by the project folder), never in the
// project, so nothing about it is committed. Only the interface and the
// server it starts read it (useSavedChoice); `rafikicode run`, serve and the
// editor integration do not.
import fs from "fs"
import path from "path"
import { Global } from "../global"

export const MODES = ["ask", "auto", "plan"] as const
export type Mode = (typeof MODES)[number]
export const ENV = "RAFIKICODE_PERMISSION_MODE"

const started = Date.now()
let override: Mode | undefined
let saved = false

export function parse(value: unknown): Mode | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim().toLowerCase()
  return (MODES as readonly string[]).includes(text) ? (text as Mode) : undefined
}

export function next(mode: Mode): Mode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length]
}

export function label(mode: Mode) {
  return mode === "ask" ? "Ask" : mode === "auto" ? "Auto" : "Plan"
}

// The mode of this whole process (`rafikicode run --auto`), or undefined to clear it.
export function setOverride(mode: Mode | undefined) {
  override = mode
}

// Lets this process read the mode picked in the interface.
export function useSavedChoice(value = true) {
  saved = value
}

export function file() {
  return path.join(Global.Path.state, "permission-mode.json")
}

export function key(directory: string) {
  try {
    return fs.realpathSync.native(path.resolve(directory))
  } catch {
    return path.resolve(directory)
  }
}

interface Entry {
  mode: Mode
  at: number
}

let cache: { mtime: number; size: number; data: Record<string, Entry> } | undefined

function readAll(target = file()): Record<string, Entry> {
  try {
    const stat = fs.statSync(target)
    if (cache && cache.mtime === stat.mtimeMs && cache.size === stat.size) return cache.data
    const raw = JSON.parse(fs.readFileSync(target, "utf8"))
    const data: Record<string, Entry> = {}
    if (raw && typeof raw === "object") {
      for (const [dir, value] of Object.entries(raw as Record<string, unknown>)) {
        const entry = value as { mode?: unknown; at?: unknown }
        const mode = parse(entry?.mode)
        if (mode) data[dir] = { mode, at: typeof entry.at === "number" ? entry.at : 0 }
      }
    }
    cache = { mtime: stat.mtimeMs, size: stat.size, data }
    return data
  } catch {
    return {}
  }
}

// The mode last picked in the interface for this project, with when.
export function savedChoice(directory: string): Entry | undefined {
  return readAll()[key(directory)]
}

// Keeps the pick for this project.
export function save(directory: string, mode: Mode, at = Date.now()) {
  const target = file()
  const data = { ...readAll(target), [key(directory)]: { mode, at } }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + "\n")
  fs.renameSync(temp, target)
  cache = undefined
}

export interface Resolved {
  mode: Mode
  source: "run" | "interface" | "env" | "saved" | "config" | "default"
}

// The mode in force for a project folder. `config` is the permission config
// ({ mode, ... } or a bare action string).
export function resolve(input: {
  directory: string
  config?: unknown
  env?: Record<string, string | undefined>
  saved?: boolean
  since?: number
}): Resolved {
  if (override) return { mode: override, source: "run" }
  const choice = (input.saved ?? saved) ? savedChoice(input.directory) : undefined
  if (choice && choice.at >= (input.since ?? started)) return { mode: choice.mode, source: "interface" }
  const env = parse((input.env ?? process.env)[ENV])
  if (env) return { mode: env, source: "env" }
  if (choice) return { mode: choice.mode, source: "saved" }
  const config = parse(fromConfig(input.config).mode)
  if (config) return { mode: config, source: "config" }
  return { mode: "ask", source: "default" }
}

// The mode settings in a permission config: { mode, auto_check }.
export function fromConfig(permission: unknown): { mode?: Mode; autoCheck: boolean } {
  if (!permission || typeof permission !== "object") return { autoCheck: true }
  const record = permission as Record<string, unknown>
  return { mode: parse(record.mode), autoCheck: record.auto_check !== false }
}

// Config keys under "permission" that are settings, not rules.
export const SETTINGS = new Set(["mode", "auto_check"])
