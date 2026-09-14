// The local HTTP server of rafikicode serve, web, acp and the terminal
// interface's --port or --hostname option. It answers with the merged
// configuration, which carries the stored Rafiki key, and runs tools, so a
// server that other machines can reach must have a password
// (OPENCODE_SERVER_PASSWORD, sent as basic auth).
//
// check() refuses any address other than this machine without a password,
// and warns when a loopback server has none (any local program can still
// reach it).
//
// listenerGuard() runs in front of every request a listener answers:
//   Host    only loopback names, the configured hostname (the listen address),
//           this machine's own addresses when listening on every address, and
//           the mDNS name when mDNS is on. A web page that rebinds its own DNS
//           name to 127.0.0.1 still sends that name as Host and is refused.
//   Origin  only the server's own origin and the origins given with --cors or
//           server.cors. Any other Origin is refused with 403 and gets no CORS
//           headers (the upstream allowance for opencode.ai subdomains,
//           localhost ports and desktop shells never reaches a listener).
//   Secrets the configuration and provider routes are answered with provider
//           keys, the Rafiki key, tokens and passwords replaced by REDACTED.
// The in process server of the terminal interface has no listen options and
// is not guarded: no browser can reach it.
import os from "os"
import { Effect } from "effect"
import { Headers, HttpBody, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Brand } from "./brand"
import { secretEnvName } from "./guard"

export const passwordEnv = "OPENCODE_SERVER_PASSWORD"
// The contract's usage exit code: the command line asked for something refused.
export const EXIT_REFUSED = 2

// True for addresses that only this machine can reach: 127.0.0.0/8, ::1,
// localhost. Everything else, including 0.0.0.0, :: and an empty host, is not.
export function loopback(hostname: string) {
  const host = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1")
  if (host === "localhost" || host === "::1") return true
  const parts = host.split(".")
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export function check(input: { hostname: string; password?: string }): { refuse?: string; warn?: string } {
  if (input.password) return {}
  if (!loopback(input.hostname)) {
    return {
      refuse: `Refusing to listen on ${input.hostname || "every address"} without a password: the ${Brand.name} server answers with your configuration, including the ${Brand.product} key, and runs tools. Set ${passwordEnv}, or listen on 127.0.0.1.`,
    }
  }
  return {
    warn: `Warning: ${passwordEnv} is not set, so the server on ${input.hostname} has no password. Any program on this machine can use it and read the ${Brand.product} key.`,
  }
}

// Prints the refusal or the warning to stderr. True when the command must
// stop (exit code EXIT_REFUSED is set).
export function refused(input: { hostname: string }, write: (line: string) => void = (line) => process.stderr.write(line + "\n")) {
  const result = check({ hostname: input.hostname, password: process.env[passwordEnv] })
  if (result.refuse) {
    write(result.refuse)
    process.exitCode = EXIT_REFUSED
    return true
  }
  if (result.warn) write(result.warn)
  return false
}

// The listen options a listener passes to its routes (Server.listen).
export interface ListenOptions {
  readonly hostname?: string
  readonly cors?: ReadonlyArray<string>
  readonly mdns?: boolean
  readonly mdnsDomain?: string
}

function normalHost(value: string) {
  return value.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "")
}

function wildcard(hostname: string) {
  return hostname === "" || hostname === "0.0.0.0" || hostname === "::"
}

// The host name of a Host header without its port, or undefined when the
// header is not a plain name, an IPv4 address or a bracketed IPv6 address.
export function hostOf(header: string | undefined) {
  if (!header) return undefined
  const value = header.trim().toLowerCase()
  let host: string
  if (value.startsWith("[")) {
    const match = /^\[([0-9a-f:.]+)\](:\d{1,5})?$/.exec(value)
    if (!match) return undefined
    host = match[1]
  } else {
    const match = /^([a-z0-9.-]+)(:\d{1,5})?$/.exec(value)
    if (!match) return undefined
    host = match[1]
  }
  host = host.replace(/\.$/, "")
  return host || undefined
}

// The addresses of this machine's network interfaces (for a listener on every address).
export function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flatMap((list) => list ?? [])
    .map((entry) => normalHost(entry.address))
}

export function hostAllowed(header: string | undefined, options: ListenOptions, addresses: () => string[] = localAddresses) {
  const host = hostOf(header)
  if (!host) return false
  if (loopback(host)) return true
  const configured = normalHost(options.hostname ?? "")
  if (configured && host === configured) return true
  if (options.mdns && options.mdnsDomain && host === normalHost(options.mdnsDomain)) return true
  if (wildcard(configured)) return addresses().includes(host)
  return false
}

// An Origin is allowed when absent (not a browser), listed with --cors or
// server.cors, or the server's own origin: the scheme and host the browser
// used, which is the Host header already checked by hostAllowed.
export function originAllowed(origin: string | undefined, host: string | undefined, options: ListenOptions) {
  if (origin === undefined) return true
  if (options.cors?.includes(origin)) return true
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  if (url.origin !== origin) return false
  return Boolean(host) && url.host === host!.trim().toLowerCase()
}

export const REDACTED = "[redacted]"

