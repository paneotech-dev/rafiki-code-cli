// Keeps the Rafiki key on the Rafiki gateway, and keeps untrusted workspaces
// from running code or reading secrets through configuration. The key spends
// a prepaid wallet, and rafikicode is meant to be run inside any repository,
// so configuration found in a project (rafikicode.json, opencode.json,
// .rafikicode/, .opencode/) is not trusted with it:
//
// 1. projectConfig() removes, with a one line warning naming the file:
//    - unless the workspace is trusted (brand/trust.ts), every setting that
//      could move the rafiki provider (base URL, headers, key source, SDK
//      package); even in a trusted workspace request() below keeps the key on
//      the gateway;
//    - always, any value holding the key and any env list lending it;
//    - when project code may not load, plugin entries and provider packages
//      outside the bundled @ai-sdk scope;
//    - in a headless run of an untrusted workspace, local MCP, formatter and
//      language server commands and any permission that allows the shell.
// 2. substitution() limits {env:} and {file:} in untrusted project files.
// 3. trust() records the gateway origins that trusted sources chose: the
//    user's ~/.rafikicode/config.json, explicit config env vars, managed config.
// 4. request() runs where provider requests are sent and refuses any request
//    that carries the key to an origin other than the gateway, whatever put
//    the key there.
//
// The gateway itself only changes through RAFIKICODE_GATEWAY_URL, the URL the
// Console returned at login, or user level config.
import fs from "fs"
import path from "path"
import { Brand } from "./brand"
import * as Credentials from "./credentials"
import * as Trust from "./trust"

type Json = Record<string, unknown>

// Settings a project may still set on the rafiki provider: model visibility
// and timeouts. Everything else under provider.rafiki is ignored.
const providerAllowed = new Set(["name", "whitelist", "blacklist", "models", "options"])
const optionsAllowed = new Set(["timeout", "chunkTimeout", "headerTimeout"])
const modelDenied = new Set(["headers", "provider"])
// Model settings that change what a tier bills while its name stays the same:
// the model id sent to the gateway, request options and variants merged into
// the body, and the output limit.
const modelSpend = new Set(["id", "options", "variants", "limit"])
// Request body fields an untrusted project may not set through agent or mode
// options, compared without case, "_" or "-": they pick another model, raise
// the token limit or the number of answers, or change gateway routing.
const bodyDenied = new Set([
  "model",
  "models",
  "maxtokens",
  "maxcompletiontokens",
  "maxoutputtokens",
  "n",
  "apibase",
  "baseurl",
  "apikey",
  "apiversion",
  "fallbacks",
  "metadata",
  "user",
  "extrabody",
  "extraheaders",
  "headers",
  "mockresponse",
  "customllmprovider",
  "litellmparams",
])
// Provider SDK packages an untrusted project may still name: the AI SDK's own
// scope, which nobody but its maintainers can publish to. Anything else
// (another package, a file:// path) is code chosen by the repository.
const bundledPackage = /^@ai-sdk\/[a-z0-9][a-z0-9._-]*$/
// Environment variable names an untrusted project may not read.
const secretName = /KEY|TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL|PRIVATE/i

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Set by tests to capture the warning instead of writing to stderr.
export function setWarn(fn: (message: string) => void) {
  return Trust.setWarn(fn)
}

export function resetWarnings() {
  Trust.resetWarnings()
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
  const baseURL = rafiki.options.baseURL
  const resolved = origin(baseURL)
  // Plain http leaves this machine unencrypted: never a place for the key.
  if (resolved && typeof baseURL === "string" && Brand.gatewayAllowed(baseURL)) trusted.add(resolved)
  return data
}

export function resetTrust() {
  trusted.clear()
}

// A project directory is any .rafikicode/ or .opencode/ found from the working
// directory upwards (including ~/.opencode), except the user's own config
// directory (config, normally ~/.rafikicode) and OPENCODE_CONFIG_DIR. The home
// based config directory counts as a project one when it sits inside a git
// checkout (HOME set to the checkout), since its content came with the code.
export function isProjectDir(dir: string, input: { config: string; configDir?: string; home?: string }) {
  const target = Trust.real(dir)
  if (input.configDir && target === Trust.real(input.configDir)) return false
  if (target !== Trust.real(input.config)) return true
  return target === Trust.real(Brand.configDir()) && Trust.homeConfigInCheckout()
}

