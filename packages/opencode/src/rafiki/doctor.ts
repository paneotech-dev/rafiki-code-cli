// rafikicode doctor: the checks behind the command, one result line each.
// Plain async code with an injectable fetch, clock and environment so the
// tests drive it against the mock gateway and mock Console; the command in
// cmd.ts only prints. Nothing here ever returns or prints a key value.
import fs from "fs"
import path from "path"
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Credentials from "@opencode-ai/core/brand/credentials"
import * as Trust from "@opencode-ai/core/brand/trust"
import { which } from "@opencode-ai/core/util/which"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import * as Contract from "./contract"

// warn: worth knowing, but it does not stop runs and does not fail doctor.
export type Status = "ok" | "warn" | "fail" | "skip"

export interface Line {
  // Short check name, printed in the first column.
  name: string
  status: Status
  // What was found, numbers and paths only.
  detail: string
  // One sentence telling the person what to do; on a failure or a warning.
  fix?: string
  // On a warning: what it means for the person, printed on its own line.
  note?: string
  // True when the failure is the contract's network class (exit code 4).
  network?: boolean
}

export interface Env {
  readonly [key: string]: string | undefined
}

export interface Options {
  env?: Env
  fetch?: typeof fetch
  configDir?: string
  gatewayURL?: string
  consoleURL?: string
  timeoutMs?: number
  execPath?: string
  version?: string
  channel?: string
  now?: () => number
  // The working directory the project checks look at; the process cwd by default.
  cwd?: string
  // What the shell resolves the command to; the real `which` by default.
  which?: (command: string) => string | null
  // Schema validation for config files, loaded from the config decoder by
  // default (loadValidate). Injected by the tests.
  validate?: Validate
}

export const NAMES = ["config", "project", "trust", "credential", "gateway", "key", "tiers", "console", "path", "version"] as const

// Time budget for each network call; a doctor run must never hang.
export const DEFAULT_TIMEOUT_MS = 8000

const ok = (name: string, detail: string): Line => ({ name, status: "ok", detail })
const fail = (name: string, detail: string, fix: string): Line => ({ name, status: "fail", detail, fix })
const warn = (name: string, detail: string, fix: string, note: string): Line => ({ name, status: "warn", detail, fix, note })
const skip = (name: string, detail: string): Line => ({ name, status: "skip", detail })
const unreachable = (name: string, detail: string, fix: string): Line => ({ ...fail(name, detail, fix), network: true })

// The gateway base URL the provider uses ends in /v1; the health and key
// endpoints live at the root.
export function gatewayRoot(url: string) {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "")
}

function keysPage(consoleURL: string) {
  return consoleURL + Contract.PATH.keysPage
}

function detailOf(cause: unknown) {
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError" || cause.name === "AbortError") return "timed out"
    const inner = (cause as { cause?: unknown }).cause
    const code = inner && typeof inner === "object" && "code" in inner ? String((inner as { code: unknown }).code) : undefined
    return code ?? cause.message
  }
  return String(cause)
}

/*
 * Why a call did not arrive, in the user's terms rather than the kernel's.
 *
 * Two things were wrong with `... unreachable (getaddrinfo ETIMEOUT host)` and
 * `Check the network.`
 *
 * The parenthetical was an errno. It is the right thing to put in a log and the
 * wrong thing to put in a sentence addressed to someone who has to decide what
 * to do next, and detailOf still produces it for everything this cannot place.
 *
 * And `Check the network.` was the fix for three conditions that need three
 * different things from the user: no network at all (reconnect), a network that
 * opens the connection and never answers - a wifi portal, a proxy, a corporate
 * firewall (sign in, or set HTTPS_PROXY), and the far end being down (wait;
 * there is nothing to check). Checking the network is the right advice for at
 * most one of them, and for the third it sends someone hunting a fault that is
 * not theirs.
 *
 * The taxonomy below is the one wp/2.18-offline-start wrote as
 * Offline.classify() in rafiki/offline.ts, kept here rather than imported: that
 * module is not on this release line, and its 379 lines are mostly a TCP
 * reachability probe wired into the provider's error path, which a doctor run
 * has no use for and a release branch should not acquire for a message fix.
 * Its describe() does not fit here either - the steps it writes end by telling
 * the reader to run `doctor`, and its override clause reads process.env, where
 * every check in this file takes env as an argument so a test can set it. When
 * that branch lands, this collapses into one call to Offline.classify() and the
 * four strings below; nothing else here changes.
 */
type Reach = "offline" | "blocked" | "unreachable"

