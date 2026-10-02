#!/usr/bin/env node
// Bookkeeping between this fork and the upstream project.
//
// script/upstream.json records the upstream commit of the last merge (the
// base), every upstream file this fork edits with the reason, and the upstream
// files this fork replaces with a module of its own. This script compares that
// record with the repository:
//
//   check           every edited upstream file is listed, every entry still
//                   matches an edit, every replaced file is identical to
//                   upstream, and the table in docs/upstream.md is current.
//                   Exit 1 when something is wrong. This is the default.
//   write           regenerate the table in docs/upstream.md.
//   report          print the number of edited upstream files and the changed
//                   lines. --at <commit> measures a commit instead of the
//                   working tree.
//   conflicts <ref> a trial merge of an upstream ref, in memory: the files
//                   that would conflict, grouped by class with the rule for
//                   each, the edited files upstream also changed that merge
//                   cleanly, the replaced files upstream changed, and the
//                   workflows upstream added. No branch and no file changes.
//
// "Upstream file" means a file that exists in the base commit. "Edited" means
// it differs here: modified, renamed, deleted or changed in type. Files that
// exist only in this fork are not counted.
//
// Usage: node script/upstream.mjs [check|write|report|conflicts <ref>] [--root <dir>] [--at <commit>]
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const MANIFEST = "script/upstream.json"
export const PAGE = "docs/upstream.md"
const START = "<!-- upstream-files:start -->"
const END = "<!-- upstream-files:end -->"

// The same diff on every machine: no user configuration decides how lines are
// counted or which files count as renamed.
const DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--diff-algorithm=myers", "-M50%", "-z"]
const EDITED = "--diff-filter=MRDT"

