// What install/install.sh puts outside its own install directory, and its
// exact removal on uninstall: the PATH entry it writes into a shell startup
// file (add_to_path) and the symlink it drops into a directory already on PATH
// (link_into_path). The installer appends a blank line, "# rafikicode" and one
// command for the bin directory; only lines that match those exactly are
// removed, nothing else in the file changes.
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

// The symlink install/install.sh (link_into_path) drops into a directory that
// is already on PATH, so the bare name works in the terminal that ran the
// installer, and its exact removal on uninstall. Same discipline as the PATH
// lines above: only our own link is touched. A regular file at that name, or a
// symlink that points somewhere else, belongs to whoever put it there and is
// left alone -- otherwise uninstalling this product would take another
// program's command with it. Left behind, the link resolves to a binary that is
// gone, and the bare name answers with an opaque OS error instead of "command
// not found".
export function linkDirs(home = os.homedir()) {
  return ["/usr/local/bin", path.join(home, ".local", "bin")]
}

// Where the installer could have linked this binary from.
export function linkCandidates(binary: string, home = os.homedir()) {
  const name = path.basename(binary)
  return [...new Set(linkDirs(home).map((dir) => path.join(dir, name)))]
}

// True only for a symlink whose target is this binary. The binary is followed
// first: the running process may have been started through the link, so
// process.execPath can be either the link or the file it points at, and a link
// to either spelling is ours. The binary's own path is never treated as a link,
// so the file the rest of uninstall reports as the binary is never unlinked
// here.
export async function ownsLink(link: string, binary: string) {
  const real = await fs.realpath(binary).catch(() => binary)
  const targets = new Set([path.resolve(binary), path.resolve(real)])
  if (path.resolve(link) === path.resolve(binary)) return false
  const stat = await fs.lstat(link).catch(() => undefined)
  if (!stat || !stat.isSymbolicLink()) return false
  const target = await fs.readlink(link).catch(() => undefined)
  if (target === undefined) return false
  return targets.has(path.resolve(path.dirname(link), target))
}

// The links on PATH that point at this binary.
export async function ownedLinks(binary: string, home = os.homedir()) {
  const found: string[] = []
  for (const link of linkCandidates(binary, home)) {
    if (await ownsLink(link, binary)) found.push(link)
  }
  return found
}

// Removes link only if it is still our own; returns whether it was removed.
export async function removeLink(link: string, binary: string) {
  if (!(await ownsLink(link, binary))) return false
  await fs.unlink(link)
  return true
}
