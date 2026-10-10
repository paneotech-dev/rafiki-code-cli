// The search used when ripgrep cannot be found or fetched: no rg on PATH, none
// in the cache, and the download from GitHub refused (an offline machine, a
// proxy that only lets the gateway through). Without it the grep, glob and file
// search tools all failed with "ripgrep execution failed". It walks the folder
// itself and matches with JavaScript regular expressions, which take the
// patterns people and models write for ripgrep (character classes, \b, \d,
// alternation, anchors) the same way. It is slower than ripgrep and reads no
// .gitignore: it skips .git and node_modules and nothing else. One warning line
// says the fallback is in use, once per process.
import fs from "fs"
import path from "path"
import { warnOnce } from "./trust"

export const NOTICE =
  "Warning: ripgrep could not be found or downloaded, so searches use the built-in search: slower, and it does not read .gitignore. Install ripgrep (rg) to use it instead."

export function notice() {
  warnOnce("search-fallback", NOTICE)
}

const SKIP = new Set([".git", "node_modules"])
// Files larger than this are not searched: ripgrep would, but a pure
// JavaScript scan of a large binary or data file holds the turn up.
const MAX_FILE_BYTES = 8 * 1024 * 1024

export interface Options {
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
}

// A glob as ripgrep reads it: a pattern with no slash matches the file name at
// any depth, one with a slash matches the path from the search root. Supports
// *, **, ?, [...] and {a,b}; a leading ! negates.
export function globMatcher(glob: string): (relative: string) => boolean {
  const negated = glob.startsWith("!")
  const body = negated ? glob.slice(1) : glob
  const anchored = body.includes("/")
  const regex = new RegExp("^" + globToRegex(body.replace(/^\.\//, "").replace(/^\//, "")) + "$")
  return (relative) => {
    const hit = regex.test(anchored ? relative : path.posix.basename(relative))
    return negated ? !hit : hit
  }
}

function globToRegex(glob: string): string {
  let out = ""
  let depth = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/"
        out += slash ? "(?:.*/)?" : ".*"
        i += slash ? 2 : 1
        continue
      }
      out += "[^/]*"
      continue
    }
    if (c === "?") {
      out += "[^/]"
      continue
    }
    if (c === "[") {
      const end = glob.indexOf("]", i + 1)
      if (end > i) {
        const set = glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")
        out += `[${set}]`
        i = end
        continue
      }
    }
    if (c === "{") {
      depth++
      out += "(?:"
      continue
    }
    if (c === "}" && depth > 0) {
      depth--
      out += ")"
      continue
    }
    if (c === "," && depth > 0) {
      out += "|"
      continue
    }
    out += c.replace(/[.+^$()|\\\]]/g, "\\$&")
  }
  return out
}

// Every file under root, as paths relative to it with forward slashes, in a
// stable order, stopping once `limit` are found.
export function files(root: string, options: Options & { glob?: string; limit: number }): string[] {
  const match = options.glob ? globMatcher(options.glob) : undefined
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (dir: string, relative: string) => {
    if (out.length >= options.limit || options.signal?.aborted) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (out.length >= options.limit) return
      if (SKIP.has(entry.name)) continue
      if (!options.hidden && entry.name.startsWith(".")) continue
      const full = path.join(dir, entry.name)
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        if (!options.follow) continue
        try {
          const real = fs.realpathSync(full)
          if (seen.has(real)) continue
          seen.add(real)
          const stat = fs.statSync(full)
          isDir = stat.isDirectory()
          isFile = stat.isFile()
        } catch {
          continue
        }
      }
      if (isDir) walk(full, rel)
      else if (isFile && (!match || match(rel))) out.push(rel)
    }
  }
  walk(root, "")
  return out
}

export interface LineMatch {
  path: { text: string }
  lines: { text: string }
  line_number: number
  absolute_offset: number
  submatches: { match: { text: string }; start: number; end: number }[]
}

export class InvalidPattern extends Error {}

// Lines of the files under root (or of one file) that match pattern, in the
// shape ripgrep's --json match records have. Stops after limit + 1 matches so
// the caller can tell the result was cut.
export function grep(
  root: string,
  input: { pattern: string; file?: string; include?: string; limit: number; signal?: AbortSignal },
): LineMatch[] {
  let regex: RegExp
  try {
    regex = new RegExp(input.pattern, "gu")
  } catch {
    try {
      regex = new RegExp(input.pattern, "g")
    } catch (cause) {
      throw new InvalidPattern(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const target = input.file ? path.resolve(root, input.file) : root
  let list: string[]
  try {
    list = fs.statSync(target).isFile()
      ? [input.file!]
      : files(target, { hidden: true, glob: input.include, limit: Number.MAX_SAFE_INTEGER, signal: input.signal }).map(
          (rel) => (input.file ? `${input.file.replace(/[\\/]+$/, "")}/${rel}` : rel),
        )
  } catch {
    return []
  }
  const out: LineMatch[] = []
  for (const rel of list) {
    if (out.length > input.limit || input.signal?.aborted) break
    const full = path.resolve(root, rel)
    let buffer: Buffer
    try {
      if (fs.statSync(full).size > MAX_FILE_BYTES) continue
      buffer = fs.readFileSync(full)
    } catch {
      continue
    }
    // Binary files are skipped, as ripgrep does by default.
    if (buffer.subarray(0, 8000).includes(0)) continue
    const text = buffer.toString("utf8")
    let offset = 0
    let number = 0
    for (const raw of text.split("\n")) {
      number++
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
      regex.lastIndex = 0
      const submatches: LineMatch["submatches"] = []
      for (let m = regex.exec(line); m; m = regex.exec(line)) {
        if (m[0] === "") {
          regex.lastIndex++
          if (submatches.length === 0) submatches.push({ match: { text: "" }, start: m.index, end: m.index })
          if (regex.lastIndex > line.length) break
          continue
        }
        submatches.push({ match: { text: m[0] }, start: Buffer.byteLength(line.slice(0, m.index)), end: Buffer.byteLength(line.slice(0, m.index + m[0].length)) })
      }
      if (submatches.length > 0) {
        out.push({
          path: { text: rel.replaceAll("\\", "/") },
          lines: { text: raw + "\n" },
          line_number: number,
          absolute_offset: offset,
          submatches,
        })
        if (out.length > input.limit) break
      }
      offset += Buffer.byteLength(raw) + 1
    }
  }
  return out
}
