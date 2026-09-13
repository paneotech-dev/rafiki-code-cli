// rafikicode login, logout, whoami and doctor: the Rafiki Console device flow from
// the terminal. Registered in src/index.ts; everything else lives here.
import type { Argv } from "yargs"
import { Effect } from "effect"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Credentials from "@opencode-ai/core/brand/credentials"
import * as Trust from "@opencode-ai/core/brand/trust"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { effectCmd, fail } from "@/cli/effect-cmd"
import { UI } from "@/cli/ui"
import * as Contract from "./contract"
import * as DeviceFlow from "./device-flow"
import * as Doctor from "./doctor"

function tryFlow<A>(what: Promise<A>) {
  return Effect.tryPromise({
    try: () => what,
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) => {
      if (cause instanceof DeviceFlow.DeviceFlowError) {
        const message = cause.ref ? `${cause.message}\n(ref ${cause.ref})` : cause.message
        return fail(message, cause.exitCode)
      }
      return fail(cause instanceof Error ? cause.message : String(cause), Contract.EXIT.internal)
    }),
  )
}

// Commands that still run with an unsafe credential file: they report it,
// replace it, or remove it.
const unsafeAllowed = new Set(["login", "logout", "doctor"])

// Runs before every command (src/index.ts). A credential file that is a link,
// belongs to someone else, or is readable by others is refused: print the fix
// and exit, unless RAFIKICODE_API_KEY is set.
export function refuseUnsafeCredential(command: unknown) {
  if (typeof command === "string" && unsafeAllowed.has(command)) return
  const problem = Brand.unsafeCredential()
  if (!problem) return
  UI.error(`${problem.message}\nOr set ${Brand.env.apiKey} to use a server key instead.`)
  process.exit(problem.exitCode)
}

// The stored credential, or undefined when the file is unsafe and the
// caller is about to replace or remove it anyway.
function storedOrUnsafe(): { stored?: Credentials.StoredCredential; unsafe?: Credentials.UnsafeCredentialError } {
  try {
    return { stored: Brand.credential() }
  } catch (cause) {
    if (cause instanceof Credentials.UnsafeCredentialError) return { unsafe: cause }
    throw cause
  }
}

function describeOwner(owner?: Contract.Owner) {
  if (!owner) return "unknown account"
  return [owner.name, owner.email].filter(Boolean).join(" ") || owner.id
}

function expiry(credential: Credentials.StoredCredential) {
  if (!credential.expires_at) return "no expiry recorded"
  const ms = Date.parse(credential.expires_at) - Date.now()
  if (Number.isNaN(ms)) return credential.expires_at
  if (ms <= 0) return `expired ${credential.expires_at}`
  const days = Math.floor(ms / 86_400_000)
  return days >= 1 ? `expires in ${days} day${days === 1 ? "" : "s"}` : "expires today"
}

function store(token: Contract.TokenResponse, previous?: Credentials.StoredCredential) {
  const credential = DeviceFlow.toCredential(token)
  if (previous) credential.refreshed_at = credential.created_at
  Credentials.write(Brand.configDir(), credential)
  return credential
}