function git(root, args) {
  const result = spawnSync("git", ["-C", root, "-c", "core.quotepath=off", ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function must(root, args) {
  const result = git(root, args)
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.err.trim()}`)
  return result.out
}

export function load(root = defaultRoot) {
  return JSON.parse(fs.readFileSync(path.join(root, MANIFEST), "utf8"))
}

// True when this clone holds the base commit. A shallow clone does not, and
// nothing can be compared there.
export function available(root, base) {
  return git(root, ["cat-file", "-e", `${base}^{commit}`]).code === 0
}

const STATUS = { M: "modified", R: "renamed", D: "deleted", T: "type" }

// Every upstream file that differs from the base, with its line counts. The
// path is the upstream one; `to` is the name here when the file was renamed.
// `against` is a commit; without it the working tree is compared, so an edit
// counts before it is committed.
export function edits(root, base, against) {
  const range = against ? [base, against] : [base]
  const names = must(root, [...DIFF, EDITED, "--name-status", ...range, "--"]).split("\0")
  const files = []
  for (let i = 0; i < names.length - 1; ) {
    const status = STATUS[names[i][0]]
    if (!status) throw new Error(`unexpected status ${names[i]}`)
    if (status === "renamed") {
      files.push({ path: names[i + 1], to: names[i + 2], status })
      i += 3
      continue
    }
    files.push({ path: names[i + 1], status })
    i += 2
  }
  const counts = new Map()
  const stats = must(root, [...DIFF, EDITED, "--numstat", ...range, "--"]).split("\0")
  for (let i = 0; i < stats.length - 1; ) {
    const [added, removed, name] = stats[i].split("\t")
    const count = { added: added === "-" ? 0 : Number(added), removed: removed === "-" ? 0 : Number(removed), binary: added === "-" }
    if (name) {
      counts.set(name, count)
      i += 1
      continue
    }
    counts.set(stats[i + 1], count)
    i += 3
  }
  return files
    .map((file) => ({ ...file, ...(counts.get(file.path) ?? { added: 0, removed: 0, binary: false }) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

// An entry names one file, a directory (trailing "/") or a pattern in which
// "*" stands for any run of characters inside one path segment.
export function matcher(pattern) {
  if (pattern.endsWith("/")) return (file) => file.startsWith(pattern)
  if (!pattern.includes("*")) return (file) => file === pattern
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*")
  const expression = new RegExp(`^${source}$`)
  return (file) => expression.test(file)
}

// The record compared with the repository: each edited file with its entry,
// the totals, and everything that is wrong.
export function inspect(root = defaultRoot, options = {}) {
  const manifest = options.manifest ?? load(root)
  const problems = []
  const classes = manifest.classes ?? {}
  const entries = manifest.edited ?? []
  const replaced = manifest.replaced ?? []

  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry.path)) problems.push(`${MANIFEST}: ${entry.path} is listed twice`)
    seen.add(entry.path)
    if (!classes[entry.class]) problems.push(`${MANIFEST}: ${entry.path} has the unknown class "${entry.class}"`)
    if (typeof entry.why !== "string" || entry.why.trim().length < 10)
      problems.push(`${MANIFEST}: ${entry.path} does not say why it is edited`)
  }

  if (!options.against && git(root, ["merge-base", "--is-ancestor", manifest.base, "HEAD"]).code !== 0)
    problems.push(`${MANIFEST}: the base ${manifest.base} is not an ancestor of HEAD`)

  const matchers = entries.map((entry) => ({ entry, test: matcher(entry.path) }))
  const used = new Set()
  const files = edits(root, manifest.base, options.against).map((file) => {
    const hits = matchers.filter((item) => item.test(file.path))
    for (const hit of hits) used.add(hit.entry)
    if (hits.length === 0)
      problems.push(
        `not listed: ${file.path} (${file.status}, +${file.added} -${file.removed}). ` +
          `Move the change into this fork's own modules, or add the file to ${MANIFEST} with its reason.`,
      )
    if (hits.length > 1)
      problems.push(`${MANIFEST}: ${file.path} is covered by ${hits.length} entries (${hits.map((hit) => hit.entry.path).join(", ")})`)
    return { ...file, entry: hits[0]?.entry }
  })
  for (const entry of entries) {
    if (!used.has(entry)) problems.push(`${MANIFEST}: ${entry.path} is listed but no longer edited. Remove the entry.`)
  }

  for (const item of replaced) {
    if (typeof item.why !== "string" || item.why.trim().length < 10)
      problems.push(`${MANIFEST}: the replaced file ${item.path} does not say why it is replaced`)
    if (git(root, ["cat-file", "-e", `${manifest.base}:${item.path}`]).code !== 0) {
      problems.push(`${MANIFEST}: the replaced file ${item.path} does not exist upstream`)
      continue
    }
    if (files.some((file) => file.path === item.path))
      problems.push(
        `replaced file edited: ${item.path} must stay identical to upstream. Change ${item.by} instead, ` +
          `or restore it with: git checkout ${manifest.base.slice(0, 10)} -- ${item.path}`,
      )
    const present = options.against
      ? git(root, ["cat-file", "-e", `${options.against}:${item.by}`]).code === 0
      : fs.existsSync(path.join(root, item.by))
    if (!present) problems.push(`${MANIFEST}: ${item.by}, which replaces ${item.path}, does not exist`)
  }

  const totals = files.reduce(
    (sum, file) => ({ files: sum.files + 1, added: sum.added + file.added, removed: sum.removed + file.removed }),
    { files: 0, added: 0, removed: 0 },
  )
  return { manifest, files, replaced, problems, totals: { ...totals, lines: totals.added + totals.removed } }
}

const cell = (text) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim()

function shown(file) {
  if (file.status === "renamed") return `\`${file.path}\`, renamed to \`${file.to}\``
  if (file.status === "deleted") return `\`${file.path}\`, removed`
  return `\`${file.path}\``
}

