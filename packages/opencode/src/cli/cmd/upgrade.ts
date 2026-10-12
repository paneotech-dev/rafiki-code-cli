import { Brand } from "@opencode-ai/core/brand/brand"
import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { RafikiUpdate } from "@/rafiki/update"
import { RafikiAutoupdate } from "@/rafiki/autoupdate"
import { RafikiChannels } from "@/rafiki/channels"
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
  // For npm, Homebrew and winget: the version that package manager offers
  // now (npm view, brew info, winget show), undefined when it cannot be read,
  // and the newest stable release on GitHub. Those channels are published
  // only when their tokens are set, so they can be behind GitHub.
  offered?: () => Promise<string | undefined>
  github?: () => Promise<string | undefined>
}): Promise<Plan> {
  const platform = input.platform ?? process.platform
  const managed = RafikiChannels.isManager(input.method) && !!input.offered
  const name = RafikiChannels.label(input.method)
  // An explicit version is installed as asked, whatever the channel.
  if (input.target) {
    const target = input.target.replace(/^v/, "")
    if (target === input.current)
      return { kind: "stop", level: "warn", lines: [`${Brand.name} upgrade skipped: ${target} is already installed`] }
    if (RafikiUpdate.isPrerelease(target) && !Installation.hasPrereleases(input.method))
      return { kind: "stop", level: "warn", lines: onlyInstaller(input.method, target, platform), exitCode: 1 }
    if (managed) {
      const offered = await input.offered!().catch(() => undefined)
      if (offered && semver.valid(target) && semver.gt(target, offered))
        return {
          kind: "stop",
          level: "warn",
          exitCode: 1,
          lines: [
            `${name} offers ${Brand.name} ${offered}; ${target} has not been published there.`,
            `To install ${target}, run: ${Brand.release.installCommand(target, platform)}`,
          ],
        }
    }
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
  const current = semver.valid(input.current)
  let target: string
  let github: string | undefined
  if (managed) {
    // The version is the one the package manager has, not GitHub's: asking
    // winget for a version it does not have fails, and `brew upgrade` with
    // nothing newer in the tap succeeds without changing anything.
    const offered = await input.offered!().catch(() => undefined)
    github = await (input.github ?? (() => input.latest("stable")))().catch(() => undefined)
    if (!offered) {
      if (input.method === "brew" || input.method === "winget") {
        const lines = [`Could not read the version ${name} offers for ${Brand.name}.`]
        lines.push(
          github
            ? `The newest release is ${github}. To install it, run: ${Brand.release.installCommand(github, platform)}`
            : `To install the newest release, run: ${Brand.release.installCommand("<version>", platform)}`,
        )
        return { kind: "stop", level: "warn", exitCode: 1, lines: [...notes, ...lines] }
      }
      target = await input.latest("stable")
    } else {
      target = offered
    }
    if (github && semver.valid(github) && semver.valid(target) && semver.gt(github, target)) {
      const behind = [
        `${name} offers ${Brand.name} ${target}, but the newest release is ${github}: it has not reached ${name} yet.`,
        `To install ${github}, run: ${Brand.release.installCommand(github, platform)}`,
      ]
      if (current && semver.valid(target) && semver.lte(target, current))
        return { kind: "stop", level: "warn", exitCode: 1, lines: [...notes, ...behind] }
      notes.push(...behind)
    }
  } else {
    target = await input.latest(Installation.hasPrereleases(input.method) ? channel : "stable")
  }
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

export type Verified = {
  // "unchanged": the command succeeded and the copy still reports the old
  // version. "unknown": no copy could be asked.
  status: "changed" | "unchanged" | "unknown"
  version?: string
  // What to say first, then the copy a new shell runs when it is another one.
  lines: string[]
  shadow: string[]
}

// After an upgrade: the version the updated copy reports, and which copy a new
// shell runs. "Upgrade complete" is printed only when the version changed.
export async function verify(input: {
  method: Installation.Method
  target: string
  before: string
  execPath: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  run?: RafikiChannels.Run
}): Promise<Verified> {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const opts = { run: input.run, platform, env }
  const updated = await RafikiChannels.managedPath(input.method, { ...opts, execPath: input.execPath })
  const first = await RafikiChannels.newShell(opts)
  const file = updated ?? first ?? undefined
  const version = file ? await RafikiChannels.versionOf(file, opts) : undefined
  let shadow: string[] = []
  if (updated && !(first && RafikiChannels.sameFile(first, updated))) {
    const firstVersion = first ? await RafikiChannels.versionOf(first, opts) : undefined
    shadow = RafikiChannels.shadowLines({ first, updated, firstVersion, platform, env })
  }
  if (!file || !version)
    return {
      status: "unknown",
      lines: [`Could not run ${file ?? Brand.name} --version to confirm the installed version; open a new terminal and run ${Brand.name} --version.`],
      shadow,
    }
  if (version === input.before && input.before !== input.target) {
    const name = RafikiChannels.label(input.method)
    return {
      status: "unchanged",
      version,
      lines: [
        `${input.method === "curl" ? "The update" : name} finished, but ${file} still reports ${version}: nothing was upgraded.`,
        `To install ${input.target}, run: ${Brand.release.installCommand(input.target, platform)}`,
      ],
      shadow,
    }
  }
  return { status: "changed", version, lines: [], shadow }
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
      ...(RafikiChannels.isManager(method)
        ? {
            // Homebrew's copy of the tap is brought up to date first, as the
            // upgrade itself does; never from a run from source, which installs
            // nothing and must not touch a package manager.
            offered: () => {
              const run = RafikiUpdate.running()
              return RafikiChannels.offered(method, { refresh: !RafikiUpdate.refusal(run.execPath, run) })
            },
            github: () => RafikiUpdate.latestOf("stable"),
          }
        : {}),
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
      if (RafikiChannels.isManager(method))
        prompts.log.info(`To install ${target} with the installer instead, run: ${Brand.release.installCommand(target)}`)
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
    // A release the daily check had downloaded is now behind or beside the
    // point; it must not be installed over this one at the next start.
    RafikiAutoupdate.discard()
    const checked = await verify({
      method,
      target,
      before: InstallationVersion,
      execPath: RafikiUpdate.running().execPath,
    })
    if (checked.status === "unchanged") {
      spinner.stop("Upgrade did not change the installed version", 1)
      for (const line of checked.lines) prompts.log.error(line)
      process.exitCode = 1
    } else if (checked.status === "unknown") {
      spinner.stop(`Upgrade to ${target} finished`)
      for (const line of checked.lines) prompts.log.warn(line)
    } else {
      spinner.stop(`Upgrade complete: ${Brand.name} ${checked.version}`)
    }
    for (const line of checked.shadow) prompts.log.warn(line)
    prompts.outro("Done")
  },
}
