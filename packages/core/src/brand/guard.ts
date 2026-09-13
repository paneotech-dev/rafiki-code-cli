// Keeps the Rafiki key on the Rafiki gateway. The key spends a prepaid wallet,
// and rafikicode is meant to be run inside any repository, so configuration
// found in a project (rafikicode.json, opencode.json, .rafikicode/, .opencode/)
// is not trusted with it:
//
// 1. projectConfig() removes, with a one line warning naming the file, every
//    project setting that could move the rafiki provider (base URL, headers,
//    key source, SDK package) or hand the key to another provider or server.
// 2. trust() records the gateway origins that trusted sources chose: the
//    user's ~/.rafikicode/config.json, explicit config env vars, managed config.
// 3. request() runs where provider requests are sent and refuses any request
//    that carries the key to an origin other than the gateway, whatever put
//    the key there.
//
// The gateway itself only changes through RAFIKICODE_GATEWAY_URL, the URL the
// Console returned at login, or user level config.
import fs from "fs"
import path from "path"
import { Brand } from "./brand"
import * as Credentials from "./credentials"

type Json = Record<string, unknown>

// Settings a project may still set on the rafiki provider: model visibility
// and timeouts. Everything else under provider.rafiki is ignored.
const providerAllowed = new Set(["name", "whitelist", "blacklist", "models", "options"])
const optionsAllowed = new Set(["timeout", "chunkTimeout", "headerTimeout"])
const modelDenied = new Set(["headers", "provider"])

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Set by tests to capture the warning instead of writing to stderr.
let warn: (message: string) => void = (message) => process.stderr.write(message + "\n")
export function setWarn(fn: (message: string) => void) {
  const previous = warn
  warn = fn
  return previous
}

const warnedSources = new Set<string>()
export function resetWarnings() {
  warnedSources.clear()
}

// Every Rafiki key value this process could send: the env var and the stored
// login. The stored file is read raw here, without the permission checks, so
// that even a refused file's key is never sent anywhere else.
export function keys() {
  const found = new Set<string>()
  const env = process.env[Brand.env.apiKey]
  if (env) found.add(env)
  try {
    const raw = JSON.parse(fs.readFileSync(Credentials.file(Brand.configDir()), "utf8"))
    if (raw && typeof raw.key === "string" && raw.key.length >= 8) found.add(raw.key)
  } catch {
    // No stored login, or not readable: nothing to protect from it.
  }
  return [...found]
}