export const LoginCommand = effectCmd({
  command: "login",
  describe: `sign in to ${Brand.product} from this terminal`,
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("label", {
        type: "string",
        describe: "name shown on the approval page and in the Console key list",
      })
      .option("refresh", {
        type: "boolean",
        default: false,
        describe: "rotate the stored key instead of starting a new sign-in",
      }),
  handler: Effect.fn("Cli.rafiki.login")(function* (args) {
    const dir = Brand.configDir()
    const { stored: existing, unsafe } = storedOrUnsafe()

    if (args.refresh) {
      if (unsafe) return yield* fail(unsafe.message, unsafe.exitCode)
      if (!existing) return yield* fail(Contract.MESSAGE[Contract.ERROR.unauthenticated], Contract.EXIT.usage)
      if (!DeviceFlow.shouldRefresh(existing, Date.now(), true)) {
        UI.println("The key was rotated less than an hour ago. Nothing to do.")
        return
      }
      const c = DeviceFlow.client({ consoleURL: existing.console_url || Brand.consoleURL() })
      const token = yield* tryFlow(DeviceFlow.refresh(c, existing.key))
      const credential = store(token, existing)
      UI.println(`Rotated the key for ${describeOwner(credential.owner)} (${expiry(credential)}).`)
      return
    }

    const reason = DeviceFlow.headless()
    if (reason) return yield* fail(DeviceFlow.headlessMessage(reason), Contract.EXIT.usage)

    if (existing && DeviceFlow.shouldRefresh(existing)) {
      const c = DeviceFlow.client({ consoleURL: existing.console_url || Brand.consoleURL() })
      const rotated = yield* Effect.tryPromise(() => DeviceFlow.refresh(c, existing.key)).pipe(
        Effect.map((token) => store(token, existing)),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (rotated) {
        UI.println(`Already signed in as ${describeOwner(rotated.owner)}; rotated the key (${expiry(rotated)}).`)
        return
      }
    }

    const c = DeviceFlow.client()
    const label = DeviceFlow.deviceLabel(InstallationVersion, args.label)
    const code = yield* tryFlow(DeviceFlow.requestCode(c, { label }))

    UI.empty()
    UI.println(`Open ${UI.Style.TEXT_HIGHLIGHT_BOLD}${code.verification_uri}${UI.Style.TEXT_NORMAL} in a browser and enter this code:`)
    UI.empty()
    UI.println(`    ${UI.Style.TEXT_NORMAL_BOLD}${code.user_code}${UI.Style.TEXT_NORMAL}`)
    UI.empty()
    if (code.verification_uri_complete) {
      UI.println(`${UI.Style.TEXT_DIM}Or open ${code.verification_uri_complete}${UI.Style.TEXT_NORMAL}`)
    }
    UI.println(
      `${UI.Style.TEXT_DIM}Approving as: ${label}. The code expires in ${Math.round(code.expires_in / 60)} minutes.${UI.Style.TEXT_NORMAL}`,
    )
    UI.println(`${UI.Style.TEXT_DIM}Waiting for approval...${UI.Style.TEXT_NORMAL}`)

    const token = yield* tryFlow(
      DeviceFlow.pollToken(c, code, {
        onSlowDown: ({ interval }) => UI.println(`${UI.Style.TEXT_DIM}Console asked to slow down; polling every ${interval} s.${UI.Style.TEXT_NORMAL}`),
        onRateLimited: ({ retryAfter }) => UI.println(`${UI.Style.TEXT_DIM}Rate limited; retrying in ${retryAfter} s.${UI.Style.TEXT_NORMAL}`),
      }),
    )
    const credential = store(token)
    UI.empty()
    UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}Signed in${UI.Style.TEXT_NORMAL} as ${describeOwner(credential.owner)}.`)
    // The previous sign-in's key would otherwise stay live at the gateway
    // until it expires. Best effort: a failure here never undoes the login.
    if (existing?.key_id && existing.key !== token.access_token) {
      const previous = DeviceFlow.client({ consoleURL: existing.console_url || Brand.consoleURL() })
      const revoked = yield* Effect.tryPromise(() => DeviceFlow.revoke(previous, existing.key, existing.key_id!)).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      )
      if (revoked) UI.println(`${UI.Style.TEXT_DIM}Revoked the previous key ${existing.key_alias ?? existing.key_id}.${UI.Style.TEXT_NORMAL}`)
      else
        UI.println(
          `${UI.Style.TEXT_WARNING}Could not revoke the previous key ${existing.key_alias ?? existing.key_id}. Revoke it at ${existing.console_url || Brand.consoleURL()}${Contract.PATH.keysPage}.${UI.Style.TEXT_NORMAL}`,
        )
    }
    UI.println(`Key ${credential.key_alias ?? "(no alias)"} stored at ${Credentials.file(dir)} (${expiry(credential)}).`)
    if (token.limits?.max_budget_usd != null) {
      UI.println(`${UI.Style.TEXT_DIM}Budget reserved for this key: ${token.limits.max_budget_usd} USD.${UI.Style.TEXT_NORMAL}`)
    }
  }),
})

export const LogoutCommand = effectCmd({
  command: "logout",
  describe: `sign out of ${Brand.product} and revoke this terminal's key`,
  instance: false,
  handler: Effect.fn("Cli.rafiki.logout")(function* () {
    const dir = Brand.configDir()
    const { stored: existing, unsafe } = storedOrUnsafe()
    if (unsafe) {
      // Its key is not trusted enough to send anywhere, so it is not revoked.
      Credentials.remove(dir)
      UI.println(`Removed ${Credentials.file(dir)} without revoking its key, because the file ${unsafe.reason}.`)
      UI.println(`Revoke that key at ${Brand.consoleURL()}${Contract.PATH.keysPage} if it was yours.`)
      return
    }
    if (!existing) {
      if (process.env[Brand.env.apiKey]) {
        UI.println(`No stored login. ${Brand.env.apiKey} is set in the environment; unset it to stop using that key.`)
        return
      }
      UI.println("Not signed in.")
      return
    }
    if (existing.key_id) {
      const c = DeviceFlow.client({ consoleURL: existing.console_url || Brand.consoleURL() })
      const revoked = yield* Effect.tryPromise(() => DeviceFlow.revoke(c, existing.key, existing.key_id!)).pipe(
        Effect.map(() => true),
        Effect.catch((cause) => {
          const message = cause instanceof Error ? cause.message : String(cause)
          UI.println(
            `${UI.Style.TEXT_WARNING}Could not revoke the key at the Console (${message}). Revoke it at ${existing.console_url || Brand.consoleURL()}${Contract.PATH.keysPage}.${UI.Style.TEXT_NORMAL}`,
          )
          return Effect.succeed(false)
        }),
      )
      if (revoked) UI.println(`Revoked key ${existing.key_alias ?? existing.key_id} at the Console.`)
    }
    Credentials.remove(dir)
    UI.println(`Removed ${Credentials.file(dir)}. Signed out.`)
  }),
})

export const WhoamiCommand = effectCmd({
  command: "whoami",
  describe: `show the ${Brand.product} account this terminal uses`,
  instance: false,
  builder: (yargs: Argv) =>
    yargs.option("offline", {
      type: "boolean",
      default: false,
      describe: "print the stored credential without asking the Console",
    }),
  handler: Effect.fn("Cli.rafiki.whoami")(function* (args) {
    const envKey = process.env[Brand.env.apiKey]
    const stored = Brand.credential()
    if (envKey && stored) {
      UI.println(`${UI.Style.TEXT_DIM}${Brand.env.apiKey} is set and takes precedence over the stored login.${UI.Style.TEXT_NORMAL}`)
    }
    const key = envKey || stored?.key
    if (!key) return yield* fail(Contract.MESSAGE[Contract.ERROR.unauthenticated], Contract.EXIT.usage)

    const consoleURL = (envKey ? undefined : stored?.console_url) || Brand.consoleURL()
    UI.println(`Console: ${consoleURL}`)
    UI.println(`Gateway: ${Brand.gatewayURL()}`)
    UI.println(`Credential: ${envKey ? `${Brand.env.apiKey} (environment)` : Credentials.file(Brand.configDir())}`)

    if (!args.offline) {
      const remote = yield* Effect.tryPromise({
        try: () => DeviceFlow.me(DeviceFlow.client({ consoleURL }), key),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) => {
          // A revoked or unknown key is an answer, not an outage: say so and
          // exit 2, the way every other command does once the key is dead.
          if (cause instanceof DeviceFlow.DeviceFlowError && cause.exitCode === Contract.EXIT.usage) {
            return fail(cause.message, cause.exitCode)
          }
          const message = cause instanceof Error ? cause.message : String(cause)
          UI.println(`${UI.Style.TEXT_DIM}Could not load the account from the Console (${message}).${UI.Style.TEXT_NORMAL}`)
          return Effect.succeed(undefined)
        }),
      )
      if (remote) {
        UI.println(`Account: ${describeOwner(remote.owner)}`)
        if (remote.key) {
          UI.println(
            `Key: ${remote.key.alias ?? "(no alias)"}${remote.key.name ? ` "${remote.key.name}"` : ""}${remote.key.kind ? ` (${remote.key.kind})` : ""}${remote.key.expires_at ? `, expires ${remote.key.expires_at}` : ""}`,
          )
        }
        if (remote.wallet?.balance_usd != null) UI.println(`Wallet: ${remote.wallet.balance_usd} USD available`)
        if (remote.limits?.max_budget_usd != null) {
          UI.println(`Key budget: ${remote.limits.spend_usd ?? 0} of ${remote.limits.max_budget_usd} USD used`)
        }
        if (remote.tiers?.length) UI.println(`Tiers: ${remote.tiers.join(", ")}`)
        return
      }
    }
    if (envKey) {
      UI.println("Account: a server key from the environment (details are on the Console key page).")
      return
    }
    UI.println(`Account: ${describeOwner(stored!.owner)}`)
    UI.println(`Key: ${stored!.key_alias ?? "(no alias)"} (${expiry(stored!)})`)
  }),
})

export { markHeadless } from "@opencode-ai/core/brand/trust"

// rafikicode trust: the workspace trust store (docs/security/workspace-trust.md).
export const TrustCommand = effectCmd({
  command: "trust [dir]",
  describe: "trust a workspace so its project plugins, tools and settings load",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("dir", {
        type: "string",
        describe: "workspace directory (default: the git root of the current directory, else the current directory)",
      })
      .option("list", { type: "boolean", default: false, describe: "list the trusted workspaces" })
      .option("remove", { type: "boolean", default: false, describe: "stop trusting the workspace" }),
  handler: Effect.fn("Cli.rafiki.trust")(function* (args) {
    if (args.list) {
      const list = Trust.stored()
      if (!list.length) UI.println(`No trusted workspaces in ${Trust.storeFile()}.`)
      for (const dir of list) UI.println(dir)
      if (process.env[Brand.env.trustWorkspace]) UI.println(`${Brand.env.trustWorkspace} is set: ${process.env[Brand.env.trustWorkspace]}`)
      return
    }
    const cwd = process.cwd()
    const dir = args.dir ? String(args.dir) : (Trust.gitRoot(cwd) ?? cwd)
    try {
      if (args.remove) {
        const removed = Trust.remove(dir)
        UI.println(removed ? `No longer trusted: ${Trust.real(dir)}` : `${Trust.real(dir)} was not trusted.`)
        return
      }
      const stored = Trust.add(dir)
      UI.println(`Trusted: ${stored}`)
      UI.println(`Project plugins, custom tools, provider packages and settings from this directory and below now load. Stored in ${Trust.storeFile()}.`)
    } catch (cause) {
      if (cause instanceof Trust.TrustError) return yield* fail(cause.message, Contract.EXIT.usage)
      throw cause
    }
  }),
})

// One line per check, ok or a plain fix hint; exit 0 only when every line is ok.
export const DoctorCommand = effectCmd({
  command: "doctor",
  describe: `check this terminal's ${Brand.product} setup: config, key, gateway, tiers, Console, version`,
  instance: false,
  builder: (yargs: Argv) =>
    yargs.option("timeout", {
      type: "number",
      default: Doctor.DEFAULT_TIMEOUT_MS / 1000,
      describe: "seconds to wait for each network check",
    }),
  handler: Effect.fn("Cli.rafiki.doctor")(function* (args) {
    const report = yield* Effect.promise(() => Doctor.run({ timeoutMs: Math.max(1, Number(args.timeout) || 1) * 1000 }))
    for (const line of report.lines) {
      const color =
        line.status === "ok" ? UI.Style.TEXT_SUCCESS_BOLD : line.status === "fail" ? UI.Style.TEXT_DANGER_BOLD : UI.Style.TEXT_DIM_BOLD
      const text = Doctor.format(line)
      const status = text.slice(0, 4)
      UI.println(`${color}${status}${UI.Style.TEXT_NORMAL}${text.slice(4)}`)
    }
    UI.empty()
    if (report.ok) {
      UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}All checks passed.${UI.Style.TEXT_NORMAL}`)
      return
    }
    const noun = report.failed === 1 ? "1 check needs" : `${report.failed} checks need`
    return yield* fail(`${noun} attention, see the lines marked FAIL.`, report.exitCode)
  }),
})
