// Rafiki Code brand layer. Every value that distinguishes rafikicode from the
// upstream project lives in this directory. Core files import from here through
// single line touchpoints and never hard code product names, paths, or
// gateway details, so upstream merges stay cheap.
import os from "os"
import path from "path"
import { existsSync } from "fs"
import { logo, plain } from "./wordmark"
import { houseStyle } from "./house-style"
import * as Credentials from "./credentials"

const gatewayDefault = "https://gateway.rafikiai.io/v1"
const consoleDefault = "https://console.rafikiai.io"
const providerID = "rafiki"
const models = ["rafiki-fast", "rafiki-pro", "rafiki-max"] as const
const labels: Record<(typeof models)[number], string> = {
  "rafiki-fast": "Rafiki Fast",
  "rafiki-pro": "Rafiki Pro",
  "rafiki-max": "Rafiki Max",
}

// Request defaults for the gateway tiers. rafiki-fast is a reasoning model
// (its completion tokens include reasoning), so a small output cap can end a
// turn with no answer at all. Measured on the gateway 2026-09-13: a streamed
// rafiki-fast call with reasoning_effort "low" reasons exactly as much as one
// with no effort parameter, while "none" reasons not at all, and a scaffold
// sized answer needs about 64000 output tokens with default reasoning. So fast
// gets a 64000 token output limit and sends no effort by default; pro and max
// keep 32000.
//
// Turning reasoning off: every tier with variants offers none, low, medium and
// high. The none variant sends reasoning_effort "none" (rafikicode run
// --variant none, or ctrl+t to cycle variants in the terminal interface), and
// RAFIKICODE_REASONING_EFFORT=none sends it on every tier. rafiki-pro sends no
// effort and offers no effort variants: a call carrying one was answered by
// the max fallback instead of pro. The two env names let the orchestrator set
// a per turn budget for the engine in a sandbox.
const reasoningEfforts = ["none", "low", "medium", "high"] as const
type ReasoningEffort = (typeof reasoningEfforts)[number]
const requestDefaults: Record<(typeof models)[number], { output: number; effort?: ReasoningEffort; variants: boolean }> = {
  "rafiki-fast": { output: 64_000, variants: true },
  "rafiki-pro": { output: 32_000, variants: false },
  "rafiki-max": { output: 32_000, variants: true },
}
const outputFloor = 1_024
const outputCeiling = 128_000

let warned = false
function warnOnce(message: string) {
  if (warned) return
  warned = true
  process.stderr.write(message + "\n")
}

// Release override from the environment, when it is safe to download from.
function releaseOverride(name: string) {
  const value = process.env[name]
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol === "https:") return value
    if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return value
  } catch {
    // Not a URL: treated like any other refused value.
  }
  return undefined
}