// No name resolution, no route, no interface: nothing of this machine's works,
// so no URL and no key is at fault. EHOSTUNREACH belongs here and not below:
// "no route to host" is this machine's routing table having nothing to say.
const OFFLINE = [
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "EAI_FAIL",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EHOSTUNREACH",
]
// The connection went out and was never answered, or was answered by something
// that is not the host asked for. DEFAULT_TIMEOUT_MS running out lands here
// too, by the "timed out" text below: these are liveliness and account
// endpoints, so eight seconds of silence from one is not a slow answer, and the
// one thing a timeout rules out is having no network, which is the only
// condition `Check the network.` was advice for.
const BLOCKED = [
  "ETIMEDOUT",
  "ETIMEOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
]
// Something at that address said no, which means the address was reached.
// "ConnectionRefused" is Bun's own name for it: measured, `fetch` to a closed
// port throws a TypeError with that code and no errno anywhere in the chain,
// so the ECONNREFUSED spelling alone never matches in practice.
const DOWN = ["ECONNREFUSED", "ConnectionRefused", "ECONNRESET", "ECONNABORTED", "EPIPE", "EPROTO", "ERR_SOCKET_CLOSED"]

// The errno-style code a connection failure carries, wherever in the cause
// chain it sits. Classification only; it is never printed.
function codeOf(cause: unknown, depth = 0): string | undefined {
  if (!cause || typeof cause !== "object" || depth > 5) return undefined
  const record = cause as { code?: unknown; cause?: unknown }
  if (typeof record.code === "string" && record.code) return record.code
  return codeOf(record.cause, depth + 1)
}

// Every message down the chain, joined. The whole text is needed and not
// detailOf's reduced form: a resolver that never answers reports ETIMEDOUT,
// which on a socket means a blocked connection but here means no DNS at all,
// and the only thing that tells the two apart is the call named in the text
// ("getaddrinfo ETIMEOUT gateway.rafikiai.io").
function messageOf(cause: unknown, depth = 0): string {
  // A thrown string is text in its own right. Anything else that is not an
  // object carries no words to match on, and falls through to detailOf.
  if (typeof cause === "string") return cause
  if (!cause || typeof cause !== "object" || depth > 5) return ""
  const record = cause as { message?: unknown; cause?: unknown }
  const own = typeof record.message === "string" ? record.message : ""
  return [own, messageOf(record.cause, depth + 1)].filter(Boolean).join(" ")
}

// Undefined when the failure names no condition here, so the caller keeps the
// wording it has rather than guessing one of three answers.
function classify(cause: unknown): Reach | undefined {
  const text = messageOf(cause).toLowerCase()
  // Tested before the code, for the reason messageOf gives.
  if (text.includes("getaddrinfo") || text.includes("could not resolve") || text.includes("dns lookup"))
    return "offline"
  const code = codeOf(cause)
  if (code) {
    if (OFFLINE.includes(code)) return "offline"
    if (BLOCKED.includes(code)) return "blocked"
    if (DOWN.includes(code)) return "unreachable"
  }
  if (!text) return undefined
  for (const name of OFFLINE) if (text.includes(name.toLowerCase())) return "offline"
  for (const name of BLOCKED) if (text.includes(name.toLowerCase())) return "blocked"
  if (text.includes("timed out") || text.includes("timeout") || text.includes("certificate")) return "blocked"
  for (const name of DOWN) if (text.includes(name.toLowerCase())) return "unreachable"
  if (text.includes("connection refused") || text.includes("connection reset")) return "unreachable"
  // Bun's and the AI SDK's wording for a connection that never opened, with no
  // code of any kind behind it. Neither can tell the three apart, so neither
  // can this: "unreachable" is the honest reading, and its fix does not send
  // anyone to check a URL. Bun appends its own guess, "Is the computer able to
  // access the url?", which is dropped with the rest of the raw text.
  if (text.includes("unable to connect") || text.includes("cannot connect to api")) return "unreachable"
  return undefined
}

const REACH: Record<Reach, { detail: string; fix: (subject: string, override: string) => string }> = {
  offline: {
    detail: "no network connection from this machine",
    // No override clause: with no network at all the address is not what went
    // wrong, and sending the one user who cannot look anything up to check a
    // URL they never typed is the whole of what was wrong with this message.
    fix: () => "Reconnect to a network and run the command again. Nothing is wrong with the address or with your key.",
  },
  blocked: {
    detail: "the connection went out and nothing came back",
    fix: (subject, override) =>
      `Something between this machine and ${subject} is holding the connection open without answering: a wifi sign in page, a proxy, or a firewall. Open any page in a browser to see whether a network wants you to sign in, and behind a proxy set HTTPS_PROXY.${override}`,
  },
  unreachable: {
    detail: "the address refused the connection",
    fix: (subject, override) =>
      `This machine's network is working, so ${subject} is down or restarting. Try again shortly.${override}`,
  },
}

