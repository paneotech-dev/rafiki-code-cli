// rafikicode run stopped from outside: a time limit (timeout sends SIGTERM),
// a supervisor, or Ctrl-c. Without a handler the process died on the spot,
// with the turn in progress never closed, and a wrapper that exported the
// session afterwards found it incomplete or missing. With one, the turn is
// stopped the way the interface stops it (the session is aborted, so the open
// message and its tool calls are closed and written to storage), one line
// says where the session is, and the process exits with its own code: 143 for
// SIGTERM and 130 for SIGINT (128 plus the signal number, as a shell reports
// them), so a caller can tell a stopped run from a failed one (1). The Task: line
// is printed too, marked partial, with the key's spend as the gateway reports
// it. A second signal, or a stop that takes longer than the grace period,
// exits at once with the same code.
import { Brand } from "@opencode-ai/core/brand/brand"

export const EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const
export type StopSignal = keyof typeof EXIT_CODES

// Long enough to stop the turn and read the key's spend for the Task: line.
export const GRACE_MS = 10_000

export function line(signal: StopSignal, sessionID: string) {
  return `Stopped by ${signal}. The session is saved: ${Brand.name} export ${sessionID}`
}

export function install(input: {
  sessionID: string
  // Stops the turn and waits until it is written.
  stop: () => Promise<unknown>
  // Called at once when the first signal arrives.
  onSignal?: (signal: StopSignal) => void
  // Runs once the turn is stopped, before the line and the exit: the Task: line.
  after?: (signal: StopSignal) => Promise<unknown>
  write?: (text: string) => void
  exit?: (code: number) => void
  graceMs?: number
}) {
  const write = input.write ?? ((text: string) => process.stderr.write(text + "\n"))
  const exit = input.exit ?? ((code: number) => process.exit(code))
  let stopping = false
  const handlers = (Object.keys(EXIT_CODES) as StopSignal[]).map((signal) => {
    const handler = () => {
      const code = EXIT_CODES[signal]
      if (stopping) return exit(code)
      stopping = true
      input.onSignal?.(signal)
      const timer = setTimeout(() => exit(code), input.graceMs ?? GRACE_MS)
      void input
        .stop()
        .catch(() => undefined)
        .then(() => input.after?.(signal))
        .catch(() => undefined)
        .then(() => {
          clearTimeout(timer)
          write(line(signal, input.sessionID))
          exit(code)
        })
    }
    process.on(signal, handler)
    return [signal, handler] as const
  })
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
}