const envReference = new RegExp(`\\$\\{\\s*${Brand.env.apiKey}\\s*\\}|\\{env:\\s*${Brand.env.apiKey}\\s*\\}`)

// Removes the entries of a permission config that allow the shell: a bare
// "allow" for every tool, and allow rules under bash or "*".
function shellAllows(value: unknown, at: string, ignored: string[]): unknown {
  if (value === "allow") {
    ignored.push(at)
    return undefined
  }
  if (!isRecord(value)) return value
  for (const key of ["bash", "*"]) {
    const rule = value[key]
    if (rule === "allow") {
      ignored.push(`${at}.${key}`)
      delete value[key]
    } else if (isRecord(rule)) {
      for (const [pattern, action] of Object.entries(rule)) {
        if (action !== "allow") continue
        ignored.push(`${at}.${key}.${pattern}`)
        delete rule[pattern]
      }
    }
  }
  return value
}

// Removes request body fields from agent or mode options (bodyDenied).
function agentOptions(agents: unknown, at: string, ignored: string[]) {
  if (!isRecord(agents)) return
  for (const [name, agent] of Object.entries(agents)) {
    if (!isRecord(agent) || !isRecord(agent.options)) continue
    for (const field of Object.keys(agent.options)) {
      if (!bodyDenied.has(field.toLowerCase().replace(/[_-]/g, ""))) continue
      ignored.push(`${at}.${name}.options.${field}`)
      delete agent.options[field]
    }
  }
}

function spendWarning(source: string, spend: string[]) {
  if (!spend.length) return
  Trust.warnOnce(
    `spend:${source}`,
    `Warning: ignored ${spend.join(", ")} in ${source}: project config cannot change which model a ${Brand.product} tier calls, its request fields or its output limit, unless the workspace is trusted.`,
  )
}

function agentPermissions(agents: unknown, at: string, ignored: string[]) {
  if (!isRecord(agents)) return
  for (const [name, agent] of Object.entries(agents)) {
    if (!isRecord(agent) || agent.permission === undefined) continue
    const next = shellAllows(agent.permission, `${at}.${name}.permission`, ignored)
    if (next === undefined) delete agent.permission
    else agent.permission = next
  }
}