// The line for a call that never reached its host. `overrideVar` is the name of
// the URL override when the user set one: their own setting is the first thing
// worth checking, and they are the only person who can.
function networkLine(
  name: string,
  subject: string,
  url: string,
  cause: unknown,
  overrideVar: string | undefined,
): Line {
  const reach = classify(cause)
  const known = reach ? REACH[reach] : undefined
  if (!known) {
    const clause = overrideVar ? `, and ${overrideVar} which is set` : ""
    return unreachable(name, `${url} unreachable (${detailOf(cause)})`, `Check the network${clause}.`)
  }
  const sentence = overrideVar ? ` ${overrideVar} is set, so check its value first.` : ""
  return unreachable(name, `${url} unreachable (${known.detail})`, known.fix(subject, sentence))
}

// Money for the terminal: at most four decimals, no trailing zeros.
export function money(value: unknown) {
  const n = Number(value)
  if (!Number.isFinite(n)) return "?"
  return n.toFixed(4).replace(/\.?0+$/, "")
}

async function request(f: typeof fetch, url: string, init: RequestInit, timeoutMs: number) {
  return f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
}

async function body(response: Response): Promise<any> {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return undefined
  }
}

// Schema check for one config file, with the decoder the loader itself uses, so
// doctor accepts exactly what a session accepts. Returns the problems, or
// undefined when the file decodes.
export type Validate = (data: unknown, source: string) => string[] | undefined

// Loaded lazily: doctor must not drag the config layer graph into every command
// that imports this module, and a run where the import fails still reports every
// other check rather than nothing.
export async function loadValidate(): Promise<Validate | undefined> {
  try {
    const [{ ConfigParse }, { ConfigV2Compat }, { ConfigV1 }] = await Promise.all([
      import("@/config/parse"),
      import("@/config/v2-compat"),
      import("@opencode-ai/core/v1/config/config"),
    ])
    return (data, source) => {
      try {
        ConfigParse.schema(ConfigV1.Info, ConfigV2Compat.lower(ConfigParse.normalizeLoaded(data), source).value, source)
        return undefined
      } catch (cause) {
        return ConfigParse.issuesOf(cause) ?? [detailOf(cause)]
      }
    }
  } catch {
    return undefined
  }
}

// What a config file is worth reporting, read once: a problem the session would
// hard-fail on, or the model it selects.
interface Inspected {
  // Present when the file cannot be used as it stands.
  problem?: { detail: string; fix: string }
  model?: string
}

// How to get a broken config file out of the way, for the check whose file it is.
// The global file is recreated with defaults; a project file is the repository's,
// so the escape hatch is the switch that skips it.
const RECREATED = "it is recreated with defaults on the next run."
const SKIPPED = `or set ${Brand.env.disableProjectConfig}=1 to start without project configuration for one run.`

// The loader substitutes {env:...} and {file:...} before decoding and this does
// not; both only ever produce strings, so a file that decodes here decodes there.
export function inspect(file: string, validate?: Validate, project = false): Inspected | undefined {
  if (!fs.existsSync(file)) return undefined
  const aside = project ? SKIPPED : `or move the file aside; ${RECREATED}`
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (cause) {
    return {
      problem: {
        detail: `${file} cannot be read (${detailOf(cause)})`,
        fix: project
          ? `Make the file readable by your user, ${SKIPPED}`
          : `Make the file readable by your user, or move it aside; ${RECREATED}`,
      },
    }
  }
  const errors: ParseError[] = []
  const data = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    const first = errors[0]!
    const line = text.slice(0, first.offset).split("\n").length
    return {
      problem: {
        detail: `${file} is not valid JSON (${printParseErrorCode(first.error)} at line ${line})`,
        fix: `Fix the syntax, ${aside}`,
      },
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { problem: { detail: `${file} does not contain a JSON object`, fix: "Replace the contents with an object, for example {}." } }
  }
  const issues = validate?.(data, file)
  if (issues?.length) {
    return {
      problem: {
        detail: `${file} does not match the configuration schema (${issues.slice(0, 3).join("; ")}${issues.length > 3 ? `; and ${issues.length - 3} more` : ""})`,
        fix: `Fix the fields named above against ${Brand.schema.config}, ${aside}`,
      },
    }
  }
  return { model: typeof data.model === "string" ? data.model : undefined }
}