// Property names that hold a secret: any word secret, password, token,
// authorization, cookie, credential or bearer, or key after api, access,
// private, secret, auth, client or session, or the bare name key.
// Names are split on case changes and on anything that is not a letter or digit.
const SECRET_WORDS = new Set([
  "secret",
  "secrets",
  "password",
  "passwd",
  "passphrase",
  "token",
  "authorization",
  "auth",
  "cookie",
  "credential",
  "credentials",
  "bearer",
  "apikey",
  "privatekey",
])
const KEY_PREFIX = new Set(["api", "access", "private", "secret", "auth", "client", "session"])

export function secretKeyName(name: string) {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (words.some((word) => SECRET_WORDS.has(word))) return true
  if (words.length === 1 && words[0] === "key") return true
  return words.some((word, index) => word === "key" && index > 0 && KEY_PREFIX.has(words[index - 1]))
}

function storedKey() {
  try {
    return Brand.credential()?.key
  } catch {
    return undefined
  }
}

// Secret values this process knows: the values of secret named environment
// variables (the Rafiki key and the server password included) and the stored
// Rafiki key. Short values are ignored so that common words are never replaced.
export function knownSecrets(env: Record<string, string | undefined> = process.env, stored: string | undefined = storedKey()) {
  const values = new Set<string>()
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && (secretEnvName(name) || name === passwordEnv)) values.add(value)
  }
  if (stored && stored.length >= 8) values.add(stored)
  return [...values]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function secretValue(value: string, secrets: string[]) {
  return secrets.some((secret) => value === secret || (secret.length >= 16 && value.includes(secret)))
}

// A copy of a JSON value with secret strings replaced by REDACTED: strings
// under a secret property name, and strings that equal or contain a known secret.
export function redact(value: unknown, secrets: string[] = knownSecrets()): unknown {
  if (typeof value === "string") return value && secretValue(value, secrets) ? REDACTED : value
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets))
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [
      name,
      typeof item === "string" && item !== "" && secretKeyName(name) ? REDACTED : redact(item, secrets),
    ]),
  )
}

function holdsRedacted(value: unknown): boolean {
  if (value === REDACTED) return true
  if (Array.isArray(value)) return value.some(holdsRedacted)
  if (isRecord(value)) return Object.values(value).some(holdsRedacted)
  return false
}

// A config update without the values a client saves back from a redacted
// answer: a REDACTED string is dropped, and so is an array holding one, so
// the stored secret stays as it is.
export function withoutRedacted<T>(value: T): T {
  if (!isRecord(value)) return value
  const entries = Object.entries(value).flatMap(([name, item]): [string, unknown][] => {
    if (item === REDACTED) return []
    if (Array.isArray(item)) return holdsRedacted(item) ? [] : [[name, item]]
    return [[name, withoutRedacted(item)]]
  })
  return Object.fromEntries(entries) as T
}

// Routes that answer with configuration or provider data.
const REDACTED_ROUTES = [/^\/config$/, /^\/config\/providers$/, /^\/global\/config$/, /^\/provider$/, /^\/api\/provider(\/[^/]+)?$/]

export function redactsRoute(url: string) {
  const pathname = (url.split("?")[0] ?? "").replace(/\/+$/, "") || "/"
  return REDACTED_ROUTES.some((route) => route.test(pathname))
}

function refuse(status: number, message: string) {
  return HttpServerResponse.text(message + "\n", { status })
}

function redactResponse(response: HttpServerResponse.HttpServerResponse) {
  const body = response.body
  if (body._tag === "Empty") return response
  // A body this guard cannot read is not sent: it may hold a secret.
  if (body._tag !== "Uint8Array" || response.headers["content-encoding"]) {
    return refuse(500, `${Brand.name} server: the answer could not be checked for secrets, so it was not sent.`)
  }
  if (!/json/i.test(body.contentType)) return response
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(body.body))
  } catch {
    return refuse(500, `${Brand.name} server: the answer could not be checked for secrets, so it was not sent.`)
  }
  const encoded = new TextEncoder().encode(JSON.stringify(redact(parsed)))
  return HttpServerResponse.setBody(response, HttpBody.uint8Array(encoded, body.contentType))
}

type Middleware = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest>

// Wraps the server's CORS middleware (`next`) with the Host, Origin and
// redaction rules. Without listen options (the in process server) it is `next`.
export function listenerGuard(options: ListenOptions | undefined, next: Middleware): Middleware {
  if (!options || options.hostname === undefined) return next
  return <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const host = request.headers["host"]
      if (!hostAllowed(host, options)) {
        return refuse(403, `${Brand.name} server: refused a request for a host name that is not this server.`)
      }
      if (!originAllowed(request.headers["origin"], host, options)) {
        return refuse(403, `${Brand.name} server: refused a cross origin request. Allow an origin with --cors.`)
      }
      if (!redactsRoute(request.url)) return yield* next(app)
      // Ask the inner layers for an uncompressed answer so it can be redacted.
      const plain = request.modify({ headers: Headers.remove(request.headers, "accept-encoding") })
      const response = yield* next(app).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, plain))
      return redactResponse(response)
    }) as Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest>
}