// Removes the unsafe settings from one project config file and warns once per
// file. Returns the same object, changed in place. where is the directory whose
// trust decides (default: the file's directory).
export function projectConfig<T>(source: string, data: T, where = path.dirname(source)): T {
  if (!isRecord(data)) return data
  const trustedWorkspace = Trust.isTrusted(where)
  const headless = Trust.headless()
  const codeAllowed = Trust.allowsCode({ trusted: trustedWorkspace, headless })
  const ignored: string[] = []
  const code: string[] = []
  const programs: string[] = []
  const spend: string[] = []
  const secrets = keys()

  const providers = data.provider
  if (isRecord(providers)) {
    const rafiki = providers[Brand.provider.id]
    if (isRecord(rafiki) && !trustedWorkspace) {
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
            if (modelSpend.has(field)) spend.push(`provider.${Brand.provider.id}.models.${id}.${field}`)
            else if (modelDenied.has(field)) ignored.push(`provider.${Brand.provider.id}.models.${id}.${field}`)
            else continue
            delete model[field]
          }
        }
      }
    }
    if (!trustedWorkspace) {
      agentOptions(data.agent, "agent", spend)
      agentOptions(data.mode, "mode", spend)
    }
    for (const [id, provider] of Object.entries(providers)) {
      if (!isRecord(provider)) continue
      // Another provider may not take its key from the Rafiki key variable.
      if (Array.isArray(provider.env) && provider.env.includes(Brand.env.apiKey)) {
        ignored.push(`provider.${id}.env`)
        delete provider.env
      }
      if (codeAllowed) continue
      // A provider package is imported into this process: code from the repository.
      if (typeof provider.npm === "string" && !bundledPackage.test(provider.npm)) {
        code.push(`provider.${id}.npm`)
        delete provider.npm
      }
      if (isRecord(provider.models)) {
        for (const [modelID, model] of Object.entries(provider.models)) {
          if (!isRecord(model) || !isRecord(model.provider)) continue
          if (typeof model.provider.npm !== "string" || bundledPackage.test(model.provider.npm)) continue
          code.push(`provider.${id}.models.${modelID}.provider.npm`)
          delete model.provider.npm
        }
      }
    }
  }

  if (!codeAllowed && Array.isArray(data.plugin) && data.plugin.length) {
    code.push("plugin")
    delete data.plugin
  }

  // Nobody can review what a headless run starts, so an untrusted workspace
  // declares no programs and cannot open the shell.
  if (headless && !trustedWorkspace) {
    if (isRecord(data.mcp)) {
      for (const [name, entry] of Object.entries(data.mcp)) {
        if (!isRecord(entry) || entry.type !== "local") continue
        programs.push(`mcp.${name}`)
        delete data.mcp[name]
      }
    }
    for (const kind of ["formatter", "lsp"] as const) {
      const entries = data[kind]
      if (!isRecord(entries)) continue
      for (const [name, entry] of Object.entries(entries)) {
        if (!isRecord(entry) || entry.command === undefined) continue
        programs.push(`${kind}.${name}`)
        delete entries[name]
      }
    }
    const record: Json = data
    if (record.permission !== undefined) {
      const next = shellAllows(record.permission, "permission", programs)
      if (next === undefined) delete record.permission
      else record.permission = next
    }
    agentPermissions(data.agent, "agent", programs)
    agentPermissions(data.mode, "mode", programs)
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

  if (ignored.length) {
    Trust.warnOnce(
      `key:${source}`,
      `Warning: ignored ${ignored.join(", ")} in ${source}: project config cannot change the ${Brand.product} gateway, its headers or its key. Set ${Brand.env.gatewayURL} or edit ${Brand.configHint} instead.`,
    )
  }
  spendWarning(source, spend)
  if (code.length) {
    Trust.warnOnce(`code:${source}`, `Warning: ignored ${code.join(", ")} in ${source}: project config cannot load code because ${Trust.untrustedHint(where)}.`)
  }
  if (programs.length) {
    Trust.warnOnce(
      `headless:${source}`,
      `Warning: ignored ${programs.join(", ")} in ${source}: a headless run starts no programs and allows no shell commands from an untrusted workspace; ${Trust.untrustedHint(where)}.`,
    )
  }
  return data
}

// The merged global config when the home config directory sits inside a git
// checkout: its files came with the repository, so they are treated like
// project config, while the built in gateway provider defaults (merged into
// the same object) are put back afterwards.
export function checkoutHomeConfig<T>(source: string, data: T): T {
  const defaults = (Brand.config() as Json).provider
  const brand = isRecord(defaults) && isRecord(defaults[Brand.provider.id]) ? (defaults[Brand.provider.id] as Json) : undefined
  // Drop the values that are exactly the built in defaults first, so the
  // warning names only what the checkout changed.
  const current = isRecord(data) && isRecord(data.provider) ? data.provider[Brand.provider.id] : undefined
  if (brand && isRecord(current)) {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    for (const field of ["npm", "env"]) if (same(current[field], brand[field])) delete current[field]
    if (isRecord(current.options) && isRecord(brand.options)) {
      for (const field of Object.keys(brand.options)) if (same(current.options[field], brand.options[field])) delete current.options[field]
    }
  }
  projectConfig(source, data, path.dirname(source))
  if (!isRecord(data) || !brand) return data
  const providers: Json = isRecord(data.provider) ? data.provider : {}
  const rafiki: Json = isRecord(providers[Brand.provider.id]) ? (providers[Brand.provider.id] as Json) : {}
  for (const field of ["name", "npm", "env"]) if (brand[field] !== undefined) rafiki[field] = brand[field]
  rafiki.options = { ...(isRecord(rafiki.options) ? rafiki.options : {}), ...(isRecord(brand.options) ? brand.options : {}) }
  if (!isRecord(rafiki.models)) rafiki.models = brand.models
  providers[Brand.provider.id] = rafiki
  ;(data as Json).provider = providers
  return data
}

