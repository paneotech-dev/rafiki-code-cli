#!/usr/bin/env node
// Documentation checker for the user facing Markdown of this repository.
// Checks: every relative link resolves to a file, every fenced code block
// declares a language, no long dashes (U+2013, U+2014), and the upstream
// project name appears only in the README attribution section or inside code
// spans (file names, environment variables and package names that must keep
// their upstream spelling). Public wording: the phrases in BANNED must not
// appear in prose (text outside fenced blocks and code spans, so exact command
// output can still be quoted). The public docs describe the released version
// only, in the product's own terms.
//
// Usage: node docs/check.mjs [files...]
// Default: README.md and every Markdown file under docs/.
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const args = process.argv.slice(2)
const files = args.length
  ? args
  : ["README.md", ...markdown("docs")]

function markdown(dir) {
  return fs
    .readdirSync(path.join(root, dir), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = path.join(dir, entry.name)
      if (entry.isDirectory()) return markdown(rel)
      return entry.name.endsWith(".md") ? [rel] : []
    })
}

const upstream = "opencode"
// Phrases the public docs must not use in prose, matched without regard to case.
export const BANNED = [
  { pattern: /coming soon/i, label: "coming soon" },
  { pattern: /not available/i, label: "not available" },
  { pattern: /\bpreviews?\b/i, label: "preview" },
  { pattern: /roadmap/i, label: "roadmap" },
  { pattern: /next release/i, label: "next release" },
  { pattern: /rafiki\s+console/i, label: "Rafiki Console (write: the Rafiki AI console)" },
  { pattern: /wallet/i, label: "wallet (write: credits in your Rafiki AI account)" },
]
const problems = []

for (const rel of files) {
  const file = path.resolve(root, rel)
  const text = fs.readFileSync(file, "utf8")
  const lines = text.split("\n")
  let inFence = false
  let attribution = false
  lines.forEach((line, i) => {
    const no = i + 1
    if (/[\u2013\u2014]/.test(line)) problems.push(`${rel}:${no} long dash`)
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
    for (const banned of BANNED) {
      if (banned.pattern.test(prose)) problems.push(`${rel}:${no} banned phrase: ${banned.label}`)
    }
  })
  if (inFence) problems.push(`${rel}: unclosed fenced block`)
}

if (problems.length) {
  for (const p of problems) console.error(p)
  console.error(`${problems.length} problem(s) in ${files.length} file(s)`)
  process.exit(1)
}
console.log(`docs check passed: ${files.length} file(s), no problems`)
