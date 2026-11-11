// A gateway that drops packets instead of refusing them (a firewall, a captive
// Wi-Fi portal, a dead route) used to keep `rafikicode run` silent for about
// 4.5 minutes: the operating system waits about 130 s for a TCP connection
// that never opens, and the request is tried twice. A refused connection is
// reported in seconds; a dropped one should be too.
//
// Until the gateway has answered once in this process, every request to the
// Rafiki gateway is watched: a plain TCP connection to the gateway's host and
// port is opened next to it, and when that connection does not open within
// the wait (10 s by default), the request is given up with a connection error,
// which reports "Cannot reach the model gateway" and exits with the network
// code like a refused connection. Once the gateway has answered, the watch is
// off: a drop in the middle of a task is the retry window's job
// (rafiki/resilience.ts), and a slow model answer is never cut by this.
//
// Not watched: requests that go through a proxy (HTTPS_PROXY, HTTP_PROXY,
// ALL_PROXY), where a direct connection may be refused on purpose although
// the proxy works; and requests to other providers.
//
// RAFIKICODE_CONNECT_WAIT sets the wait in seconds; 0 turns the watch off.
import net from "net"
import { hasAnswered } from "./resilience"

export const WAIT_ENV = "RAFIKICODE_CONNECT_WAIT"
export const DEFAULT_WAIT_MS = 10_000
const MAX_WAIT_MS = 300_000
const PROXY_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]

export function waitMs(env: Record<string, string | undefined> = process.env) {
  const raw = env[WAIT_ENV]?.trim()
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return DEFAULT_WAIT_MS
  return Math.min(Math.round(Number(raw) * 1000), MAX_WAIT_MS)
}

export function proxied(env: Record<string, string | undefined> = process.env) {
  return PROXY_ENV.some((name) => (env[name] ?? "").trim() !== "")
}

// "open": the TCP connection opened. "silent": nothing answered within the
// wait. "error": refused, unresolvable or reset, which the request itself
// reports in seconds, so the watch leaves it to the request.
export type ProbeResult = "open" | "silent" | "error"
export type Probe = (host: string, port: number, ms: number) => Promise<ProbeResult>

export const tcpProbe: Probe = (host, port, ms) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (result: ProbeResult) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => done("silent"), ms)
    socket.once("connect", () => done("open"))
    socket.once("error", () => done("error"))
  })

// The error the request fails with: a network error the AI SDK turns into
// "Cannot connect to API: ...", which rafiki/gateway-errors.ts reports as an
// unreachable gateway.
export function silentError(host: string, ms: number) {
  const seconds = Math.round(ms / 1000)
  const error = new Error(`Unable to connect: ${host} did not answer within ${seconds} s`) as Error & { code: string }
  error.code = "ETIMEDOUT"
  return error
}

function target(input: unknown): { host: string; port: number } | undefined {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
    const url = new URL(raw)
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
    return { host: url.hostname.replace(/^\[|\]$/g, ""), port }
  } catch {
    return undefined
  }
}

type Fetch = (input: any, init?: any) => Promise<Response>

export function wrap(
  fetchFn: Fetch,
  options: {
    probe?: Probe
    answered?: () => boolean
    env?: Record<string, string | undefined>
  } = {},
): Fetch {
  const probe = options.probe ?? tcpProbe
  const answered = options.answered ?? hasAnswered
  const env = options.env ?? process.env
  return (input, init) => {
    const ms = waitMs(env)
    const to = target(input)
    if (ms <= 0 || answered() || proxied(env) || !to) return fetchFn(input, init)
    const own = new AbortController()
    const signal = init?.signal ? AbortSignal.any([init.signal, own.signal]) : own.signal
    const request = fetchFn(input, { ...init, signal })
    return new Promise<Response>((resolve, reject) => {
      let done = false
      request.then(
        (response) => {
          if (done) return
          done = true
          resolve(response)
        },
        (error) => {
          if (done) return
          done = true
          reject(error)
        },
      )
      probe(to.host, to.port, ms).then(
        (result) => {
          if (result !== "silent" || done) return
          // Settled first, so the abort error of the request below is not the one reported.
          done = true
          reject(silentError(to.host, ms))
          own.abort()
        },
        () => {},
      )
    })
  }
}
