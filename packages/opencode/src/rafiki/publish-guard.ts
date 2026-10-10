// The question the shell tool asks before a command that publishes code
// (core/brand/publish.ts): a push, a new repository, a pull request, a
// release. It is a permission of its own, "publish", which the permission
// service asks every time (src/permission/index.ts), so an allowed shell or
// an earlier "always" never lets a push through unseen.
import { spawnSync } from "child_process"
import * as Publish from "@opencode-ai/core/brand/publish"

// The configured value of a git alias in `cwd`, or undefined.
export function gitAlias(cwd: string) {
  const cache = new Map<string, string | undefined>()
  return (name: string) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return undefined
    if (cache.has(name)) return cache.get(name)
    let value: string | undefined
    try {
      const result = spawnSync("git", ["config", "--get", `alias.${name}`], { cwd, encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] })
      value = result.status === 0 ? result.stdout.trim() || undefined : undefined
    } catch {
      value = undefined
    }
    cache.set(name, value)
    return value
  }
}

// Every publish in `command`, also looking at each simple command the shell
// parser found (`parts`), one finding per kind.
export function findings(command: string, parts: Iterable<string>, cwd: string) {
  const lookup = gitAlias(cwd)
  const all = [command, ...parts].flatMap((text) => Publish.detect(text, lookup))
  const seen = new Set<string>()
  return all.filter((item) => {
    const key = `${item.what}\u0000${item.command}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// The permission request for them, or undefined when there is none.
export function request(command: string, parts: Iterable<string>, cwd: string) {
  const found = findings(command, parts, cwd)
  if (!found.length) return undefined
  const what = Array.from(new Set(found.map((item) => item.what)))
  return {
    permission: Publish.PERMISSION,
    patterns: [command],
    // Never remembered: every push is asked again.
    always: [] as string[],
    metadata: {
      command,
      publish: what,
      directory: cwd,
    },
  }
}