export function checkConfig(dir: string, validate?: Validate): Line {
  const file = path.join(dir, Brand.configFile)
  const found = inspect(file, validate)
  if (!found) return ok("config", `${file} not created yet, built in defaults apply`)
  if (found.problem) return fail("config", found.problem.detail, found.problem.fix)
  const note = found.model ? ` (model ${found.model})` : ""
  if (found.model && !found.model.startsWith(`${Brand.provider.id}/`)) {
    return ok("config", `${file}${note}, a model outside the ${Brand.provider.name} gateway is not metered on your Rafiki AI account`)
  }
  return ok("config", `${file}${note}`)
}

// Every project config file a session started in dir would load, in the order
// the loader merges them: outermost first, so the last entry wins. Mirrors
// config/paths.ts (files walked up to the worktree root, plus the project
// directories), and stops where a session stops, at the git root.
export function projectFiles(dir: string): string[] {
  if (Brand.project.configDisabled()) return []
  const start = path.resolve(dir)
  const stop = Trust.gitRoot(start)
  const found: string[] = []
  let current = start
  while (true) {
    for (const base of Brand.project.fileNames) {
      for (const file of [`${base}.jsonc`, `${base}.json`]) {
        const candidate = path.join(current, file)
        if (fs.existsSync(candidate)) found.push(candidate)
      }
    }
    for (const name of Brand.project.dirs) {
      for (const file of Brand.project.files) {
        const candidate = path.join(current, name, file)
        if (fs.existsSync(candidate)) found.push(candidate)
      }
    }
    if (current === stop) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return found.reverse()
}

// The project config a session started here would load. The global file is
// checked by checkConfig; this is the one a repository carries, which the
// session-start failure it causes never names as ours.
export function checkProject(files: string[], validate?: Validate, disabled = Brand.project.configDisabled()): Line {
  if (disabled) return skip("project", `${Brand.env.disableProjectConfig} is set, nothing is loaded from the working tree`)
  if (files.length === 0) return ok("project", "no project configuration in this directory or above it")
  const inspected = files.map((file) => inspect(file, validate, true))
  const broken = inspected.find((found) => found?.problem)
  if (broken?.problem) return fail("project", broken.problem.detail, broken.problem.fix)
  // The loader merges in order, so the last file that names a model wins.
  const model = inspected.map((found) => found?.model).findLast((m) => m !== undefined)
  return ok("project", `${files.join(", ")}${model ? ` (model ${model})` : ""}`)
}

export interface CredentialResult {
  line: Line
  // Present only when a usable credential exists; never printed.
  key?: string
  source?: "environment" | "stored"
  stored?: Credentials.StoredCredential
}

export function checkCredential(env: Env, dir: string, consoleURL: string, now: number): CredentialResult {
  const envKey = env[Brand.env.apiKey]
  const file = Credentials.file(dir)
  let stored: Credentials.StoredCredential | undefined
  let unsafe: Credentials.UnsafeCredentialError | undefined
  try {
    stored = Credentials.read(dir)
  } catch (cause) {
    if (!(cause instanceof Credentials.UnsafeCredentialError)) throw cause
    unsafe = cause
  }
  if (envKey) {
    const extra = unsafe
      ? `; the stored sign-in at ${file} is not used because the file ${unsafe.reason}`
      : stored
        ? `; the stored sign-in at ${file} is ignored while it is set`
        : ""
    return { line: ok("credential", `${Brand.env.apiKey} from the environment${extra}`), key: envKey, source: "environment" }
  }
  if (unsafe) {
    return {
      line: fail("credential", `stored sign-in at ${file} refused: the file ${unsafe.reason}`, `Run: ${unsafe.fix}. Or set ${Brand.env.apiKey}.`),
    }
  }
  if (!stored) {
    return {
      line: fail("credential", "none", `Run ${Brand.name} login, or set ${Brand.env.apiKey} on servers and in CI.`),
    }
  }
  if (env["CI"]) {
    return {
      line: fail(
        "credential",
        `stored sign-in at ${file}, refused because CI is set`,
        `Create a server key at ${keysPage(consoleURL)} and set ${Brand.env.apiKey}.`,
      ),
      stored,
    }
  }
  const alias = stored.key_alias ?? "(no alias)"
  const kind = stored.kind ?? "session"
  if (stored.expires_at) {
    const expires = Date.parse(stored.expires_at)
    if (!Number.isNaN(expires) && expires <= now) {
      return {
        line: fail("credential", `stored sign-in at ${file} expired on ${stored.expires_at}`, `Run ${Brand.name} login.`),
        stored,
      }
    }
  }
  const expiry = stored.expires_at ? `, expires ${stored.expires_at}` : ", no expiry recorded"
  return {
    line: ok("credential", `stored ${kind} sign-in at ${file}, key ${alias}${expiry}`),
    key: stored.key,
    source: "stored",
    stored,
  }
}

export async function checkGateway(root: string, f: typeof fetch, timeoutMs: number, env: Env, now: () => number): Promise<Line> {
  const url = root + "/health/liveliness"
  const started = now()
  try {
    const response = await request(f, url, { headers: { accept: "application/json" } }, timeoutMs)
    const elapsed = now() - started
    if (response.ok) return ok("gateway", `${root} answered in ${elapsed} ms`)
    return fail("gateway", `${url} answered ${response.status}`, "The gateway is up but not healthy. Try again shortly.")
  } catch (cause) {
    return networkLine("gateway", "the gateway", root, cause, env[Brand.env.gatewayURL] ? Brand.env.gatewayURL : undefined)
  }
}

export interface KeyInfo {
  key_alias?: string | null
  spend?: number | null
  max_budget?: number | null
  expires?: string | null
  models?: string[] | null
  metadata?: Record<string, unknown> | null
}

export interface KeyResult {
  line: Line
  info?: KeyInfo
}

// True when the gateway answered the key check with the key's details and the
// key has not expired: the gateway still accepts it, whatever the Console says.
export function gatewayAccepts(result: KeyResult, now: number) {
  if (!result.info) return false
  const at = result.info.expires ? Date.parse(result.info.expires) : NaN
  return Number.isNaN(at) || at > now
}

// For a key the gateway accepts while the Console answers 401: minted directly
// at the gateway, not revoked.
export function notRegistered(consoleURL: string) {
  return `This key is valid at the gateway but not registered in the Rafiki AI console (it was created outside the console). Create a key at ${keysPage(consoleURL)}, or run ${Brand.name} login.`
}

// What such a key means in practice: runs work, the Console cannot show it.
export function notRegisteredMeaning(consoleURL: string) {
  return `Usage still works and is metered at the gateway. The credit balance and key management of the Rafiki AI console do not apply to this key; create a key at ${keysPage(consoleURL)} to get them.`
}

// Key types by gateway alias. Keys made for Rafiki Code (sign-in keys, and
// Rafiki AI console keys with the Rafiki Code option) are rafikicode-<uuid>;
// general console keys are rafiki-<uuid> and carry no Rafiki Code metadata.
const CODE_ALIAS = /^rafikicode-/i
const CONSOLE_ALIAS = /^rafiki-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE_METADATA = ["rafiki_surface", "rafiki_key_kind"]

export type KeyType = "code" | "other" | "unknown"

// "other" only on positive evidence: a console alias and no Rafiki Code
// metadata. A missing alias or an alias of another shape stays "unknown", so
// a key minted some other way never raises a false alarm.
export function keyType(info: KeyInfo): KeyType {
  const alias = typeof info.key_alias === "string" ? info.key_alias : ""
  if (CODE_ALIAS.test(alias)) return "code"
  const metadata = info.metadata && typeof info.metadata === "object" ? info.metadata : {}
  if (CODE_METADATA.some((field) => metadata[field] != null)) return "code"
  if (CONSOLE_ALIAS.test(alias)) return "other"
  return "unknown"
}

// An alias for the terminal: the prefix and the first uuid group only.
export function shortAlias(alias: string) {
  const match = /^([a-z]+-[0-9a-f]{8})-[0-9a-f-]+$/i.exec(alias)
  return match ? `${match[1]}...` : alias
}

export const NOT_CODE_KEY = `This key was not created for ${Brand.product}. Create one in the Rafiki AI console with the ${Brand.product} option ticked, or run ${Brand.name} login.`
export const NOT_CODE_KEY_MEANING = `Runs still work, but ${Brand.product} tracks usage only on keys created for it.`

export async function checkKey(root: string, key: string, consoleURL: string, f: typeof fetch, timeoutMs: number, now: number): Promise<KeyResult> {
  const url = root + "/key/info"
  let response: Response
  try {
    response = await request(
      f,
      url,
      { headers: { authorization: `Bearer ${key}`, accept: "application/json", [Contract.HEADER.surface]: Contract.SURFACE } },
      timeoutMs,
    )
  } catch (cause) {
    return { line: unreachable("key", `could not ask the gateway (${detailOf(cause)})`, "Check the network and run the command again.") }
  }
  if (response.status === 401 || response.status === 403) {
    return {
      line: fail(
        "key",
        `rejected by the gateway (${response.status})`,
        `Run ${Brand.name} login, or create a new key at ${keysPage(consoleURL)} and set ${Brand.env.apiKey}.`,
      ),
    }
  }
  if (!response.ok) {
    return { line: fail("key", `${url} answered ${response.status}`, "Try again shortly; the gateway could not read its key store.") }
  }
  const data = await body(response)
  const info: KeyInfo | undefined = data && typeof data === "object" ? (data.info ?? data) : undefined
  if (!info || typeof info !== "object") {
    return { line: fail("key", "the gateway sent an unexpected reply", "Try again shortly.") }
  }
  const alias = info.key_alias ?? "(no alias)"
  const spend = money(info.spend ?? 0)
  const budget = info.max_budget == null ? "no budget cap" : `${money(info.max_budget)} USD budget`
  const expires = info.expires ? `, expires ${info.expires}` : ", no expiry"
  if (info.expires) {
    const at = Date.parse(info.expires)
    if (!Number.isNaN(at) && at <= now) {
      return { line: fail("key", `key ${alias} expired on ${info.expires}`, `Run ${Brand.name} login, or create a new key at ${keysPage(consoleURL)}.`), info }
    }
  }
  if (info.max_budget != null && Number(info.spend ?? 0) >= Number(info.max_budget)) {
    return {
      line: fail(
        "key",
        `key ${alias} has used its budget, ${spend} of ${money(info.max_budget)} USD`,
        `Top up or raise the key's budget at ${keysPage(consoleURL)}.`,
      ),
      info,
    }
  }
  if (keyType(info) === "other") {
    return { line: warn("key", `key ${shortAlias(alias)}, spent ${spend} USD of ${budget}${expires}`, NOT_CODE_KEY, NOT_CODE_KEY_MEANING), info }
  }
  return { line: ok("key", `key ${alias}, spent ${spend} USD of ${budget}${expires}`), info }
}

// LiteLLM spells "every model" as an empty list or one of these markers.
const ALL_MODELS = new Set(["all-proxy-models", "all-team-models"])

export async function checkTiers(root: string, key: string, info: KeyInfo, consoleURL: string, f: typeof fetch, timeoutMs: number): Promise<Line> {
  let listed: string[] | undefined = Array.isArray(info.models) ? info.models.filter((m): m is string => typeof m === "string") : undefined
  if (!listed || listed.length === 0 || listed.some((m) => ALL_MODELS.has(m))) {
    try {
      const response = await request(
        f,
        root + "/v1/models",
        { headers: { authorization: `Bearer ${key}`, accept: "application/json", [Contract.HEADER.surface]: Contract.SURFACE } },
        timeoutMs,
      )
      if (!response.ok) return fail("tiers", `${root}/v1/models answered ${response.status}`, "Try again shortly.")
      const data = await body(response)
      listed = Array.isArray(data?.data) ? data.data.map((m: any) => m?.id).filter((id: unknown): id is string => typeof id === "string") : []
    } catch (cause) {
      return unreachable("tiers", `could not list models (${detailOf(cause)})`, "Check the network and run the command again.")
    }
  }
  // Only the tiers offered to people are checked (Brand.provider.unlisted).
  const tiers = Brand.provider.offered()
  const allowed = tiers.filter((m) => listed!.includes(m))
  const missing = tiers.filter((m) => !listed!.includes(m))
  if (allowed.length === 0) {
    return fail("tiers", `none of ${tiers.join(", ")} is on this key`, `Create a key with the tiers you need at ${keysPage(consoleURL)}.`)
  }
  const note = missing.length ? ` (not on this key: ${missing.join(", ")})` : ""
  return ok("tiers", `${allowed.join(", ")}${note}`)
}

export async function checkConsole(
  consoleURL: string,
  key: string | undefined,
  env: Env,
  f: typeof fetch,
  timeoutMs: number,
  gatewayAccepted = false,
): Promise<Line> {
  const url = consoleURL + Contract.PATH.me
  let response: Response
  try {
    // Redirects are not followed: a Console without the account route sends
    // the browser login page, which must not pass for an account answer.
    response = await request(
      f,
      url,
      { redirect: "manual", headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) } },
      timeoutMs,
    )
  } catch (cause) {
    return networkLine(
      "console",
      "the console",
      consoleURL,
      cause,
      env[Brand.env.consoleURL] ? Brand.env.consoleURL : undefined,
    )
  }
  if (response.status >= 300 && response.status < 400) {
    return ok("console", `${consoleURL} reachable, account route not available (${response.status})`)
  }
  if (response.ok) {
    const data = await body(response)
    const owner = data?.owner
    const who = owner ? [owner.name, owner.email].filter(Boolean).join(" ") || owner.id : undefined
    const credits = data?.wallet?.balance_usd != null ? `, credits ${money(data.wallet.balance_usd)} USD available` : ""
    return ok("console", `${consoleURL}${who ? `, account ${who}` : ""}${credits}`)
  }
  if (response.status === 401) {
    if (!key) return ok("console", `${consoleURL} reachable, not signed in`)
    // The gateway accepts the key, so runs work and are metered: a warning, not a failure.
    if (gatewayAccepted) {
      return warn("console", `${consoleURL} does not know this key (401)`, notRegistered(consoleURL), notRegisteredMeaning(consoleURL))
    }
    return fail("console", `${consoleURL} does not accept this key (401)`, Contract.MESSAGE[Contract.ERROR.keyRevoked]!)
  }
  if (response.status >= 500) return fail("console", `${consoleURL} answered ${response.status}`, "The Rafiki AI console is having trouble. Try again shortly.")
  return ok("console", `${consoleURL} reachable (${response.status})`)
}

