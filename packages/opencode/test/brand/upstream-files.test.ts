// The record of what this fork changes in upstream files (script/upstream.json,
// script/upstream.mjs, docs/upstream.md).
//
// An edit to an upstream file is what makes an upstream merge conflict, so
// each one is listed with its reason, and the list is generated into a table
// with line counts. Nothing else notices when the list goes stale: an edit
// that lands in an upstream file compiles and passes like any other. The
// first test here fails on it, on the working tree, before it is committed.
//
// The other tests drive the script against a small repository built for the
// purpose, so that each way the record can be wrong is shown to fail, and the
// trial merge is shown to classify and to change nothing.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

const root = path.resolve(import.meta.dir, "../../../..")
const script = path.join(root, "script", "upstream.mjs")
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-files-"))

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

function run(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["node", script, ...args, "--root", cwd], { cwd })
  return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd },
  )
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

describe("the record of edited upstream files", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "script", "upstream.json"), "utf8")) as {
    base: string
    classes: Record<string, { title: string; rule: string }>
    edited: Array<{ path: string; class: string; why: string }>
    replaced: Array<{ path: string; by: string; why: string }>
  }

  test(
    "every upstream file edited here is listed with its reason, and the table in docs/upstream.md is current",
    () => {
      const result = run(root)
      // A shallow clone has no upstream base to compare with. Anywhere else a
      // skipped check would be a check that never runs.
      if (result.out.includes("upstream check skipped")) {
        expect(git(root, "rev-parse", "--is-shallow-repository")).toBe("true")
        return
      }
      expect(result.out).toContain("upstream check passed")
      expect(result.code).toBe(0)
    },
    60_000,
  )

  test("every entry has a known class and says why", () => {
    expect(manifest.base).toMatch(/^[0-9a-f]{40}$/)
    expect(manifest.edited.length).toBeGreaterThan(50)
    for (const entry of manifest.edited) {
      expect(Object.keys(manifest.classes)).toContain(entry.class)
      expect(entry.why.length).toBeGreaterThan(10)
    }
    for (const info of Object.values(manifest.classes)) expect(info.rule.length).toBeGreaterThan(20)
  })

  // A replaced upstream file is kept as upstream wrote it, so it never
  // conflicts. That only holds while nothing loads it: the moment a source
  // imports it again, the upstream behaviour is back in the build.
  test("no source imports an upstream file this fork replaces", () => {
    expect(manifest.replaced.map((item) => item.path)).toContain("packages/opencode/src/cli/cmd/uninstall.ts")
    const sources = (dir: string): string[] =>
      fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
        const rel = path.posix.join(dir, entry.name)
        if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(rel)
        return /\.tsx?$/.test(entry.name) ? [rel] : []
      })
    const files = ["packages/opencode/src", "packages/tui/src", "packages/core/src"].flatMap((dir) => sources(dir))
    expect(files.length).toBeGreaterThan(500)
    const targets = new Map(manifest.replaced.map((item) => [item.path.replace(/\.tsx?$/, ""), item.path]))
    const found: string[] = []
    for (const file of files) {
      const text = fs.readFileSync(path.join(root, file), "utf8")
      for (const match of text.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
        const spec = match[1]!
        const resolved = spec.startsWith("@/")
          ? path.posix.join("packages/opencode/src", spec.slice(2))
          : spec.startsWith(".")
            ? path.posix.join(path.posix.dirname(file), spec)
            : undefined
        if (!resolved) continue
        const target = targets.get(resolved.replace(/\.tsx?$/, ""))
        if (target) found.push(`${file} imports ${target}`)
      }
    }
    expect(found).toEqual([])
    for (const item of manifest.replaced) expect(fs.existsSync(path.join(root, item.by))).toBe(true)
  })
})

