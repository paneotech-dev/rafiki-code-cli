import { Brand } from "@opencode-ai/core/brand/brand"
import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { RafikiUpdate } from "@/rafiki/update"

export const UpgradeCommand = {
  command: "upgrade [target]",
  aliases: ["update"],
  describe: `upgrade ${Brand.name} to the latest or a specific version (alias: update)`,
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        // npm, pnpm and bun are deliberately not offered. registry.npmjs.org
        // answers 404 for the name in Brand.npm, so `--method npm` would run
        // `npm install -g` against a package that does not exist and fail with
        // the registry's own message; this help text was the last place a user
        // could read "npm" and believe it was a way to upgrade. brew, choco and
        // scoop stay: they are methods Installation.method() detects, and
        // naming one gets Brand.unpublishedHint's refusal, which says what to
        // use instead. Installation.Method and the npm branch of
        // Installation.upgrade are untouched, because publishing is intended
        // (script/publish-npm.ts, dry run by the release workflow); add the
        // three names back here when a publish actually lands.
        choices: ["curl", "brew", "choco", "scoop"],
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    if (RafikiUpdate.refusedOverride((line) => prompts.log.error(line))) return prompts.outro("Done")
    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod
    if (method === "unknown") {
      prompts.log.error(`${Brand.name} is installed to ${process.execPath} and may be managed by a package manager`)
      const install = await prompts.select({
        message: "Install anyways?",
        options: [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ],
        initialValue: false,
      })
      if (!install) {
        prompts.outro("Done")
        return
      }
    }
    prompts.log.info("Using method: " + method)
    const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest()

    if (InstallationVersion === target) {
      prompts.log.warn(`${Brand.name} upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${InstallationVersion} to ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade failed", 1)
      if (err instanceof Installation.UpgradeFailedError) {
        // necessary because choco only allows install/upgrade in elevated terminals
        if (method === "choco" && err.stderr.includes("not running from an elevated command shell")) {
          prompts.log.error("Please run the terminal as Administrator and try again")
        } else {
          prompts.log.error(err.stderr)
        }
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Upgrade complete")
    prompts.outro("Done")
  },
}