// Agents and modes loaded from Markdown files in a project directory: in an
// untrusted workspace their options cannot set request body fields, and in a
// headless run they cannot allow the shell.
export function projectAgents<T>(dir: string, project: boolean, agents: T): T {
  if (!project || Trust.isTrusted(dir)) return agents
  const spend: string[] = []
  agentOptions(agents, "agent", spend)
  spendWarning(dir, spend)
  if (!Trust.headless()) return agents
  const ignored: string[] = []
  agentPermissions(agents, "agent", ignored)
  if (ignored.length) {
    Trust.warnOnce(
      `agents:${dir}`,
      `Warning: ignored ${ignored.join(", ")} from ${dir}: a headless run allows no shell commands from an untrusted workspace; ${Trust.untrustedHint(dir)}.`,
    )
  }
  return agents
}

export function secretEnvName(name: string) {
  const trimmed = name.trim()
  return trimmed === Brand.env.apiKey || secretName.test(trimmed)
}

export interface Substitution {
  env(name: string): boolean
  file(resolved: string): boolean
  refused(token: string): void
}

// The project root for substitution: the worktree the instance resolved (the
// file system root means no git), else the git root above the directory, else
// the directory; without a context, the git root above the file.
function projectRoot(where: string, ctx?: { directory: string; worktree?: string }) {
  if (!ctx) return Trust.gitRoot(where) ?? where
  if (ctx.worktree === undefined) return Trust.gitRoot(ctx.directory) ?? ctx.directory
  return ctx.worktree && ctx.worktree !== path.parse(ctx.worktree).root ? ctx.worktree : ctx.directory
}

// The limits on {env:} and {file:} for one project config file, or undefined
// when its workspace is trusted. Refused references become empty strings.
export function substitution(source: string, ctx?: { directory: string; worktree?: string }): Substitution | undefined {
  const where = path.dirname(source)
  if (Trust.isTrusted(where)) return undefined
  const root = Trust.real(projectRoot(where, ctx))
  return {
    env: (name) => !secretEnvName(name),
    file: (resolved) => Trust.inside(root, Trust.real(resolved)),
    refused: (token) =>
      Trust.warnOnce(
        `substitution:${source}:${token}`,
        `Warning: ignored ${token} in ${source}: project config cannot read secret environment variables or files outside ${root}; ${Trust.untrustedHint(where)}.`,
      ),
  }
}

// The limits for any config file of any kind (config.json, opencode.json,
// rafikicode.json, tui.json and their jsonc forms) by the directory it was
// found in: the user's own config directory and OPENCODE_CONFIG_DIR keep full
// substitution; every other directory (a project, ~/.opencode, or the home
// config directory when it came with a git checkout) is limited unless
// trusted. Files named explicitly (OPENCODE_CONFIG, OPENCODE_TUI_CONFIG,
// OPENCODE_CONFIG_CONTENT) are not passed here.
export function fileSubstitution(source: string, ctx?: { directory: string; worktree?: string }): Substitution | undefined {
  if (Trust.isUserConfigDir(path.dirname(source))) return undefined
  return substitution(source, ctx)
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

// The text of a request body that can be read without consuming it: strings,
// bytes, URL encoded and multipart form values. A stream or Blob body cannot
// be read here; provider SDKs send JSON strings.
function bodyValues(body: unknown): string[] {
  if (typeof body === "string") return [body]
  if (body instanceof URLSearchParams) return [body.toString()]
  const decoder = new TextDecoder()
  if (body instanceof ArrayBuffer) return [decoder.decode(body)]
  if (ArrayBuffer.isView(body)) return [decoder.decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))]
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return [...body.values()].filter((value): value is string => typeof value === "string")
  }
  return []
}

// Called with the arguments of every provider fetch. Throws KeyLeakError when
// the request carries a Rafiki key to anywhere but the gateway.
export function request(input: unknown, init?: { headers?: unknown; body?: unknown }) {
  const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input)
  const values = [
    ...(input instanceof Request ? headerValues(input.headers) : []),
    ...headerValues(init?.headers),
    ...bodyValues(init?.body),
  ]
  if (allowed(url, values)) return
  throw new KeyLeakError(origin(url) ?? "an address that is not a web URL")
}