describe("script/upstream.mjs on a small repository", () => {
  const repo = path.join(scratch, "repo")
  const put = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), text)
  }
  const page = "# Upstream\n\n<!-- upstream-files:start -->\n<!-- upstream-files:end -->\n"
  const classes = {
    hook: { title: "Source: a call", rule: "Take upstream's side, then put the call back." },
    docs: { title: "Documentation", rule: "Keep this fork's text." },
  }
  let base = ""
  const record = (extra: { edited?: object[]; replaced?: object[]; base?: string } = {}) =>
    put(
      "script/upstream.json",
      JSON.stringify({
        base: extra.base ?? base,
        version: "1.0.0",
        classes,
        edited: extra.edited ?? [{ path: "src/a.ts", class: "hook", why: "Calls the module of this fork." }],
        replaced: extra.replaced ?? [],
      }),
    )

  // Upstream: four files. The fork: one edit in src/a.ts, a module of its own.
  fs.mkdirSync(repo, { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  put("src/a.ts", "one\ntwo\nthree\n")
  put("src/b.ts", "b\n")
  put("src/c.ts", "c\n")
  put("README.fr.md", "bonjour\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "upstream")
  base = git(repo, "rev-parse", "HEAD")
  git(repo, "branch", "upstream")
  put("src/a.ts", "one\ntwo, with a call\nthree\n")
  put("own/mod.ts", "export const own = true\n")
  put("docs/upstream.md", page)
  record()

  test("write fills the table, and the check then passes with the two figures", () => {
    const written = run(repo, "write")
    expect(written.code).toBe(0)
    const text = fs.readFileSync(path.join(repo, "docs/upstream.md"), "utf8")
    expect(text).toContain("Upstream files edited: 1. Changed lines: 2 (1 added, 1 removed).")
    expect(text).toContain("| `src/a.ts` | 1 | 1 | Calls the module of this fork. |")
    expect(text).toContain("On a conflict: Take upstream's side, then put the call back.")
    expect(run(repo, "write").out).toContain("already current")

    const checked = run(repo)
    expect(checked.out).toContain("upstream check passed: 1 upstream files edited, 2 changed lines (1 added, 1 removed)")
    expect(checked.code).toBe(0)
    expect(run(repo, "report").out).toContain("1 upstream files edited, 2 changed lines")
    // A file that exists only in the fork is not an edit, whatever its size.
    expect(text).not.toContain("own/mod.ts")
  })

  test("an edit to an upstream file that is not listed fails, before it is committed", () => {
    put("src/b.ts", "b\nand a line of this fork\n")
    const result = run(repo)
    expect(result.code).toBe(1)
    expect(result.out).toContain("not listed: src/b.ts (modified, +1 -0)")
    // The table no longer matches either: the totals changed.
    expect(result.out).toContain("docs/upstream.md: the table of edited upstream files is out of date")
    put("src/b.ts", "b\n")
    expect(run(repo).code).toBe(0)
  })

  test("a listed edit that grew fails until the table is regenerated", () => {
    put("src/a.ts", "one\ntwo, with a call\nthree\nfour\n")
    const result = run(repo)
    expect(result.code).toBe(1)
    expect(result.out).toContain("the table of edited upstream files is out of date. Run: node script/upstream.mjs write")
    expect(result.out).not.toContain("not listed")
    put("src/a.ts", "one\ntwo, with a call\nthree\n")
    expect(run(repo).code).toBe(0)
  })

  test("an entry that no longer matches an edit fails", () => {
    record({
      edited: [
        { path: "src/a.ts", class: "hook", why: "Calls the module of this fork." },
        { path: "src/c.ts", class: "hook", why: "An edit that was removed since." },
      ],
    })
    const result = run(repo)
    expect(result.code).toBe(1)
    expect(result.out).toContain("src/c.ts is listed but no longer edited. Remove the entry.")
    record()
    expect(run(repo).code).toBe(0)
  })

  test("an entry without a reason or with an unknown class fails", () => {
    record({ edited: [{ path: "src/a.ts", class: "other", why: "" }] })
    const result = run(repo)
    expect(result.code).toBe(1)
    expect(result.out).toContain('src/a.ts has the unknown class "other"')
    expect(result.out).toContain("src/a.ts does not say why it is edited")
    record()
  })

  test("a directory entry and a pattern cover the files under them, each still counted", () => {
    put("README.fr.md", "bonjour\nune ligne\n")
    record({
      edited: [
        { path: "src/", class: "hook", why: "Everything under src is this fork's to edit here." },
        { path: "README.*.md", class: "docs", why: "Translated pages lose a section." },
      ],
    })
    expect(run(repo, "write").code).toBe(0)
    const text = fs.readFileSync(path.join(repo, "docs/upstream.md"), "utf8")
    expect(text).toContain("| `README.fr.md` | 1 | 0 | Translated pages lose a section. |")
    expect(text).toContain("| Documentation | 1 | 1 | 0 |")
    expect(text).toContain("Upstream files edited: 2.")
    put("README.fr.md", "bonjour\n")
    record()
    expect(run(repo, "write").code).toBe(0)
    expect(run(repo).code).toBe(0)
  })

  test("a replaced upstream file must stay identical to upstream, and its replacement must exist", () => {
    const replaced = [{ path: "src/c.ts", by: "own/mod.ts", why: "The module of this fork does this job." }]
    record({ replaced })
    expect(run(repo, "write").code).toBe(0)
    expect(fs.readFileSync(path.join(repo, "docs/upstream.md"), "utf8")).toContain(
      "| `src/c.ts` | `own/mod.ts` | The module of this fork does this job. |",
    )
    expect(run(repo).code).toBe(0)

    put("src/c.ts", "c, edited\n")
    const edited = run(repo)
    expect(edited.code).toBe(1)
    expect(edited.out).toContain("replaced file edited: src/c.ts must stay identical to upstream. Change own/mod.ts instead")
    put("src/c.ts", "c\n")

    record({ replaced: [{ ...replaced[0], by: "own/missing.ts" }] })
    const missing = run(repo)
    expect(missing.code).toBe(1)
    expect(missing.out).toContain("own/missing.ts, which replaces src/c.ts, does not exist")
    record({ replaced })
    expect(run(repo).code).toBe(0)
  })

  test("a clone without the base commit skips the check and says so", () => {
    record({ base: "0".repeat(40) })
    const result = run(repo)
    expect(result.code).toBe(0)
    expect(result.out).toContain("upstream check skipped: the upstream base 0000000000 is not in this clone")
    record({ replaced: [{ path: "src/c.ts", by: "own/mod.ts", why: "The module of this fork does this job." }] })
  })

  test("the trial merge names the conflicts by class, the replaced files upstream changed and new workflows, and changes nothing", () => {
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "fork")
    const head = git(repo, "rev-parse", "HEAD")

    // Upstream moves on: the same line of a.ts, the replaced file, a file the
    // fork did not touch, and a new workflow.
    git(repo, "switch", "-q", "upstream")
    put("src/a.ts", "one\ntwo, changed upstream\nthree\n")
    put("src/b.ts", "b, changed upstream\n")
    put("src/c.ts", "c, changed upstream\n")
    put(".github/workflows/new.yml", "on: push\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "upstream moves on")
    git(repo, "switch", "-q", "main")

    const result = run(repo, "conflicts", "upstream")
    expect(result.code).toBe(0)
    expect(result.out).toContain("1 upstream commits to merge, 4 files changed upstream")
    expect(result.out).toContain("Conflicts: 1 files")
    expect(result.out).toContain("Source: a call (1)")
    expect(result.out).toContain("Rule: Take upstream's side, then put the call back.")
    expect(result.out).toContain("- src/a.ts")
    expect(result.out).toContain("Replaced upstream files that upstream changed: 1.")
    expect(result.out).toContain("- src/c.ts (replaced by own/mod.ts)")
    expect(result.out).toContain("Workflows added upstream: 1.")
    expect(result.out).toContain("- .github/workflows/new.yml")
    // b.ts changed upstream only: it is neither a conflict nor a file to read.
    expect(result.out).not.toContain("src/b.ts")

    expect(git(repo, "rev-parse", "HEAD")).toBe(head)
    expect(git(repo, "status", "--porcelain")).toBe("")
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
  })

  test("an unknown command or a missing ref is an error, not a pass", () => {
    expect(run(repo, "conflicts").code).toBe(2)
    expect(run(repo, "nothing").code).toBe(2)
  })
})
