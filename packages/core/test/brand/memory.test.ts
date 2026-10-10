// The project memory files and their rules (src/brand/memory.ts): small
// structured changes, the secret scan, the size cap, the project boundary,
// and the text a session reads.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as Memory from "../../src/brand/memory"

let project: string
const NOW = new Date("2026-10-10T12:00:00Z")

beforeEach(() => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-memory-")))
})

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
})

function file(section: Memory.Section) {
  return path.join(project, ".rafiki", "memory", Memory.SECTIONS[section].file)
}

function update(change: Memory.Change, limit?: number) {
  return Memory.update(project, change, { now: NOW, limit })
}

describe("changes", () => {
  test("append creates the folder and the file with its heading, one list item per entry", () => {
    const outcome = update({ section: "notes", operation: "append", text: "Run tests with bun test --concurrency 2." })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.created).toBe(true)
    expect(fs.readFileSync(file("notes"), "utf8")).toBe("# Notes\n\n- Run tests with bun test --concurrency 2.\n")
    update({ section: "notes", operation: "append", text: "- The dev server listens on 5173." })
    expect(fs.readFileSync(file("notes"), "utf8")).toBe(
      "# Notes\n\n- Run tests with bun test --concurrency 2.\n- The dev server listens on 5173.\n",
    )
  })

  test("decisions are dated unless the text starts with a date", () => {
    update({ section: "decisions", operation: "append", text: "Use SQLite, because the app runs on one machine." })
    update({ section: "decisions", operation: "append", text: "2026-09-01: Keep the API in English." })
    expect(fs.readFileSync(file("decisions"), "utf8")).toBe(
      "# Decisions\n\n- 2026-10-10: Use SQLite, because the app runs on one machine.\n- 2026-09-01: Keep the API in English.\n",
    )
  })

  test("several lines make one entry with indented continuation lines", () => {
    update({ section: "progress", operation: "append", text: "Done: login page.\nNext: the profile page." })
    expect(fs.readFileSync(file("progress"), "utf8")).toBe("# Progress\n\n- Done: login page.\n  Next: the profile page.\n")
  })

  test("replace with match changes one entry; remove takes one entry out", () => {
    update({ section: "progress", operation: "append", text: "In progress: the login page." })
    update({ section: "progress", operation: "append", text: "Next: the profile page." })
    expect(update({ section: "progress", operation: "replace", match: "login", text: "Done: the login page." }).ok).toBe(true)
    expect(update({ section: "progress", operation: "remove", text: "profile" }).ok).toBe(true)
    expect(fs.readFileSync(file("progress"), "utf8")).toBe("# Progress\n\n- Done: the login page.\n")
  })

  test("replace without match rewrites the whole section and keeps a heading", () => {
    update({ section: "project", operation: "append", text: "Old description." })
    expect(update({ section: "project", operation: "replace", text: "A shop in Next.js 15 with Postgres.\n\n- Deployed on one server." }).ok).toBe(true)
    expect(fs.readFileSync(file("project"), "utf8")).toBe("# Project\n\nA shop in Next.js 15 with Postgres.\n\n- Deployed on one server.\n")
  })

  test("an ambiguous or missing match changes nothing", () => {
    update({ section: "notes", operation: "append", text: "Port 3000 for the API." })
    update({ section: "notes", operation: "append", text: "Port 5173 for the web." })
    const before = fs.readFileSync(file("notes"), "utf8")
    const ambiguous = update({ section: "notes", operation: "remove", text: "Port" })
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.message).toContain("2 entries")
    const missing = update({ section: "notes", operation: "replace", match: "redis", text: "x" })
    expect(missing.ok).toBe(false)
    expect(fs.readFileSync(file("notes"), "utf8")).toBe(before)
  })

  test("unknown sections and operations, empty and oversized text are refused", () => {
    expect(update({ section: "secrets" as Memory.Section, operation: "append", text: "x" }).ok).toBe(false)
    expect(update({ section: "notes", operation: "delete" as Memory.Operation, text: "x" }).ok).toBe(false)
    expect(update({ section: "notes", operation: "append", text: "   " }).ok).toBe(false)
    const long = update({ section: "notes", operation: "append", text: "a".repeat(Memory.MAX_ENTRY + 1) })
    expect(long.ok).toBe(false)
    expect(long.message).toContain("Keep entries short")
    expect(fs.existsSync(path.join(project, ".rafiki"))).toBe(false)
  })
})

