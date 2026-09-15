// The PATH entry install/install.sh (add_to_path) writes into a shell startup
// file, and its exact removal on uninstall. The installer appends a blank
// line, "# rafikicode" and one command for the bin directory; only lines that
// match those exactly are removed, nothing else in the file changes.
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"

export function marker() {
  return `# ${Brand.name}`
}

// The commands install.sh writes for a bin directory: sh family and fish.
export function commands(dir: string) {
  return [`export PATH=${dir}:$PATH`, `fish_add_path ${dir}`]
}

// Every startup file install.sh may edit, whatever the shell was.
export function candidates(env: Record<string, string | undefined> = process.env, home = os.homedir()) {
  const xdg = env["XDG_CONFIG_HOME"] || path.join(home, ".config")
  const zdot = env["ZDOTDIR"] || home
  return [
    ...new Set([
      path.join(home, ".config", "fish", "config.fish"),
      path.join(zdot, ".zshrc"),
      path.join(zdot, ".zshenv"),
      path.join(xdg, "zsh", ".zshrc"),
      path.join(xdg, "zsh", ".zshenv"),
      path.join(home, ".bashrc"),
      path.join(home, ".bash_profile"),
      path.join(home, ".profile"),
      path.join(xdg, "bash", ".bashrc"),
      path.join(xdg, "bash", ".bash_profile"),
      path.join(home, ".ashrc"),
    ]),
  ]
}

// Removes the installer's command for dir, with the marker and blank line
// written just above it.
export function clean(content: string, dir: string) {
  const wanted = new Set(commands(dir))
  const kept: string[] = []
  let changed = false
  for (const line of content.split("\n")) {
    if (!wanted.has(line)) {
      kept.push(line)
      continue
    }
    changed = true
    if (kept.at(-1) === marker()) {
      kept.pop()
      if (kept.at(-1) === "") kept.pop()
    }
  }
  return { content: kept.join("\n"), changed }
}

// The startup files holding the installer's PATH entry for dir.
export async function configsWithPath(dir: string, env: Record<string, string | undefined> = process.env, home = os.homedir()) {
  const found: string[] = []
  for (const file of candidates(env, home)) {
    const content = await fs.readFile(file, "utf8").catch(() => undefined)
    if (content !== undefined && clean(content, dir).changed) found.push(file)
  }
  return found
}

export async function cleanFile(file: string, dir: string) {
  const result = clean(await fs.readFile(file, "utf8"), dir)
  if (result.changed) await fs.writeFile(file, result.content)
  return result.changed
}