// The generated part of docs/upstream.md, markers included.
export function table(inspection) {
  const { manifest, files, replaced, totals } = inspection
  const lines = [
    START,
    "",
    `Upstream base: \`${manifest.base.slice(0, 10)}\` (\`${manifest.version}\`). ` +
      `Upstream files edited: ${totals.files}. Changed lines: ${totals.lines} ` +
      `(${totals.added} added, ${totals.removed} removed).`,
    "",
    "| Class | Files | Added | Removed |",
    "| --- | ---: | ---: | ---: |",
  ]
  const groups = Object.entries(manifest.classes).map(([id, info]) => ({
    id,
    info,
    files: files.filter((file) => file.entry?.class === id),
  }))
  const unlisted = files.filter((file) => !file.entry || !manifest.classes[file.entry.class])
  const sum = (list, key) => list.reduce((total, file) => total + file[key], 0)
  for (const group of groups)
    lines.push(`| ${cell(group.info.title)} | ${group.files.length} | ${sum(group.files, "added")} | ${sum(group.files, "removed")} |`)
  if (unlisted.length)
    lines.push(`| Not listed | ${unlisted.length} | ${sum(unlisted, "added")} | ${sum(unlisted, "removed")} |`)
  lines.push(`| Total | ${totals.files} | ${totals.added} | ${totals.removed} |`)

  const rows = (list) => {
    lines.push("", "| File | Added | Removed | Why |", "| --- | ---: | ---: | --- |")
    for (const file of list) {
      const count = (value) => (file.binary ? "binary" : String(value))
      lines.push(`| ${shown(file)} | ${count(file.added)} | ${count(file.removed)} | ${cell(file.entry?.why ?? "Not listed.")} |`)
    }
  }
  for (const group of groups) {
    if (!group.files.length) continue
    lines.push("", `### ${group.info.title}`, "", `On a conflict: ${group.info.rule}`)
    rows(group.files)
  }
  if (unlisted.length) {
    lines.push("", "### Not listed")
    rows(unlisted)
  }

  lines.push("", "### Upstream files replaced by a module of this fork", "")
  if (replaced.length) {
    lines.push("| Upstream file | Replaced by | Why |", "| --- | --- | --- |")
    for (const item of replaced) lines.push(`| \`${item.path}\` | \`${item.by}\` | ${cell(item.why)} |`)
  } else lines.push("None.")
  lines.push("", END)
  return lines.join("\n")
}

function block(text) {
  const start = text.indexOf(START)
  const end = text.indexOf(END)
  if (start === -1 || end === -1 || end < start) return undefined
  return { start, end: end + END.length }
}

export function write(root = defaultRoot) {
  const file = path.join(root, PAGE)
  const text = fs.readFileSync(file, "utf8")
  const at = block(text)
  if (!at) throw new Error(`${PAGE} has no ${START} ... ${END} block`)
  const inspection = inspect(root)
  const next = text.slice(0, at.start) + table(inspection) + text.slice(at.end)
  if (next !== text) fs.writeFileSync(file, next)
  return { inspection, changed: next !== text }
}

export const summary = (inspection) =>
  `${inspection.totals.files} upstream files edited, ${inspection.totals.lines} changed lines ` +
  `(${inspection.totals.added} added, ${inspection.totals.removed} removed), ` +
  `base ${inspection.manifest.base.slice(0, 10)}`

// The whole check. `skipped` is set, with no problems, when the base commit is
// not in this clone.
export function check(root = defaultRoot) {
  const manifest = load(root)
  if (!available(root, manifest.base))
    return { problems: [], skipped: `the upstream base ${manifest.base.slice(0, 10)} is not in this clone (a shallow clone?)` }
  const inspection = inspect(root, { manifest })
  const problems = [...inspection.problems]
  const file = path.join(root, PAGE)
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  const at = block(text)
  if (!at) problems.push(`${PAGE}: the block ${START} ... ${END} is missing`)
  else if (text.slice(at.start, at.end) !== table(inspection))
    problems.push(`${PAGE}: the table of edited upstream files is out of date. Run: node script/upstream.mjs write`)
  return { problems, inspection }
}

