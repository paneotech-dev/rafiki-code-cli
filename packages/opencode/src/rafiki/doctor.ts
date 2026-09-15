// rafikicode doctor: the checks behind the command, one result line each.
// Plain async code with an injectable fetch, clock and environment so the
// tests drive it against the mock gateway and mock Console; the command in
// cmd.ts only prints. Nothing here ever returns or prints a key value.
import fs from "fs"
import path from "path"
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Credentials from "@opencode-ai/core/brand/credentials"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import * as Contract from "./contract"

export type Status = "ok" | "fail" | "skip"

export interface Line {
  // Short check name, printed in the first column.
  name: string
  status: Status
  // What was found, numbers and paths only.
  detail: string
  // One sentence telling the person what to do; only on a failure.
  fix?: string
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
}

export const NAMES = ["config", "credential", "gateway", "key", "tiers", "console", "version"] as const

// Time budget for each network call; a doctor run must never hang.
export const DEFAULT_TIMEOUT_MS = 8000

const ok = (name: string, detail: string): Line => ({ name, status: "ok", detail })
const fail = (name: string, detail: string, fix: string): Line => ({ name, status: "fail", detail, fix })
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

export function checkConfig(dir: string): Line {
  const file = path.join(dir, Brand.configFile)
  if (!fs.existsSync(file)) return ok("config", `${file} not created yet, built in defaults apply`)
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (cause) {
    return fail("config", `${file} cannot be read (${detailOf(cause)})`, `Make the file readable by your user, or move it aside; it is recreated with defaults on the next run.`)
  }
  const errors: ParseError[] = []
  const data = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    const first = errors[0]!
    const line = text.slice(0, first.offset).split("\n").length
    return fail(
      "config",
      `${file} is not valid JSON (${printParseErrorCode(first.error)} at line ${line})`,
      "Fix the syntax, or move the file aside; it is recreated with defaults on the next run.",
    )
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return fail("config", `${file} does not contain a JSON object`, "Replace the contents with an object, for example {}.")
  }
  const model = typeof data.model === "string" ? data.model : undefined
  const note = model ? ` (model ${model})` : ""
  if (model && !model.startsWith(`${Brand.provider.id}/`)) {
    return ok("config", `${file}${note}, a model outside the ${Brand.provider.name} gateway is not metered by the wallet`)
  }
  return ok("config", `${file}${note}`)
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
    const override = env[Brand.env.gatewayURL] ? `, and ${Brand.env.gatewayURL} which is set` : ""
    return unreachable("gateway", `${root} unreachable (${detailOf(cause)})`, `Check the network${override}.`)
  }
}

export interface KeyInfo {
  key_alias?: string | null
  spend?: number | null
  max_budget?: number | null
  expires?: string | null
  models?: string[] | null
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
  return `This key is valid at the gateway but not registered in Rafiki Console (created outside the Console). Create a key at ${keysPage(consoleURL)}, or run ${Brand.name} login.`
}

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
  const allowed = Brand.models.filter((m) => listed!.includes(m))
  const missing = Brand.models.filter((m) => !listed!.includes(m))
  if (allowed.length === 0) {
    return fail("tiers", `none of ${Brand.models.join(", ")} is on this key`, `Create a key with the tiers you need at ${keysPage(consoleURL)}.`)
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
    const override = env[Brand.env.consoleURL] ? `, and ${Brand.env.consoleURL} which is set` : ""
    return unreachable("console", `${consoleURL} unreachable (${detailOf(cause)})`, `Check the network${override}.`)
  }
  if (response.status >= 300 && response.status < 400) {
    return ok("console", `${consoleURL} reachable, account route not available (${response.status})`)
  }
  if (response.ok) {
    const data = await body(response)
    const owner = data?.owner
    const who = owner ? [owner.name, owner.email].filter(Boolean).join(" ") || owner.id : undefined
    const wallet = data?.wallet?.balance_usd != null ? `, wallet ${money(data.wallet.balance_usd)} USD available` : ""
    return ok("console", `${consoleURL}${who ? `, account ${who}` : ""}${wallet}`)
  }
  if (response.status === 401) {
    if (!key) return ok("console", `${consoleURL} reachable, not signed in`)
    if (gatewayAccepted) return fail("console", `${consoleURL} does not know this key (401)`, notRegistered(consoleURL))
    return fail("console", `${consoleURL} does not accept this key (401)`, Contract.MESSAGE[Contract.ERROR.keyRevoked]!)
  }
  if (response.status >= 500) return fail("console", `${consoleURL} answered ${response.status}`, "The Console is having trouble. Try again shortly.")
  return ok("console", `${consoleURL} reachable (${response.status})`)
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
  // Contract exit code: 0 all ok, 4 when any failure is a network failure, else 1.
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
  const lines: Line[] = []

  lines.push(checkConfig(dir))
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
    info = key.line.status === "ok" ? key.info : undefined
    accepted = gatewayAccepts(key, now())
  } else {
    lines.push(skip("key", "no credential to check"))
  }

  if (credential.key && info) lines.push(await checkTiers(root, credential.key, info, consoleURL, f, timeoutMs))
  else lines.push(skip("tiers", !credential.key ? "no credential to check" : gateway.network ? "gateway unreachable" : "key check failed"))

  lines.push(await checkConsole(consoleURL, credential.key, env, f, timeoutMs, accepted))
  lines.push(checkVersion(options.version ?? InstallationVersion, options.channel ?? InstallationChannel, options.execPath ?? process.execPath))

  const failed = lines.filter((l) => l.status === "fail").length
  const exitCode = failed === 0 ? Contract.EXIT.ok : lines.some((l) => l.network) ? Contract.EXIT.network : Contract.EXIT.failed
  return { lines, ok: failed === 0, failed, exitCode }
}

// One terminal line per check; colors are the caller's business.
export function format(line: Line) {
  const status = line.status === "fail" ? "FAIL" : line.status
  return `${status.padEnd(4)}  ${line.name.padEnd(10)}  ${line.detail}${line.fix ? `. Fix: ${line.fix}` : ""}`
}
