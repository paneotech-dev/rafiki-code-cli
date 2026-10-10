// Opening a conversation or a project of another folder from the History
// panel of the terminal interface. The interface runs in one folder, so the
// panel records what to open (core/brand/history.ts) and closes; once it has
// closed, the command that started it starts the same program again in that
// folder, with --session for a conversation, and exits with its status. Same
// shape as the restart in rafiki/exec-tmp.ts.
import { spawnSync } from "child_process"
import path from "path"
import * as History from "@opencode-ai/core/brand/history"
import * as ExecTmp from "./exec-tmp"

// The command line for the program started again: the binary itself, or the
// runtime and the entry file in a run from source.
// A run from source starts from the package folder, where the runtime finds
// its settings; the folder to open is passed as an argument either way.
export function command(value: History.Reopen, argv: readonly string[] = process.argv, execPath = process.execPath) {
  const args = History.reopenArgs(value)
  if (ExecTmp.compiled(argv)) return { file: execPath, args, cwd: value.directory }
  const entry = argv[1] ?? ""
  return { file: execPath, args: [entry, ...args], cwd: path.dirname(path.dirname(entry)) }
}

// Called after the interface has closed. Returns without doing anything when
// nothing was asked for.
export function reopen(input: { spawn?: typeof spawnSync; exit?: (code: number) => never } = {}) {
  const value = History.takeReopen()
  if (!value) return
  const { file, args, cwd } = command(value)
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {})
  const run = (input.spawn ?? spawnSync)(file, args, { stdio: "inherit", cwd, env: process.env })
  if (run.error) return
  ;(input.exit ?? process.exit)(run.status ?? 1)
}
