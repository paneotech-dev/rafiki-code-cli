// Rafiki Code brand layer. Every value that distinguishes rafikicode from the
// upstream project lives in this directory. Core files import from here through
// single line touchpoints and never hard code product names, paths, or
// gateway details, so upstream merges stay cheap.
import os from "os"
import path from "path"
import { logo, plain } from "./wordmark"
import { houseStyle } from "./house-style"

const gatewayDefault = "https://gateway.rafikiai.io/v1"
const providerID = "rafiki"
const models = ["rafiki-fast", "rafiki-pro", "rafiki-max"] as const
const labels: Record<(typeof models)[number], string> = {
  "rafiki-fast": "Rafiki Fast",
  "rafiki-pro": "Rafiki Pro",
  "rafiki-max": "Rafiki Max",
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
    // Headless and CI key, also the key rafikicode login stores for the gateway.
    apiKey: "RAFIKICODE_API_KEY",
    // Overrides the gateway base URL, used for local mocks and staging.
    gatewayURL: "RAFIKICODE_GATEWAY_URL",
  },
  gateway: { url: gatewayDefault },
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
  // Gateway base URL, honoring the override env var.
  gatewayURL() {
    return process.env[Brand.env.gatewayURL] || gatewayDefault
  },
  // Config directory. An explicit XDG_CONFIG_HOME wins so isolated test and CI
  // environments keep working; otherwise the brief's ~/.rafikicode.
  configDir(home: string = process.env["OPENCODE_TEST_HOME"] ?? os.homedir()) {
    const xdg = process.env["XDG_CONFIG_HOME"]
    if (xdg) return path.join(xdg, Brand.dir)
    return path.join(home, Brand.configDirName)
  },
  // True when a gateway credential is available to this process.
  hasKey() {
    return Boolean(process.env[Brand.env.apiKey])
  },
  // Built in defaults seeded under the user's global config. Anything the user
  // writes to ~/.rafikicode/config.json or a project config overrides these.
  // The gateway provider is only registered once a credential exists, so an
  // unauthenticated install behaves like upstream until rafikicode login runs.
  config() {
    return {
      autoupdate: false as const,
      ...(Brand.hasKey() ? { provider: Brand.provider.config() } : {}),
    }
  },
  provider: {
    id: providerID,
    name: "Rafiki",
    config() {
      return {
        [providerID]: {
          name: Brand.provider.name,
          npm: "@ai-sdk/openai-compatible",
          env: [Brand.env.apiKey],
          options: { baseURL: Brand.gatewayURL() },
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