// A trial merge of `ref` into HEAD that touches nothing: git merge-tree builds
// the result in the object store and names the files it could not merge.
export function conflicts(root, ref) {
  const manifest = load(root)
  const tip = must(root, ["rev-parse", "--verify", `${ref}^{commit}`]).trim()
  const mergeBase = must(root, ["merge-base", "HEAD", tip]).trim()
  const behind = Number(must(root, ["rev-list", "--count", `HEAD..${tip}`]).trim())

  const changed = new Map()
  const names = must(root, ["diff", "--no-renames", "--name-status", "-z", mergeBase, tip, "--"]).split("\0")
  for (let i = 0; i < names.length - 1; i += 2) changed.set(names[i + 1], names[i])

  const trial = git(root, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", "HEAD", tip])
  if (trial.code !== 0 && trial.code !== 1)
    throw new Error(`git merge-tree failed (git 2.38 or newer is needed): ${trial.err.trim()}`)
  const conflicted = trial.out.split("\0").slice(1).filter(Boolean)

  const inspection = inspect(root, { manifest })
  const entryOf = new Map()
  for (const file of inspection.files) {
    entryOf.set(file.path, file.entry)
    if (file.to) entryOf.set(file.to, file.entry)
  }
  const inBase = (file) => git(root, ["cat-file", "-e", `${manifest.base}:${file}`]).code === 0
  const groups = new Map()
  for (const file of conflicted) {
    const entry = entryOf.get(file)
    const id = entry?.class ?? (inBase(file) ? "unlisted" : "own")
    groups.set(id, [...(groups.get(id) ?? []), { file, why: entry?.why }])
  }

  const clean = inspection.files
    .filter((file) => changed.has(file.path) && !conflicted.includes(file.path) && !(file.to && conflicted.includes(file.to)))
    .map((file) => ({ file: file.path, class: file.entry?.class }))
  const replaced = inspection.replaced.filter((item) => changed.has(item.path))
  const workflows = [...changed].filter(([file, status]) => status === "A" && file.startsWith(".github/workflows/")).map(([file]) => file)

  return { manifest, tip, mergeBase, behind, changed: changed.size, conflicted, groups, clean, replaced, workflows }
}

function printConflicts(ref, result) {
  const out = []
  const { manifest } = result
  out.push(`Trial merge of ${ref} (${result.tip.slice(0, 10)}) into HEAD. Nothing was changed.`)
  out.push(`Merge base ${result.mergeBase.slice(0, 10)}, ${result.behind} upstream commits to merge, ${result.changed} files changed upstream.`)
  if (result.mergeBase !== manifest.base)
    out.push(`Note: the merge base is not the base in ${MANIFEST} (${manifest.base.slice(0, 10)}).`)
  out.push("")
  out.push(`Conflicts: ${result.conflicted.length} files`)
  const titles = {
    ...Object.fromEntries(Object.entries(manifest.classes).map(([id, info]) => [id, info])),
    unlisted: { title: "Upstream files with no listed edit", rule: "Not expected when the check passes. Resolve by hand and find out which side changed the file." },
    own: { title: "Files that exist only in this fork", rule: "Upstream added a file of the same name, or renamed one onto it. Resolve by hand." },
  }
  for (const [id, info] of Object.entries(titles)) {
    const list = result.groups.get(id)
    if (!list) continue
    out.push("", `${info.title} (${list.length})`, `  Rule: ${info.rule}`)
    for (const item of list) out.push(`  - ${item.file}${item.why ? `\n      ${item.why}` : ""}`)
  }
  out.push("", `Edited here, changed upstream, merged without a conflict: ${result.clean.length} files. Read each one: a clean merge can still change behaviour.`)
  for (const item of result.clean) out.push(`  - ${item.file} (${item.class ?? "not listed"})`)
  out.push("", `Replaced upstream files that upstream changed: ${result.replaced.length}. The change does not arrive by itself; read it and carry over what applies.`)
  for (const item of result.replaced)
    out.push(`  - ${item.path} (replaced by ${item.by})`, `      git diff ${result.mergeBase.slice(0, 10)} ${result.tip.slice(0, 10)} -- ${item.path}`)
  out.push("", `Workflows added upstream: ${result.workflows.length}. Each must stay inert in this repository.`)
  for (const file of result.workflows) out.push(`  - ${file}`)
  console.log(out.join("\n"))
}

function main(argv) {
  const args = [...argv]
  const take = (flag) => {
    const at = args.indexOf(flag)
    if (at === -1) return undefined
    const [, value] = args.splice(at, 2)
    if (!value) throw new Error(`${flag} needs a value`)
    return value
  }
  const root = path.resolve(take("--root") ?? defaultRoot)
  const against = take("--at")
  const [command = "check", ref] = args

  if (command === "check") {
    const result = check(root)
    if (result.skipped) return console.log(`upstream check skipped: ${result.skipped}`)
    if (result.problems.length) {
      for (const problem of result.problems) console.error(problem)
      console.error(`${result.problems.length} problem(s)`)
      process.exitCode = 1
      return
    }
    return console.log(`upstream check passed: ${summary(result.inspection)}`)
  }
  if (command === "write") {
    const result = write(root)
    for (const problem of result.inspection.problems) console.error(problem)
    console.log(`${PAGE} ${result.changed ? "updated" : "already current"}: ${summary(result.inspection)}`)
    if (result.inspection.problems.length) process.exitCode = 1
    return
  }
  if (command === "report") return console.log(summary(inspect(root, { against })))
  if (command === "conflicts") {
    if (!ref) throw new Error("conflicts needs an upstream ref, for example: conflicts upstream/dev")
    return printConflicts(ref, conflicts(root, ref))
  }
  throw new Error(`unknown command ${command}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}
