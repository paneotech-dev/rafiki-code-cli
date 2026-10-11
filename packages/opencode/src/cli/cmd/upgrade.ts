import { Brand } from "@opencode-ai/core/brand/brand"
import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { RafikiUpdate } from "@/rafiki/update"
import { RafikiAutoupdate } from "@/rafiki/autoupdate"
import semver from "semver"

// What `upgrade` decides before it installs anything, kept apart from the
// prompts so the tests can drive it with a stubbed release list.
export type Plan =
  | { kind: "install"; target: string; notes: string[] }
  | { kind: "stop"; lines: string[]; level: "warn" | "error" | "info"; exitCode?: number }

// npm, Homebrew and winget publish stable releases only.
function onlyInstaller(method: Installation.Method, version: string | undefined, platform: NodeJS.Platform) {
  const name = method === "unknown" ? "this installation" : method
  const install = Brand.release.installCommand(version ?? "<version>", platform)
  return [
    `Pre-releases are published only through the installer script; ${name} has stable releases only.`,
    version ? `To install ${version}, run: ${install}` : `To install a pre-release, run: ${install}`,
  ]
}

export async function plan(input: {
  current: string
  method: Installation.Method
  target?: string
  pre?: boolean
  channel: RafikiUpdate.Channel
  platform?: NodeJS.Platform
  // The newest version on the method's registry for a channel.
  latest: (channel: RafikiUpdate.Channel) => Promise<string>
  // The newest release of all, pre-releases included (the installer's feed).
  newest: () => Promise<string | undefined>
}): Promise<Plan> {
  const platform = input.platform ?? process.platform
  // An explicit version is installed as asked, whatever the channel.
  if (input.target) {
    const target = input.target.replace(/^v/, "")
    if (target === input.current)
      return { kind: "stop", level: "warn", lines: [`${Brand.name} upgrade skipped: ${target} is already installed`] }
    if (RafikiUpdate.isPrerelease(target) && !Installation.hasPrereleases(input.method))
      return { kind: "stop", level: "warn", lines: onlyInstaller(input.method, target, platform), exitCode: 1 }
    return { kind: "install", target, notes: [] }
  }
  const channel: RafikiUpdate.Channel = input.pre ? "pre" : input.channel
  const notes: string[] = []
  if (channel === "pre" && !Installation.hasPrereleases(input.method)) {
    const version = await input.newest().catch(() => undefined)
    const lines = onlyInstaller(input.method, version, platform)
    // Asked for by name: nothing more to do. Asked for by the channel
    // setting: say so, then update on the stable releases this method has.
    if (input.pre) return { kind: "stop", level: "warn", lines, exitCode: 1 }
    notes.push(...lines)
  }
  const target = await input.latest(Installation.hasPrereleases(input.method) ? channel : "stable")
  const current = semver.valid(input.current)
  const valid = semver.valid(target)
  if (target === input.current || (current && valid && semver.lte(valid, current))) {
    const lines = [
      target === input.current
        ? `${Brand.name} upgrade skipped: ${target} is already installed`
        : `${Brand.name} upgrade skipped: ${input.current} is newer than the latest ${channel === "pre" ? "release" : "stable release"}, ${target}`,
    ]
    if (channel === "stable") {
      // The stable feed never names a pre-release, so a tester on a stable
      // copy would never hear of one: say it in one line, with the command.
      const newest = await input.newest().catch(() => undefined)
      if (newest && current && semver.gt(newest, current) && RafikiUpdate.isPrerelease(newest)) {
        lines.push(
          Installation.hasPrereleases(input.method)
            ? `A newer pre-release, ${newest}, is available: ${Brand.name} upgrade --pre`
            : `A newer pre-release, ${newest}, is available through the installer script: ${Brand.release.installCommand(newest, platform)}`,
        )
      }
    }
    return { kind: "stop", level: "warn", lines: [...notes, ...lines] }
  }
  return { kind: "install", target, notes }
}

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
      .option("pre", {
        alias: "prerelease",
        describe: "upgrade to the newest release, pre-releases included",
        type: "boolean",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        // The installer script (curl) and the package managers in
        // Brand.packageManagers, and nothing else. choco and scoop are not
        // offered, for the reason npm, pnpm and bun were not while nothing was
        // published there: a choice on this list is a promise that the method
        // works. Naming one is rejected here with the list of what does. A copy
        // that Installation.method() detects as installed by either still gets
        // Brand.unpublishedHint's refusal from Installation.upgrade.
        choices: ["curl", "npm", "pnpm", "bun", "brew", "winget"],
      })
  },
  handler: async (args: { target?: string; method?: string; pre?: boolean }) => {
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
    const decided = await plan({
      current: InstallationVersion,
      method,
      target: args.target,
      pre: args.pre,
      channel: RafikiUpdate.channel(),
      latest: (channel) => Installation.latest(method, channel),
      newest: () => RafikiUpdate.newest(),
    })
    if (decided.kind === "stop") {
      for (const line of decided.lines) prompts.log[decided.level](line)
      if (decided.exitCode) process.exitCode = decided.exitCode
      prompts.outro("Done")
      return
    }
    for (const line of decided.notes) prompts.log.warn(line)
    const target = decided.target

    prompts.log.info(`From ${InstallationVersion} to ${target}`)
    // Nothing is installed from a run from source, by any method.
    if (RafikiUpdate.refusedSourceRun((line) => prompts.log.error(line))) return prompts.outro("Done")
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
    // A release the daily check had downloaded is now behind or beside the
    // point; it must not be installed over this one at the next start.
    RafikiAutoupdate.discard()
    spinner.stop("Upgrade complete")
    prompts.outro("Done")
  },
}
