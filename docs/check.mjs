#!/usr/bin/env node
// Documentation checker for the user facing Markdown of this repository.
// Checks: every relative link resolves to a file, every fenced code block
// declares a language, no long dashes (U+2013, U+2014), and the upstream
// project name appears only in the README attribution section or inside code
// spans (file names, environment variables and package names that must keep
// their upstream spelling).
//
// Usage: node docs/check.mjs [files...]   (default: README.md and docs/*.md)
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const args = process.argv.slice(2)
const files = args.length
  ? args
  : ["README.md", ...fs.readdirSync(path.join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => path.join("docs", f))]

const upstream = "opencode"
const problems = []

for (const rel of files) {
  const file = path.join(root, rel)
  const text = fs.readFileSync(file, "utf8")
  const lines = text.split("\n")
  let inFence = false
  let attribution = false
  lines.forEach((line, i) => {
    const no = i + 1
    if (/[–—]/.test(line)) problems.push(`${rel}:${no} long dash`)
    const fence = line.match(/^\s*(```|~~~)(.*)$/)
    if (fence) {
      if (!inFence) {
        inFence = true
        if (!fence[2].trim()) problems.push(`${rel}:${no} fenced block without a language`)
      } else {
        inFence = false
      }
      return
    }
    if (inFence) return
    if (/^##?\s+Attribution/i.test(line)) attribution = true
    else if (/^##?\s+/.test(line)) attribution = false
    // Relative links: [text](target) where target is not a URL or an anchor only.
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1]
      if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue
      const [p, anchor] = target.split("#")
      const resolved = path.resolve(path.dirname(file), p)
      if (!fs.existsSync(resolved)) problems.push(`${rel}:${no} broken link ${target}`)
      else if (anchor && resolved.endsWith(".md")) {
        const heads = fs
          .readFileSync(resolved, "utf8")
          .split("\n")
          .filter((l) => /^#+\s/.test(l))
          .map((l) => l.replace(/^#+\s+/, "").toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-"))
        if (!heads.includes(anchor)) problems.push(`${rel}:${no} missing anchor ${target}`)
      }
    }
    // Upstream name outside code spans and the attribution section.
    const prose = line.replace(/`[^`]*`/g, "")
    if (!attribution && prose.toLowerCase().includes(upstream)) problems.push(`${rel}:${no} upstream name in prose`)
  })
  if (inFence) problems.push(`${rel}: unclosed fenced block`)
}

if (problems.length) {
  for (const p of problems) console.error(p)
  console.error(`${problems.length} problem(s) in ${files.length} file(s)`)
  process.exit(1)
}
console.log(`docs check passed: ${files.length} file(s), no problems`)