export const Brand = {
  // Binary and script name, also the npm package name.
  name: "rafikicode",
  // Human readable product name.
  product: "Rafiki Code",
  // Short prefix for terminal window titles.
  short: "RC",
  // Subdirectory name under the XDG data, cache, state, and temp roots.
  dir: "rafikicode",
  // Directory under the user's home holding config.json and AGENTS.md.
  configDirName: ".rafikicode",
  // File seeded and read first inside the config directory.
  configFile: "config.json",
  // Every file read from the global config directory, preferred first; the
  // upstream names are read silently for compatibility.
  globalFiles: ["config.json", "opencode.json", "opencode.jsonc"],
  homepage: "https://code.rafikiai.io",
  // Public README and issue tracker, opened from the TUI ("Open docs", crash screen).
  docs: "https://github.com/paneotech-dev/rafiki-code-cli",
  issues: "https://github.com/paneotech-dev/rafiki-code-cli/issues/new",
  // Short form of the global config path, used in hints and error messages.
  configHint: "~/.rafikicode/config.json",
  // Name of the built in default TUI theme (theme/assets/opencode.json upstream).
  theme: "rafikicode",
  // Project level configuration: the directory and file base name the fork
  // prefers and documents, plus the upstream names it keeps reading silently.
  project: {
    dir: ".rafikicode",
    file: "rafikicode",
    // Preferred first, so a search finds ours before an upstream leftover.
    dirs: [".rafikicode", ".opencode"],
    fileNames: ["rafikicode", "opencode"],
    files: ["rafikicode.json", "rafikicode.jsonc", "opencode.json", "opencode.jsonc"],
    isDir(dir: string) {
      return Brand.project.dirs.includes(path.basename(dir))
    },
    // Directory to write project files into: an existing one under root,
    // ours first, else ours.
    dirIn(root: string) {
      for (const name of Brand.project.dirs) {
        const dir = path.join(root, name)
        if (existsSync(dir)) return dir
      }
      return path.join(root, Brand.project.dir)
    },
  },
  // JSON schemas written as $schema into generated config files. Regenerate
  // with: bun run packages/opencode/script/schema.ts schema/config.json schema/tui.json
  schema: {
    config: "https://raw.githubusercontent.com/paneotech-dev/rafiki-code-cli/main/schema/config.json",
    tui: "https://raw.githubusercontent.com/paneotech-dev/rafiki-code-cli/main/schema/tui.json",
  },
  // Upstream hosted providers are never offered: without them an install
  // without a key shows no upstream model names, and every model goes
  // through the gateway.
  disabledProviders: ["opencode", "opencode-go"],
  env: {
    // Headless and CI key. Takes precedence over the stored credential.
    apiKey: "RAFIKICODE_API_KEY",
    // Overrides the gateway base URL, used for local mocks and staging.
    gatewayURL: "RAFIKICODE_GATEWAY_URL",
    // Overrides the release API URL (mock release servers in tests).
    releaseAPI: "RAFIKICODE_RELEASE_API",
    // Overrides the release download base URL (mock release servers in tests).
    releaseBase: "RAFIKICODE_RELEASE_BASE",
    // Overrides the Console base URL for the device flow, used for local mocks and staging.
    consoleURL: "RAFIKICODE_CONSOLE_URL",
    // Output token limit for every rafiki-* model (1024 to 128000). The rafiki
    // provider is not held to the upstream 32000 runtime cap; an explicit
    // OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX still lowers it.
    maxOutputTokens: "RAFIKICODE_MAX_OUTPUT_TOKENS",
    // Reasoning effort for every rafiki-* model: none, low, medium, high, or
    // default to send no effort parameter. none turns reasoning off.
    reasoningEffort: "RAFIKICODE_REASONING_EFFORT",
  },
  // Where builds are published. The installer script and the self updater read
  // these; the release workflow tags v<version> and uploads the archives plus
  // SHA256SUMS to this repository's releases.
  release: {
    owner: "paneotech-dev",
    repo: "rafiki-code-cli",
    // One line installer, served at get.rafikiai.io (DNS by Julien, Phase 2).
    installer: "https://get.rafikiai.io",
    // GitHub releases API for this repository (latest release lookup).
    // An override is used only when it is https, or http on a loopback host
    // (local mock release servers); anything else falls back to the default and
    // is reported by release.overrideProblem().
    api() {
      return releaseOverride(Brand.env.releaseAPI) ?? `https://api.github.com/repos/${Brand.release.owner}/${Brand.release.repo}`
    },
    // Base URL that <base>/download/v<version>/<asset> resolves under.
    base() {
      return releaseOverride(Brand.env.releaseBase) ?? `https://github.com/${Brand.release.owner}/${Brand.release.repo}/releases`
    },
    // A message naming the first release override that is set but not allowed.
    overrideProblem() {
      for (const name of [Brand.env.releaseAPI, Brand.env.releaseBase]) {
        const value = process.env[name]
        if (value && !releaseOverride(name)) return `${name} must be an https URL (http is accepted only for 127.0.0.1 or localhost), so it is not used.`
      }
      return undefined
    },
    // Asset file name for a platform, matching script/build.ts output names.
    asset(os: string, arch: string, variant = "") {
      const ext = os === "linux" ? ".tar.gz" : ".zip"
      return `${Brand.name}-${os === "win32" ? "windows" : os}-${arch}${variant ? `-${variant}` : ""}${ext}`
    },
    checksums: "SHA256SUMS",
  },
  npm: {
    // Meta package users install; platform packages are <name>-<os>-<arch>.
    meta: "rafikicode",
    registry: "https://registry.npmjs.org",
  },
  gateway: { url: gatewayDefault },
  console: { url: consoleDefault },
  models,
  // Lowest index is the least preferred; the default picker takes the last entry first.
  priority: [...models].reverse(),
  defaultModel: `${providerID}/${models[0]}`,
  upstream: {
    name: "opencode",
    url: "https://github.com/anomalyco/opencode",
    license: "MIT",
  },
  logo,
  wordmark: plain,
  houseStyle,
  // Rewrites the upstream product name and links inside a system prompt so the
  // agent introduces itself as this product and points feedback at our repo.
  // Applied once where the per-provider prompt is selected (session/system.ts).
  prompt(text: string) {
    return text
      .replaceAll("https://github.com/anomalyco/opencode/issues", `${Brand.docs}/issues`)
      .replaceAll("https://github.com/anomalyco/opencode", Brand.docs)
      .replace(/https:\/\/opencode\.ai\/docs[\w#./-]*/g, Brand.docs)
      .replaceAll("https://opencode.ai", Brand.docs)
      .replaceAll("OpenCode", Brand.product)
      .replace(/(?<![\w./-])opencode(?![\w-]|\.jsonc?)/g, Brand.name)
  },
  // Gateway base URL: the override env var, else the URL the Console handed
  // out at login, else the default.
  gatewayURL() {
    const override = process.env[Brand.env.gatewayURL]
    if (override) return override
    try {
      return Brand.credential()?.gateway_url || gatewayDefault
    } catch {
      // An unsafe credential file is not trusted for its gateway URL either.
      return gatewayDefault
    }
  },
  // Console base URL for the device flow and the account routes.
  consoleURL() {
    return (process.env[Brand.env.consoleURL] || consoleDefault).replace(/\/+$/, "")
  },
  // The stored login credential, if any. Read fresh on every call; it is one small file.
  // An unsafe file (Credentials.check) throws UnsafeCredentialError, unless
  // the env key is set, in which case the file is simply not used.
  credential() {
    try {
      return Credentials.read(Brand.configDir())
    } catch (cause) {
      if (cause instanceof Credentials.UnsafeCredentialError && process.env[Brand.env.apiKey]) return undefined
      throw cause
    }
  },
  // The reason the stored credential file may not be used, when this process
  // would otherwise use it (no env key); undefined when it is safe or absent.
  unsafeCredential() {
    if (process.env[Brand.env.apiKey]) return undefined
    return Credentials.check(Brand.configDir())
  },
  // Config directory. An explicit XDG_CONFIG_HOME wins so isolated test and CI
  // environments keep working; otherwise the brief's ~/.rafikicode.
  configDir(home: string = process.env["OPENCODE_TEST_HOME"] ?? os.homedir()) {
    const xdg = process.env["XDG_CONFIG_HOME"]
    if (xdg) return path.join(xdg, Brand.dir)
    return path.join(home, Brand.configDirName)
  },
  // True when a gateway credential is available to this process: the env
  // var, or a stored login.
  hasKey() {
    return Boolean(process.env[Brand.env.apiKey]) || Credentials.exists(Brand.configDir())
  },
  // A stored browser sign-in was approved for a person at a terminal, not for
  // a pipeline: when CI is set and no server key is given, it is refused with
  // a warning (contract, Server keys). The env var, when set, always wins.
  sessionKeyRefusedInCI() {
    if (process.env[Brand.env.apiKey]) return false
    if (!process.env["CI"]) return false
    const stored = Brand.credential()
    return Boolean(stored) && stored?.kind !== "server"
  },
  // Built in defaults seeded under the user's global config. Anything the user
  // writes to ~/.rafikicode/config.json or a project config overrides these.
  // The gateway provider is registered once a credential exists; upstream
  // hosted providers are disabled either way, so an install without a key
  // offers no model and the interface points at rafikicode login.
  config() {
    if (Brand.sessionKeyRefusedInCI()) {
      warnOnce(
        `${Brand.product}: CI is set, so the stored browser sign-in is not used. Create a server key at ${Brand.consoleURL()}/keys and set ${Brand.env.apiKey}.`,
      )
      return { autoupdate: false as const, disabled_providers: [...Brand.disabledProviders] }
    }
    return {
      autoupdate: false as const,
      disabled_providers: [...Brand.disabledProviders],
      ...(Brand.hasKey() ? { provider: Brand.provider.config() } : {}),
    }
  },
  provider: {
    id: providerID,
    name: "Rafiki",
    reasoningEfforts,
    // The request defaults for one model after the env overrides; invalid values fall back to the defaults.
    request(id: (typeof models)[number]) {
      const base = requestDefaults[id]
      const rawOutput = process.env[Brand.env.maxOutputTokens]
      const parsed = rawOutput && /^\d+$/.test(rawOutput) ? Number(rawOutput) : NaN
      const output = parsed >= outputFloor && parsed <= outputCeiling ? parsed : base.output
      const rawEffort = process.env[Brand.env.reasoningEffort]
      const effort =
        rawEffort === "default"
          ? undefined
          : reasoningEfforts.includes(rawEffort as ReasoningEffort)
            ? (rawEffort as ReasoningEffort)
            : base.effort
      return { output, effort, variants: base.variants }
    },
    config() {
      // The env var wins over the stored credential. When only the stored
      // credential exists its key is passed as a provider option, which is
      // how upstream treats a key written in config.
      const stored = process.env[Brand.env.apiKey] ? undefined : Brand.credential()
      return {
        [providerID]: {
          name: Brand.provider.name,
          npm: "@ai-sdk/openai-compatible",
          env: [Brand.env.apiKey],
          options: {
            baseURL: Brand.gatewayURL(),
            // Every gateway call names its surface (contract, Gateway usage).
            headers: { "X-Rafiki-Surface": "cli" },
            ...(stored ? { apiKey: stored.key } : {}),
          },
          models: Object.fromEntries(
            models.map((id) => {
              const request = Brand.provider.request(id)
              return [
                id,
                {
                  name: labels[id],
                  tool_call: true,
                  reasoning: false,
                  attachment: false,
                  temperature: true,
                  limit: { context: 128_000, output: request.output },
                  cost: { input: 0, output: 0 },
                  ...(request.effort ? { options: { reasoningEffort: request.effort } } : {}),
                  ...(request.variants
                    ? { variants: Object.fromEntries(reasoningEfforts.map((effort) => [effort, { reasoningEffort: effort }])) }
                    : {}),
                },
              ]
            }),
          ),
        },
      }
    },
  },
}