describe("secrets", () => {
  const samples = [
    ["API key (sk-...)", "The key is sk-proj-abcdefghijklmnopqrstuvwx"], // secret-scan: allow
    ["GitHub token", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"], // secret-scan: allow
    ["AWS access key", "AKIAABCDEFGHIJKLMNOP for the bucket"], // secret-scan: allow
    ["private key", "-----BEGIN PRIVATE KEY-----"], // secret-scan: allow
  ]
  for (const [kind, text] of samples) {
    test(`refused: ${kind}`, () => {
      const outcome = update({ section: "notes", operation: "append", text })
      expect(outcome.ok).toBe(false)
      expect(outcome.message).toContain("looks like a secret")
      expect(outcome.message).toContain(kind)
      expect(fs.existsSync(file("notes"))).toBe(false)
    })
  }

  test("naming where a secret lives is fine", () => {
    expect(update({ section: "notes", operation: "append", text: "The gateway key is in RAFIKICODE_API_KEY (.env, not committed)." }).ok).toBe(true)
  })

  test("a person's save is scanned too", () => {
    const outcome = Memory.save(project, "notes", "# Notes\n\n- key sk-abcdefghijklmnopqrstuvwxyz\n") // secret-scan: allow
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain("line 3")
  })
})

describe("size cap", () => {
  test("a write that would pass the cap is refused; one that shrinks the memory is not", () => {
    for (let i = 0; i < 6; i++) expect(update({ section: "notes", operation: "append", text: `Note ${i} ` + "x".repeat(150) }, 1024).ok).toBe(true)
    const refused = update({ section: "notes", operation: "append", text: "y".repeat(300) }, 1024)
    expect(refused.ok).toBe(false)
    expect(refused.message).toContain("over its 1 KB cap")
    // A file made larger by hand: removing still works.
    fs.appendFileSync(file("notes"), "- " + "z".repeat(800) + "\n")
    expect(update({ section: "notes", operation: "remove", text: "Note 0" }, 1024).ok).toBe(true)
  })

  test("the cap from the config is clamped", () => {
    expect(Memory.cap(undefined)).toBe(8192)
    expect(Memory.cap({ max_bytes: 10 })).toBe(1024)
    expect(Memory.cap({ max_bytes: 1_000_000 })).toBe(32768)
  })
})

describe("project boundary", () => {
  test("a .rafiki folder that is a symbolic link is refused", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-memory-outside-"))
    try {
      fs.symlinkSync(outside, path.join(project, ".rafiki"))
      const outcome = update({ section: "notes", operation: "append", text: "x" })
      expect(outcome.ok).toBe(false)
      expect(outcome.message).toContain("symbolic link")
      expect(fs.readdirSync(outside)).toEqual([])
      expect(Memory.read(project).notes).toBe("")
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  test("a memory file that is a symbolic link is refused, and not read", () => {
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-memory-target-")), "target.md")
    try {
      fs.writeFileSync(outside, "# Notes\n\n- outside\n")
      fs.mkdirSync(path.join(project, ".rafiki", "memory"), { recursive: true })
      fs.symlinkSync(outside, file("notes"))
      expect(update({ section: "notes", operation: "append", text: "x" }).ok).toBe(false)
      expect(fs.readFileSync(outside, "utf8")).toBe("# Notes\n\n- outside\n")
      expect(Memory.prompt({ project })).not.toContain("outside")
    } finally {
      fs.rmSync(path.dirname(outside), { recursive: true, force: true })
    }
  })

  test("the project root is the repository root, or the folder outside git", () => {
    expect(Memory.root("/work/repo/web", "/work/repo")).toBe("/work/repo")
    expect(Memory.root("/work/folder", "/")).toBe("/work/folder")
    expect(Memory.root("/work/folder", "")).toBe("/work/folder")
  })
})

describe("the text a session reads", () => {
  test("empty memory: how it works, and that it is empty", () => {
    const text = Memory.prompt({ project, git: false })
    expect(text).toContain("memory_update")
    expect(text).toContain("The memory is empty so far.")
    expect(text).not.toContain("<project-memory>")
    expect(text).not.toContain("do not commit")
  })

  test("the files in a fixed order, and the git note in a repository", () => {
    update({ section: "notes", operation: "append", text: "Use pnpm." })
    update({ section: "project", operation: "append", text: "A blog in Astro." })
    const text = Memory.prompt({ project, git: true })
    expect(text).toContain("do not commit .rafiki/memory/ yourself")
    const projectAt = text.indexOf("--- .rafiki/memory/project.md")
    const notesAt = text.indexOf("--- .rafiki/memory/notes.md")
    expect(projectAt).toBeGreaterThan(0)
    expect(notesAt).toBeGreaterThan(projectAt)
    expect(text).toContain("- A blog in Astro.")
    expect(text).toContain("- Use pnpm.")
  })

  test("the same files give the same bytes", () => {
    update({ section: "notes", operation: "append", text: "Use pnpm." })
    expect(Memory.prompt({ project, git: false })).toBe(Memory.prompt({ project, git: false }))
  })

  test("over the cap: each file keeps a share, decisions keep the newest, with a note", () => {
    fs.mkdirSync(path.dirname(file("notes")), { recursive: true })
    const decisions = ["# Decisions", ""]
    for (let i = 0; i < 100; i++) decisions.push(`- 2026-10-${String((i % 28) + 1).padStart(2, "0")}: decision number ${i} with its reason`)
    fs.writeFileSync(file("decisions"), decisions.join("\n") + "\n")
    fs.writeFileSync(file("notes"), "# Notes\n\n" + Array.from({ length: 100 }, (_, i) => `- note number ${i}`).join("\n") + "\n")
    fs.writeFileSync(file("project"), "# Project\n\n- A small project.\n")
    const text = Memory.prompt({ project, limit: 2048, git: false })
    const inside = text.slice(text.indexOf("<project-memory>"), text.indexOf("</project-memory>"))
    expect(Buffer.byteLength(inside)).toBeLessThan(2048 + 400)
    expect(text).toContain("- A small project.")
    expect(text).toContain("decision number 99")
    expect(text).not.toContain("decision number 0 ")
    expect(text).toContain("note number 0")
    expect(text).not.toContain("note number 99")
    expect(text).toMatch(/\[\d+ bytes of the memory were left out/)
  })

  test("the switch: the environment wins over the config", () => {
    expect(Memory.enabled(undefined, undefined)).toBe(true)
    expect(Memory.enabled({ enabled: false }, undefined)).toBe(false)
    expect(Memory.enabled({ enabled: false }, "1")).toBe(true)
    expect(Memory.enabled({ enabled: true }, "off")).toBe(false)
    expect(Memory.enabled(undefined, "maybe")).toBe(true)
  })
})

describe("status", () => {
  test("lists the four files with sizes and whether the folder is in git", () => {
    update({ section: "notes", operation: "append", text: "Use pnpm." })
    fs.mkdirSync(path.join(project, ".git"))
    const status = Memory.status(project)
    expect(status.items.map((item) => item.file)).toEqual(["project.md", "decisions.md", "progress.md", "notes.md"])
    expect(status.items.find((item) => item.section === "notes")?.empty).toBe(false)
    expect(status.items.find((item) => item.section === "project")?.empty).toBe(true)
    expect(status.git).toBe(true)
    expect(status.total).toBeGreaterThan(0)
  })
})
