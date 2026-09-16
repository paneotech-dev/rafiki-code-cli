// How a Rafiki Code terminal is started: the terminal interface with a local
// control server on a loopback port, protected by a password made for that
// terminal only, so no other program on the machine can drive it.
import { modelFor, type TierSetting } from "./tier"

export const LOOPBACK = "127.0.0.1"
export const SERVER_USER = "rafikicode"
export const PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD"
export const USER_ENV = "OPENCODE_SERVER_USERNAME"
export const HEALTH_PATH = "/global/health"
export const APPEND_PATH = "/tui/append-prompt"

export interface Session {
  port: number
  password: string
}

export function tuiArgs(port: number, tier: TierSetting) {
  const args = ["--hostname", LOOPBACK, "--port", String(port)]
  const model = modelFor(tier)
  if (model) {
    args.push("--model", model)
  }
  return args
}

export function terminalEnv(session: Session): Record<string, string> {
  return {
    [PASSWORD_ENV]: session.password,
    [USER_ENV]: SERVER_USER,
  }
}

export function authorization(session: Session) {
  return `Basic ${Buffer.from(`${SERVER_USER}:${session.password}`).toString("base64")}`
}

export function url(session: Session, route: string) {
  return `http://${LOOPBACK}:${session.port}${route}`
}

export function loginArgs(label: string) {
  return ["login", "--label", label]
}

// The device label shown on the Console approval page and key list.
export function deviceLabel(extensionVersion: string, host: string) {
  return `Rafiki Code for VS Code ${extensionVersion} on ${host}`.slice(0, 120)
}

type Fetch = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>

// Waits until the terminal interface answers its health route. Every attempt
// has its own timeout: a request that reaches the server while it is still
// starting is accepted but never answered (seen with rafikicode 0.1.2), so an
// attempt without a timeout would wait forever.
export async function waitReady(
  session: Session,
  fetcher: Fetch,
  opts: { timeoutMs?: number; attemptMs?: number; delayMs?: number } = {},
) {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000)
  const attempt = opts.attemptMs ?? 1_000
  const delay = opts.delayMs ?? 200
  while (Date.now() < deadline) {
    try {
      const response = await fetcher(url(session, HEALTH_PATH), {
        headers: { Authorization: authorization(session) },
        signal: AbortSignal.timeout(attempt),
      })
      if (response.ok) {
        return true
      }
    } catch {
      // Not listening yet, or the attempt timed out.
    }
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  return false
}

export async function appendPrompt(session: Session, text: string, fetcher: Fetch, timeoutMs = 5_000) {
  const response = await fetcher(url(session, APPEND_PATH), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authorization(session) },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return response.ok
}
