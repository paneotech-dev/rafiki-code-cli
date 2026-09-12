// Rafiki Code brand layer. Every value that distinguishes rafikicode from the
// upstream project lives in this directory. Core files import from here through
// single line touchpoints and never hard code product names, paths, or
// gateway details, so upstream merges stay cheap.
import os from "os"
import path from "path"
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

let warned = false
function warnOnce(message: string) {
  if (warned) return
  warned = true
  process.stderr.write(message + "\n")
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
  homepage: "https://code.rafikiai.io",
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
    api() {
      return process.env[Brand.env.releaseAPI] || `https://api.github.com/repos/${Brand.release.owner}/${Brand.release.repo}`
    },
    // Base URL that <base>/download/v<version>/<asset> resolves under.
    base() {
      return process.env[Brand.env.releaseBase] || `https://github.com/${Brand.release.owner}/${Brand.release.repo}/releases`
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
  // Gateway base URL: the override env var, else the URL the Console handed
  // out at login, else the default.
  gatewayURL() {
    return process.env[Brand.env.gatewayURL] || Brand.credential()?.gateway_url || gatewayDefault
  },
  // Console base URL for the device flow and the account routes.
  consoleURL() {
    return (process.env[Brand.env.consoleURL] || consoleDefault).replace(/\/+$/, "")
  },
  // The stored login credential, if any. Read fresh on every call; it is one small file.
  credential() {
    return Credentials.read(Brand.configDir())
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
  // The gateway provider is only registered once a credential exists, so an
  // unauthenticated install behaves like upstream until rafikicode login runs.
  config() {
    if (Brand.sessionKeyRefusedInCI()) {
      warnOnce(
        `${Brand.product}: CI is set, so the stored browser sign-in is not used. Create a server key at ${Brand.consoleURL()}/keys and set ${Brand.env.apiKey}.`,
      )
      return { autoupdate: false as const }
    }
    return {
      autoupdate: false as const,
      ...(Brand.hasKey() ? { provider: Brand.provider.config() } : {}),
    }
  },
  provider: {
    id: providerID,
    name: "Rafiki",
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
            models.map((id) => [
              id,
              {
                name: labels[id],
                tool_call: true,
                reasoning: false,
                attachment: false,
                temperature: true,
                limit: { context: 128_000, output: 16_384 },
                cost: { input: 0, output: 0 },
              },
            ]),
          ),
        },
      }
    },
  },
}