// What an untrusted workspace costs, in the order a person meets it.
export const TRUST_DROPPED =
  "Project plugins, custom tools, local MCP servers, formatters, language servers and permission rules declared in this directory are not loaded."

// Is the workspace this run starts in trusted, and what does that mean for it?
// Not a failure: an untrusted workspace still runs, it just drops the code and
// the settings the directory declares, which is otherwise invisible.
export function checkTrust(dir: string, by: "env" | "store" | undefined, headless: boolean, hint: string): Line {
  if (by === "env") return ok("trust", `${dir} is trusted for this run by ${Brand.env.trustWorkspace}`)
  if (by === "store") return ok("trust", `${dir} is trusted (stored in ${path.join(Brand.configDir(), Trust.storeName)})`)
  if (Trust.allowsCode({ trusted: false, headless })) {
    return ok("trust", `${dir} is not trusted, and project code loads anyway on this build`)
  }
  return warn("trust", `${dir} is not trusted`, `Run ${Brand.name} trust ${hint}.`, TRUST_DROPPED)
}

// Symlinks resolved, so the installer's link in a PATH directory compares equal
// to the binary it points at. A path that cannot be resolved is returned as it
// is: the comparison then fails, which is the honest answer.
export function realPath(target: string) {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return path.resolve(target)
  }
}

