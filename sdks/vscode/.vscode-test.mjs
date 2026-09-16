import { defineConfig } from "@vscode/test-cli"

export default defineConfig({
  files: "out/test/suite/**/*.test.js",
  // Running as root in a container or CI needs --no-sandbox; other extensions stay off.
  launchArgs: ["--disable-extensions", "--disable-workspace-trust", "--no-sandbox", "--disable-gpu"],
  mocha: { timeout: 60000 },
})
