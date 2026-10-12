// Two sentences about the project, for the top of the sidebar of the
// terminal interface. Read from files only, never asked of a model:
//
//   1. the project memory, .rafiki/memory/project.md (memory.ts): its first
//      two sentences;
//   2. else the first paragraph of AGENTS.md, then of README.md, cut to two
//      sentences.
//
// Headings, badges, images, links' addresses, HTML and code are left out.
// A file that holds nothing but its heading does not count.
import fs from "fs"
import path from "path"
import * as Memory from "./memory"

// What the sidebar shows at most, so the block stays a few lines high.
export const MAX_LENGTH = 280

export interface About {
  text: string
  // The file the text comes from, relative to the project folder.
  source: string
}

function readFile(file: string) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 256 * 1024) return ""
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

// One line of Markdown as plain text; empty for a line that carries no prose.
function plain(line: string) {
  const text = line.trim()
  if (text === "" || /^#{1,6}\s/.test(text) || /^(---|\*\*\*|___)\s*$/.test(text) || /^\|/.test(text)) return ""
  if (/^<[^>]+>/.test(text) && !/[.!?]\s*$/.test(text.replace(/<[^>]*>/g, ""))) return ""
  return text
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^>\s?/, "")
    .replace(/^([-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

// The prose of a Markdown text as paragraphs: front matter, code fences and
// HTML comments are dropped; each list item stands as a sentence of its own.
export function paragraphs(markdown: string): string[] {
  const lines = markdown.replace(/^\uFEFF/, "").replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
    if (close > 0) lines.splice(0, close + 1)
  }
  const result: string[] = []
  let current: string[] = []
  let fence = false
  const flush = () => {
    if (current.length > 0) result.push(current.join(" "))
    current = []
  }
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      flush()
      continue
    }
    if (fence) continue
    const item = /^\s*([-*+]|\d+[.)])\s+/.test(line)
    const text = plain(line)
    if (!text) {
      flush()
      continue
    }
    // A list item ends with a stop, so it counts as a sentence.
    current.push(item && !/[.!?:]$/.test(text) ? text + "." : text)
  }
  flush()
  return result.filter((item) => /[\p{L}\p{N}]/u.test(item))
}

// The first `count` sentences of a text, at most `max` characters.
export function sentences(text: string, count = 2, max = MAX_LENGTH): string {
  const picked: string[] = []
  let buffer = ""
  // A stop followed by a space ends a sentence ("v1.2" does not), unless it
  // ends a short form such as "e.g.".
  for (const part of text.trim().split(/(?<=[.!?])\s+/)) {
    buffer = buffer ? `${buffer} ${part}` : part
    if (/(^|\s)(e\.g|i\.e|etc|vs|cf)\.$/i.test(buffer)) continue
    picked.push(buffer)
    buffer = ""
    if (picked.length === count) break
  }
  if (picked.length < count && buffer) picked.push(buffer)
  const joined = picked.join(" ").trim()
  if (joined.length <= max) return joined
  const cut = joined.slice(0, max - 1)
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).trimEnd() + "…"
}

// The sources in order, as file paths relative to the project folder.
export const SOURCES = [`${Memory.DIR_POSIX}/${Memory.SECTIONS.project.file}`, "AGENTS.md", "README.md"] as const

export function fromText(source: string, markdown: string): string {
  const list = paragraphs(markdown)
  if (list.length === 0) return ""
  // The memory file is short notes: its first two sentences, across items.
  if (source === SOURCES[0]) return sentences(list.join(" "))
  return sentences(list[0])
}

export function describe(project: string): About | undefined {
  for (const source of SOURCES) {
    const text = fromText(source, readFile(path.join(project, source)))
    if (text) return { text, source }
  }
  return undefined
}

// A signature of the source files (path, size and change time of each), so a
// caller can read them again only when one changed.
export function stamp(project: string): string {
  return SOURCES.map((source) => {
    try {
      const stat = fs.statSync(path.join(project, source))
      return `${source}:${stat.size}:${stat.mtimeMs}`
    } catch {
      return `${source}:-`
    }
  }).join("|")
}