// Is this file a launcher rather than a build of this product? Some package
// managers (pnpm, and the shim based version managers) put a small script on PATH
// that execs the real binary, so the name resolving to something that is not this
// binary is normal for them. A shadowing install is a compiled executable; a
// launcher starts with a shebang, or is a .cmd or .ps1 wrapper on Windows.
export function looksLikeLauncher(file: string) {
  if (/\.(cmd|bat|ps1|sh)$/i.test(file)) return true
  try {
    const handle = fs.openSync(file, "r")
    try {
      const head = Buffer.alloc(2)
      return fs.readSync(handle, head, 0, 2, 0) === 2 && head.toString("latin1") === "#!"
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return false
  }
}

// What a launcher on PATH means: nothing is broken, but the two paths are not the
// same file, so doctor cannot prove the name reaches this build.
export const PATH_LAUNCHER =
  "Nothing is wrong if your package manager or version manager puts a launcher script on PATH. If you did not expect one, it is an older install still answering to the name."

// Does the name the person types reach the binary that is running?
//
// This is the failure v0.1.5 fixed and the one doctor could not see: a stale
// symlink from an older install, a copy earlier on PATH, or an install under a
// prefix the shell never searches. checkVersion reports execPath, which is
// always right and therefore never catches any of it.
//
// A source checkout runs under the bun or node binary, so there is nothing to
// compare and the check is skipped rather than made up.
export function checkPath(resolved: string | null, execPath: string, channel: string): Line {
  const own = path.basename(execPath).replace(/\.exe$/i, "") === Brand.name
  if (!own || channel === "local") {
    return skip("path", `not applicable, this process runs from ${execPath}`)
  }
  if (!resolved) {
    return fail(
      "path",
      `${Brand.name} is not on PATH, this process runs from ${execPath}`,
      `Add ${path.dirname(execPath)} to PATH, or reinstall with the installer at ${Brand.release.installer}, which links ${Brand.name} into a directory already on it.`,
    )
  }
  const target = realPath(resolved)
  const running = realPath(execPath)
  if (target === running) {
    const through = resolved === target ? "" : ` (a link to ${target})`
    return ok("path", `${Brand.name} resolves to ${resolved}${through}, the binary running this check`)
  }
  const through = resolved === target ? "" : ` (a link to ${target})`
  if (looksLikeLauncher(target)) {
    return warn(
      "path",
      `${Brand.name} resolves to ${resolved}${through}, a launcher script, not the binary running this check (${execPath})`,
      `Check that ${resolved} starts this version: run ${Brand.name} --version in a new terminal.`,
      PATH_LAUNCHER,
    )
  }
  return fail(
    "path",
    `${Brand.name} resolves to ${resolved}${through}, but this process runs from ${execPath}`,
    `Your shell finds another copy first. Remove ${resolved}, or put ${path.dirname(execPath)} earlier on PATH, then open a new terminal and run ${Brand.name} doctor again.`,
  )
}

export function installMethod(execPath: string, channel: string) {
  const normalized = execPath.split("\\").join("/")
  if (normalized.includes(`/${Brand.configDirName}/bin/`)) return `installed by the installer script, ${Brand.name} update applies`
  if (normalized.includes("/node_modules/")) return `installed through npm, update with npm install -g ${Brand.npm.meta}@latest`
  if (channel === "local") return "running from a source checkout"
  return "installed elsewhere, update through the channel you installed with"
}

export function checkVersion(version: string, channel: string, execPath: string): Line {
  return ok("version", `${Brand.name} ${version}, ${channel} channel, ${installMethod(execPath, channel)}`)
}

export interface Report {
  lines: Line[]
  ok: boolean
  failed: number
  warned: number
  // Contract exit code: 0 when nothing failed (warnings included), 4 when any
  // failure is a network failure, else 1.
  exitCode: number
}

// Every check in order. A failed credential skips the checks that need one;
// a failed key skips the tier check. The report is complete either way so
// the person sees the whole picture in one run.
export async function run(options: Options = {}): Promise<Report> {
  const env = options.env ?? process.env
  const f = options.fetch ?? fetch
  const dir = options.configDir ?? Brand.configDir()
  const consoleURL = (options.consoleURL ?? Brand.consoleURL()).replace(/\/+$/, "")
  const root = gatewayRoot(options.gatewayURL ?? Brand.gatewayURL())
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? (() => Date.now())
  const cwd = options.cwd ?? process.cwd()
  const execPath = options.execPath ?? process.execPath
  const channel = options.channel ?? InstallationChannel
  const validate = options.validate ?? (await loadValidate())
  const lines: Line[] = []

  lines.push(checkConfig(dir, validate))
  lines.push(checkProject(projectFiles(cwd), validate))
  lines.push(checkTrust(Trust.real(cwd), Trust.trustedBy(cwd), Trust.headless(), Trust.gitRoot(cwd) ?? cwd))
  const credential = checkCredential(env, dir, consoleURL, now())
  lines.push(credential.line)
  const gateway = await checkGateway(root, f, timeoutMs, env, now)
  lines.push(gateway)

  let info: KeyInfo | undefined
  let accepted = false
  // An unreachable gateway cannot answer the key check either; asking again
  // would only double the wait.
  if (credential.key && gateway.network) {
    lines.push(skip("key", "gateway unreachable"))
  } else if (credential.key) {
    const key = await checkKey(root, credential.key, consoleURL, f, timeoutMs, now())
    lines.push(key.line)
    info = key.line.status === "fail" ? undefined : key.info
    accepted = gatewayAccepts(key, now())
  } else {
    lines.push(skip("key", "no credential to check"))
  }

  if (credential.key && info) lines.push(await checkTiers(root, credential.key, info, consoleURL, f, timeoutMs))
  else lines.push(skip("tiers", !credential.key ? "no credential to check" : gateway.network ? "gateway unreachable" : "key check failed"))

  lines.push(await checkConsole(consoleURL, credential.key, env, f, timeoutMs, accepted))
  // util/which also searches the tool cache directory, where downloaded helpers
  // such as ripgrep live. This binary is never installed there, so what it finds
  // is what the shell's PATH finds.
  const resolve = options.which ?? ((command: string) => which(command, env as NodeJS.ProcessEnv))
  lines.push(checkPath(resolve(Brand.name), execPath, channel))
  lines.push(checkVersion(options.version ?? InstallationVersion, channel, execPath))

  const failed = lines.filter((l) => l.status === "fail").length
  const warned = lines.filter((l) => l.status === "warn").length
  const exitCode = failed === 0 ? Contract.EXIT.ok : lines.some((l) => l.network) ? Contract.EXIT.network : Contract.EXIT.failed
  return { lines, ok: failed === 0, failed, warned, exitCode }
}

// Width of the status and name columns, so a note lines up under the detail.
const INDENT = " ".repeat(4 + 2 + 10 + 2)

// One terminal line per check, plus an indented note line on a warning;
// colors are the caller's business.
export function format(line: Line) {
  const status = line.status === "fail" ? "FAIL" : line.status === "warn" ? "WARN" : line.status
  const main = `${status.padEnd(4)}  ${line.name.padEnd(10)}  ${line.detail}${line.fix ? `. Fix: ${line.fix}` : ""}`
  return line.note ? `${main}\n${INDENT}${line.note}` : main
}
