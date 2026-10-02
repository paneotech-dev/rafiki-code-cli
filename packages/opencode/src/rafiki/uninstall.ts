// The uninstall command of this product. It replaces the upstream command in
// src/cli/cmd/uninstall.ts, which is kept as upstream wrote it and is not
// registered (src/index.ts registers this one). What differs: the binary is
// removed only when it is a compiled one, the PATH lines and the links the
// installer made are removed exactly (rafiki/shell-path.ts), and only the
// package managers this product is published through are called, by this
// product's own identifiers.
import { Brand } from "@opencode-ai/core/brand/brand"
import { RafikiUpdate } from "@/rafiki/update"
import type { Argv } from "yargs"
import { UI } from "@/cli/ui"
import * as prompts from "@clack/prompts"
import { Installation } from "@/installation"
import { Global } from "@opencode-ai/core/global"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Process } from "@/util/process"
import { existsSync } from "fs"
import * as RafikiShell from "@/rafiki/shell-path"

interface UninstallArgs {
  keepConfig: boolean
  keepData: boolean
  dryRun: boolean
  force: boolean
}

interface RemovalTargets {
  directories: Array<{ path: string; label: string; keep: boolean }>
  shellConfigs: string[]
  // Symlinks on PATH that point at the binary below, and nothing else.
  links: string[]
  binary: string | null
}

export const UninstallCommand = {
  command: "uninstall",
  describe: `uninstall ${Brand.name} and remove all related files`,
  builder: (yargs: Argv) =>
    yargs
      .option("keep-config", {
        alias: "c",
        type: "boolean",
        describe: "keep configuration files",
        default: false,
      })
      .option("keep-data", {
        alias: "d",
        type: "boolean",
        describe: "keep session data and snapshots",
        default: false,
      })
      .option("dry-run", {
        type: "boolean",
        describe: "show what would be removed without removing",
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "skip confirmation prompts",
        default: false,
      }),

  handler: async (args: UninstallArgs) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro(`Uninstall ${Brand.product}`)

    const method = await Installation.method()
    prompts.log.info(`Installation method: ${method}`)

    const targets = await collectRemovalTargets(args, method)

    await showRemovalSummary(targets, method)

    if (!args.force && !args.dryRun) {
      const confirm = await prompts.confirm({
        message: "Are you sure you want to uninstall?",
        initialValue: false,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro("Cancelled")
        return
      }
    }

    if (args.dryRun) {
      prompts.log.warn("Dry run - no changes made")
      prompts.outro("Done")
      return
    }

    await executeUninstall(method, targets)

    prompts.outro("Done")
  },
}

async function collectRemovalTargets(args: UninstallArgs, method: Installation.Method): Promise<RemovalTargets> {
  const directories: RemovalTargets["directories"] = [
    { path: Global.Path.data, label: "Data", keep: args.keepData },
    { path: Global.Path.cache, label: "Cache", keep: false },
    { path: Global.Path.config, label: "Config", keep: args.keepConfig },
    { path: Global.Path.state, label: "State", keep: false },
  ]

  // Only a compiled binary is removed. Run from source, process.execPath is
  // the runtime, which is not this product's to delete.
  const binary = method === "curl" && RafikiUpdate.running().compiled ? process.execPath : null
  const shellConfigs = binary ? await RafikiShell.configsWithPath(path.dirname(binary)) : []
  const links = binary ? await RafikiShell.ownedLinks(binary) : []

  return { directories, shellConfigs, links, binary }
}

async function showRemovalSummary(targets: RemovalTargets, method: Installation.Method) {
  prompts.log.message("The following will be removed:")

  for (const dir of targets.directories) {
    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const size = await getDirectorySize(dir.path)
    const sizeStr = formatSize(size)
    const status = dir.keep ? UI.Style.TEXT_DIM + "(keeping)" : ""
    const prefix = dir.keep ? "○" : "✓"

    prompts.log.info(`  ${prefix} ${dir.label}: ${shortenPath(dir.path)} ${UI.Style.TEXT_DIM}(${sizeStr})${status}`)
  }

  if (targets.binary) {
    prompts.log.info(`  ✓ Binary: ${shortenPath(targets.binary)}`)
  }

  for (const file of targets.shellConfigs) {
    prompts.log.info(`  ✓ Shell PATH in ${shortenPath(file)}`)
  }

  for (const link of targets.links) {
    prompts.log.info(`  ✓ Link on PATH: ${shortenPath(link)}`)
  }

  if (method !== "curl" && method !== "unknown") {
    const cmds: Record<string, string> = {
      npm: `npm uninstall -g ${Brand.npm.meta}`,
      pnpm: `pnpm uninstall -g ${Brand.npm.meta}`,
      bun: `bun remove -g ${Brand.npm.meta}`,
      yarn: `yarn global remove ${Brand.npm.meta}`,
      brew: `brew uninstall ${Brand.brew.formula}`,
      winget: `winget uninstall --id ${Brand.winget.id} --exact`,
    }
    if (cmds[method]) prompts.log.info(`  ✓ Package: ${cmds[method]}`)
  }
}

