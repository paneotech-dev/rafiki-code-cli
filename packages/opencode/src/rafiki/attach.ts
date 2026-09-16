// rafikicode run --attach <url>: a run against a server started with
// rafikicode serve.
//
// preflight() asks the server one cheap question before a session is made, so
// a wrong or missing password says so (exit 2) and an address nobody answers
// on says so (exit 4), instead of the misleading "Session not found".
//
// whenConnected() resolves once the event stream of the server has answered
// (its first event is server.connected), so the prompt is only sent when the
// run is already listening for the answer. The stream is wrapped, not read:
// the run's own loop still sees every event.
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Serve from "@opencode-ai/core/brand/serve"
import { EXIT } from "./contract"

export type Preflight = { ok: true } | { ok: false; message: string; exitCode: number }

function endpoint(url: string, route: string) {
  return url.replace(/\/+$/, "") + route
}

export async function check(url: string, headers?: Record<string, string>, fetcher: typeof fetch = fetch): Promise<Preflight> {
  const response = await fetcher(endpoint(url, "/path"), { headers, signal: AbortSignal.timeout(15_000) }).catch(() => undefined)
  if (!response) {
    return {
      ok: false,
      exitCode: EXIT.network,
      message: `Cannot reach a ${Brand.name} server at ${url}. Start one with ${Brand.name} serve, or check the address and port.`,
    }
  }
  await response.body?.cancel().catch(() => {})
  if (response.status === 401) {
    return {
      ok: false,
      exitCode: EXIT.usage,
      message: headers?.Authorization
        ? `The ${Brand.name} server at ${url} refused the password. Check --password or ${Serve.passwordEnv} (the user name is ${Serve.username()}, or --username).`
        : `The ${Brand.name} server at ${url} needs a password. Pass --password, or set ${Serve.passwordEnv} to the password the server was started with.`,
    }
  }
  return { ok: true }
}

// Prints the problem and exits, like the rest of run does for a bad start.
export async function preflight(url: string, headers?: Record<string, string>) {
  const result = await check(url, headers)
  if (result.ok) return
  process.stderr.write(`Error: ${result.message}\n`)
  process.exit(result.exitCode)
}

export function whenConnected<T>(events: { stream: AsyncGenerator<T, any, any> }, timeoutMs = 15_000): Promise<void> {
  const source = events.stream
  let done: () => void = () => {}
  const connected = new Promise<void>((resolve) => {
    done = resolve
  })
  const timer = setTimeout(() => done(), timeoutMs)
  async function* wrapped() {
    try {
      for await (const event of source) {
        done()
        yield event
      }
    } finally {
      done()
    }
  }
  events.stream = wrapped() as AsyncGenerator<T, any, any>
  return connected.finally(() => clearTimeout(timer))
}