function origin(url: unknown) {
  if (typeof url !== "string" || !url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

const trusted = new Set<string>()

// The origins the key may be sent to: the gateway the brand resolves (env
// override, login, default) plus any base URL a trusted source configured.
export function gatewayOrigins() {
  const result = new Set(trusted)
  let gateway: string | undefined
  try {
    gateway = Brand.gatewayURL()
  } catch {
    // An unsafe credential file: fall back to the default gateway.
    gateway = Brand.gateway.url
  }
  const resolved = origin(gateway)
  if (resolved) result.add(resolved)
  return result
}

// Records the rafiki base URL chosen by a trusted configuration source.
export function trust<T>(data: T): T {
  if (!isRecord(data) || !isRecord(data.provider)) return data
  const rafiki = data.provider[Brand.provider.id]
  if (!isRecord(rafiki) || !isRecord(rafiki.options)) return data
  const resolved = origin(rafiki.options.baseURL)
  if (resolved) trusted.add(resolved)
  return data
}

export function resetTrust() {
  trusted.clear()
}

// A project directory is any .rafikicode/ or .opencode/ found from the working
// directory upwards, except the user's own ones: the global config directory,
// the ones directly under the home directory, and OPENCODE_CONFIG_DIR.
export function isProjectDir(dir: string, input: { config: string; home: string; configDir?: string }) {
  if (path.resolve(dir) === path.resolve(input.config)) return false
  if (input.configDir && path.resolve(dir) === path.resolve(input.configDir)) return false
  if (path.resolve(path.dirname(dir)) === path.resolve(input.home)) return false
  return true
}

const envReference = new RegExp(`\\$\\{\\s*${Brand.env.apiKey}\\s*\\}|\\{env:\\s*${Brand.env.apiKey}\\s*\\}`)

// Removes the unsafe settings from one project config file and warns once per
// file. Returns the same object, changed in place.
export function projectConfig<T>(source: string, data: T): T {
  if (!isRecord(data)) return data
  const ignored: string[] = []
  const secrets = keys()

  const providers = data.provider
  if (isRecord(providers)) {
    const rafiki = providers[Brand.provider.id]
    if (isRecord(rafiki)) {
      for (const field of Object.keys(rafiki)) {
        if (providerAllowed.has(field)) continue
        ignored.push(`provider.${Brand.provider.id}.${field}`)
        delete rafiki[field]
      }
      if (rafiki.options !== undefined && !isRecord(rafiki.options)) {
        ignored.push(`provider.${Brand.provider.id}.options`)
        delete rafiki.options
      }
      if (isRecord(rafiki.options)) {
        for (const field of Object.keys(rafiki.options)) {
          if (optionsAllowed.has(field)) continue
          ignored.push(`provider.${Brand.provider.id}.options.${field}`)
          delete rafiki.options[field]
        }
      }
      if (isRecord(rafiki.models)) {
        for (const [id, model] of Object.entries(rafiki.models)) {
          if (!isRecord(model)) continue
          for (const field of Object.keys(model)) {
            if (!modelDenied.has(field)) continue
            ignored.push(`provider.${Brand.provider.id}.models.${id}.${field}`)
            delete model[field]
          }
        }
      }
    }
    // Another provider may not take its key from the Rafiki key variable.
    for (const [id, provider] of Object.entries(providers)) {
      if (!isRecord(provider) || !Array.isArray(provider.env)) continue
      if (!provider.env.includes(Brand.env.apiKey)) continue
      ignored.push(`provider.${id}.env`)
      delete provider.env
    }
  }

  // Anywhere else (another provider's options, MCP headers, environments):
  // a value that holds the key, from {env:...} or {file:...} substitution, or
  // a ${RAFIKICODE_API_KEY} placeholder resolved later.
  const scrub = (value: unknown, at: string) => {
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        if (leaks(value[i])) {
          ignored.push(`${at}[${i}]`)
          value.splice(i, 1)
        } else scrub(value[i], `${at}[${i}]`)
      }
      return
    }
    if (!isRecord(value)) return
    for (const [field, inner] of Object.entries(value)) {
      const next = at ? `${at}.${field}` : field
      if (leaks(inner)) {
        ignored.push(next)
        delete value[field]
      } else scrub(inner, next)
    }
  }
  const leaks = (value: unknown) =>
    typeof value === "string" && (envReference.test(value) || secrets.some((secret) => value.includes(secret)))
  scrub(data, "")

  if (ignored.length && !warnedSources.has(source)) {
    warnedSources.add(source)
    warn(
      `Warning: ignored ${ignored.join(", ")} in ${source}: project config cannot change the ${Brand.product} gateway, its headers or its key. Set ${Brand.env.gatewayURL} or edit ${Brand.configHint} instead.`,
    )
  }
  return data
}

export class KeyLeakError extends Error {
  override readonly name = "RafikiKeyLeakError"
  constructor(readonly origin: string) {
    super(
      `Refused to send the ${Brand.product} key to ${origin}: it is only sent to the ${Brand.product} gateway. Check the provider settings in the project config.`,
    )
  }
}

function headerValues(headers: unknown): string[] {
  if (!headers) return []
  if (headers instanceof Headers) return [...headers.values()]
  if (Array.isArray(headers)) return headers.flatMap((pair) => (Array.isArray(pair) ? pair.map(String) : []))
  if (isRecord(headers)) return Object.values(headers).flatMap((v) => (v === undefined || v === null ? [] : [String(v)]))
  return []
}

// True when the key may go to url along with these values.
export function allowed(url: string, values: readonly unknown[]) {
  const secrets = keys()
  if (!secrets.length) return true
  const carries = values.some((value) => typeof value === "string" && secrets.some((secret) => value.includes(secret)))
  if (!carries && !secrets.some((secret) => url.includes(secret))) return true
  const resolved = origin(url)
  return Boolean(resolved && gatewayOrigins().has(resolved))
}

// Called with the arguments of every provider fetch. Throws KeyLeakError when
// the request carries a Rafiki key to anywhere but the gateway.
export function request(input: unknown, init?: { headers?: unknown; body?: unknown }) {
  const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input)
  const values = [
    ...(input instanceof Request ? headerValues(input.headers) : []),
    ...headerValues(init?.headers),
    ...(typeof init?.body === "string" ? [init.body] : []),
  ]
  if (allowed(url, values)) return
  throw new KeyLeakError(origin(url) ?? "an address that is not a web URL")
}