async function executeUninstall(method: Installation.Method, targets: RemovalTargets) {
  const spinner = prompts.spinner()
  const errors: string[] = []

  for (const dir of targets.directories) {
    if (dir.keep) {
      prompts.log.step(`Skipping ${dir.label} (--keep-${dir.label.toLowerCase()})`)
      continue
    }

    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    spinner.start(`Removing ${dir.label}...`)
    const err = await fs.rm(dir.path, { recursive: true, force: true }).catch((e) => e)
    if (err) {
      spinner.stop(`Failed to remove ${dir.label}`, 1)
      errors.push(`${dir.label}: ${err.message}`)
      continue
    }
    spinner.stop(`Removed ${dir.label}`)
  }

  for (const file of targets.binary ? targets.shellConfigs : []) {
    spinner.start(`Removing the PATH line from ${shortenPath(file)}...`)
    const err = await RafikiShell.cleanFile(file, path.dirname(targets.binary!)).then(
      () => undefined,
      (e) => e,
    )
    if (err) {
      spinner.stop("Failed to clean shell config", 1)
      errors.push(`Shell config: ${err.message}`)
    } else {
      spinner.stop("Cleaned shell config")
    }
  }

  /*
   * The installer's symlink from a directory on PATH. Left behind it becomes a
   * dangling link: the bare name still resolves and the shell reports an opaque
   * OS error instead of "command not found". Removed the same way the PATH
   * lines are: RafikiShell.removeLink checks again, at the moment of removal,
   * that the name is still a symlink to this binary, so a regular file or a
   * link someone else owns is never touched.
   */
  for (const link of targets.binary ? targets.links : []) {
    spinner.start(`Removing the link ${shortenPath(link)}...`)
    const removed = await RafikiShell.removeLink(link, targets.binary!).then(
      (done) => done,
      (e) => e as Error,
    )
    if (removed instanceof Error) {
      spinner.stop(`Failed to remove ${shortenPath(link)}`, 1)
      errors.push(`Link ${shortenPath(link)}: ${removed.message}. Remove it with: rm "${link}"`)
      continue
    }
    if (!removed) {
      spinner.stop(`Left ${shortenPath(link)} alone: it is no longer a link to ${shortenPath(targets.binary!)}`)
      continue
    }
    spinner.stop(`Removed the link ${shortenPath(link)}`)
  }

  if (method !== "curl" && method !== "unknown") {
    /*
     * Only the package managers this product is published through, and only
     * by this product's own identifiers: the formula of its tap by full name
     * and its winget id. A bare `brew uninstall <name>` or `choco uninstall`
     * here could remove the upstream project's package of the same name,
     * which is someone else's software and was never what the user installed.
     */
    const cmds: Record<string, string[]> = {
      npm: ["npm", "uninstall", "-g", Brand.npm.meta],
      pnpm: ["pnpm", "uninstall", "-g", Brand.npm.meta],
      bun: ["bun", "remove", "-g", Brand.npm.meta],
      yarn: ["yarn", "global", "remove", Brand.npm.meta],
      brew: ["brew", "uninstall", Brand.brew.formula],
      winget: ["winget", "uninstall", "--id", Brand.winget.id, "--exact"],
    }

    const cmd = cmds[method]
    if (cmd) {
      spinner.start(`Running ${cmd.join(" ")}...`)
      // No special case for choco: it is not a channel this product publishes
      // through, so it never reaches here and its command must not be built.
      const result = await Process.run(cmd, { nothrow: true })
      if (result.code !== 0) {
        spinner.stop(`Package manager uninstall failed: exit code ${result.code}`, 1)
        prompts.log.warn(`You may need to run manually: ${cmd.join(" ")}`)
      } else {
        spinner.stop("Package removed")
      }
    }
  }

  if (method === "curl" && targets.binary) {
    UI.empty()
    if (!existsSync(targets.binary)) {
      prompts.log.message(`Removed the binary ${shortenPath(targets.binary)}.`)
    } else {
      prompts.log.message("To finish removing the binary, run:")
      prompts.log.info(`  rm "${targets.binary}"`)
      const binDir = path.dirname(targets.binary)
      if (binDir.includes(Brand.configDirName)) {
        prompts.log.info(`  rmdir "${binDir}" 2>/dev/null`)
      }
    }
  }

  if (errors.length > 0) {
    UI.empty()
    prompts.log.warn("Some operations failed:")
    for (const err of errors) {
      prompts.log.error(`  ${err}`)
    }
  }

  UI.empty()
  prompts.log.success(`Thank you for using ${Brand.product}!`)
}

async function getDirectorySize(dir: string): Promise<number> {
  let total = 0

  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) total += stat.size
      }
    }
  }

  await walk(dir)
  return total
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function shortenPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) {
    return p.replace(home, "~")
  }
  return p
}
