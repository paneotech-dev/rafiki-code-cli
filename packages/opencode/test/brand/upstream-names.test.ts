// The upstream project's name in text a user can read.
//
// A merge from upstream can bring in a string that names the upstream product
// or tells the user to run one of its commands, and nothing else notices: the
// wording test next to this one reads a fixed list of files, and the help and
// schema tests read only what they print. This test reads every string
// literal, template literal and JSX text of the sources that end up in the
// binary (the terminal interface, the CLI, the shared core) and looks for the
// upstream name used in one of three ways:
//
//   product  the capitalised name, as a sentence would write it
//   command  the lower case name followed by a word, or alone in a code span:
//            "run `opencode auth login`"
//   site     the upstream website
//
// Not matched, because they are not text and cannot change: identifiers,
// comments, import paths and package names (`@opencode-ai/...`), environment
// variable names, provider and command ids ("opencode", "opencode-go",
// "opencode.status"), and the file and directory names still read for
// compatibility (`opencode.json`, `.opencode/`).
//
// Every occurrence that exists today is on one of two lists below, with a
// count, so that a new one fails wherever it lands, including in a file that
// is already listed. A count that went down fails too: the entry is then
// lowered or removed, and the list only ever shrinks.
import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import ts from "typescript"

const root = path.resolve(import.meta.dir, "../../../..")

const scanned = ["packages/tui/src", "packages/opencode/src", "packages/core/src"]

type Kind = "product" | "command" | "site"
const kinds: Array<[Kind, RegExp]> = [
  ["product", /\bOpen[Cc]ode\b/],
  ["command", /(^|[^\w./@$-])opencode\s+[a-z<[]|`opencode`/],
  ["site", /\bopencode\.ai\b/],
]

type Entry = { path: string; why: string } & Partial<Record<Kind, number>>

// Occurrences that are right as they are. A path ending in "/" covers the
// directory.
const allowed: Entry[] = [
  {
    path: "packages/core/src/brand/brand.ts",
    product: 1,
    site: 1,
    why: "the upstream name and site as search text: Brand.prompt() replaces them in the upstream system prompts",
  },
  {
    path: "packages/core/src/models-dev.ts",
    site: 2,
    why: "the address of the upstream model catalogue, a service this build does not rename",
  },
  {
    path: "packages/core/src/plugin/provider/",
    product: 4,
    site: 7,
    why: "the referer and title headers upstream providers expect, and the upstream provider's own name; none of these providers is offered here (provider-scope.test.ts)",
  },
  {
    path: "packages/tui/src/component/dialog-provider.tsx",
    product: 3,
    site: 2,
    why: "the names of the upstream project's own services, shown under provider ids in Brand.disabledProviders",
  },
  {
    path: "packages/tui/src/component/dialog-retry-action.tsx",
    site: 1,
    why: "the address of an upstream service, offered only for provider ids in Brand.disabledProviders",
  },
  {
    path: "packages/tui/src/keymap.tsx",
    product: 1,
    why: "an internal invariant naming the function that was not called; never raised in a build that starts",
  },
]

// Occurrences that are leaks and are still there. They came with the fork and
// are recorded so that this test could land without rewriting them all in one
// change. Each is to be fixed in the brand layer and its entry removed; none is
// to be added.
const known: Entry[] = [
  {
    path: "packages/core/src/oauth/page.ts",
    product: 8,
    why: "the browser page shown after a provider or MCP sign in names the upstream product",
  },
  {
    path: "packages/core/src/v1/config/config.ts",
    command: 1,
    site: 2,
    why: "descriptions of configuration fields",
  },
  {
    path: "packages/opencode/src/cli/cmd/account.ts",
    site: 1,
    why: "the default address of the upstream account service",
  },
  {
    path: "packages/opencode/src/cli/cmd/github.handler.ts",
    command: 5,
    site: 5,
    why: "the upstream GitHub agent: its workflow file, its links and its comments",
  },
  {
    path: "packages/opencode/src/cli/cmd/providers.ts",
    site: 2,
    why: "prompts of the provider login for upstream providers",
  },
  {
    path: "packages/opencode/src/mcp/oauth-provider.ts",
    product: 1,
    site: 1,
    why: "the client name and address given to an MCP server when registering for OAuth",
  },
  {
    path: "packages/opencode/src/plugin/digitalocean.ts",
    product: 1,
    why: "the sign in prompt of an upstream provider",
  },
  {
    path: "packages/opencode/src/plugin/snowflake-cortex.ts",
    product: 1,
    why: "the sign in prompt of an upstream provider",
  },
  {
    path: "packages/opencode/src/provider/provider.ts",
    product: 1,
    command: 2,
    site: 6,
    why: "headers for upstream providers, and two of their errors that name an upstream command",
  },
  {
    path: "packages/opencode/src/server/routes/instance/httpapi/",
    product: 21,
    command: 16,
    why: "titles and descriptions of the HTTP API, as its OpenAPI document shows them",
  },
  {
    path: "packages/opencode/src/server/shared/ui.ts",
    site: 1,
    why: "the address the web interface is fetched from",
  },
  {
    path: "packages/opencode/src/session/retry.ts",
    product: 1,
    site: 2,
    why: "the upstream subscription offer shown when an upstream provider refuses for quota",
  },
]

const entries = [...allowed, ...known]

function sources(dir: string, base = root): string[] {
  return fs
    .readdirSync(path.join(base, dir), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = path.posix.join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(rel, base)
      if (!/\.tsx?$/.test(entry.name)) return []
      // Tests and stories are not shipped, declarations and generated files
      // hold no text of their own.
      if (/\.(test|stories|gen|d)\.tsx?$/.test(entry.name)) return []
      return [rel]
    })
}

// The text of every string literal, template literal and JSX text in a file,
// with its line. Module specifiers are paths, not text.
function literals(file: string, base = root) {
  const text = fs.readFileSync(path.join(base, file), "utf8")
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const found: Array<{ line: number; text: string }> = []
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      if (!(ts.isStringLiteral(node) && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)))) {
        found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

type Hit = { file: string; line: number; kind: Kind; text: string }

function hits(file: string, base = root): Hit[] {
  return literals(file, base).flatMap(({ line, text }) =>
    kinds
      .filter(([, pattern]) => pattern.test(text))
      .map(([kind]) => ({ file, line, kind, text: text.replace(/\s+/g, " ").trim().slice(0, 120) })),
  )
}

const show = (hit: Hit) => `${hit.file}:${hit.line}: ${hit.kind}: ${hit.text}`
const covers = (entry: Entry, file: string) => (entry.path.endsWith("/") ? file.startsWith(entry.path) : file === entry.path)

// What is wrong with a set of hits, given the lists: an occurrence in a file
// no entry covers, more occurrences of a kind than its entry counts, or fewer.
function problems(found: Hit[], list: Entry[]) {
  const out: string[] = []
  for (const hit of found) {
    if (!list.some((entry) => covers(entry, hit.file))) out.push(`not on a list: ${show(hit)}`)
  }
  for (const entry of list) {
    const inside = found.filter((hit) => covers(entry, hit.file))
    for (const [kind] of kinds) {
      const expected = entry[kind] ?? 0
      const actual = inside.filter((hit) => hit.kind === kind)
      if (actual.length > expected)
        out.push(
          `${entry.path}: ${actual.length} ${kind} occurrences, the list counts ${expected}. A new one was added:\n` +
            actual.map((hit) => `  ${show(hit)}`).join("\n"),
        )
      if (actual.length < expected)
        out.push(`${entry.path}: ${actual.length} ${kind} occurrences, the list counts ${expected}. Lower the entry.`)
    }
  }
  return out
}

describe("upstream names in user visible strings", () => {
  const files = scanned.flatMap((dir) => sources(dir))

  test("the sources are found", () => {
    for (const dir of scanned) expect(files.filter((file) => file.startsWith(dir + "/")).length).toBeGreaterThan(50)
    expect(files).toContain("packages/tui/src/app.tsx")
    expect(files).toContain("packages/opencode/src/provider/error.ts")
  })

  test("no string names the upstream product, one of its commands or its site, beyond the two lists", () => {
    expect(problems(files.flatMap((file) => hits(file)), entries).join("\n")).toBe("")
  })

  test("every entry says why, names a path that exists, and is on one list only", () => {
    for (const entry of entries) {
      expect(entry.why.length).toBeGreaterThan(20)
      expect(fs.existsSync(path.join(root, entry.path))).toBe(true)
      expect(scanned.some((dir) => entry.path.startsWith(dir + "/"))).toBe(true)
      expect((entry.product ?? 0) + (entry.command ?? 0) + (entry.site ?? 0)).toBeGreaterThan(0)
    }
    expect(new Set(entries.map((entry) => entry.path)).size).toBe(entries.length)
    // The terminal interface has no known leak: everything listed for it is allowed.
    expect(known.filter((entry) => entry.path.startsWith("packages/tui/"))).toEqual([])
  })

  test("the scan finds the three kinds in strings and JSX, and leaves identifiers, comments, ids and paths alone", () => {
    const dir = fs.mkdtempSync(path.join(root, "packages/opencode/test/brand/.upstream-"))
    try {
      fs.writeFileSync(
        path.join(dir, "sample.tsx"),
        [
          'import { createOpencodeClient } from "@opencode-ai/sdk/v2"',
          "// Run `opencode auth login <url>`: OpenCode comments are not shown, https://opencode.ai",
          "const OPENCODE_MODE = process.env.OPENCODE_CONFIG_DIR",
          'export const ids = ["opencode", "opencode-go", "opencode.status", "__opencode_custom__", ".opencode/", "opencode.json"]',
          'export const file = "~/.config/opencode/opencode.jsonc"',
          'export const a = "Run `opencode auth login <url>` to sign in again"',
          "export const b = `Start ${OPENCODE_MODE} with opencode serve`",
          'export const c = "OpenCode is now connected"',
          'export const d = "See https://opencode.ai/docs for more"',
          "export const e = <text>Open `opencode` in a terminal</text>",
          'export const f = "Run rafikicode login, then open code in your editor"',
          "export const g = createOpencodeClient",
        ].join("\n"),
      )
      const found = hits("sample.tsx", dir)
      expect(found.map((hit) => `${hit.line}: ${hit.kind}`)).toEqual([
        "6: command",
        "7: command",
        "8: product",
        "9: site",
        "10: command",
      ])

      // A file on no list, a file over its count, a file under its count.
      const list: Entry[] = [{ path: "sample.tsx", command: 3, product: 1, site: 1, why: "sample" }]
      expect(problems(found, list)).toEqual([])
      expect(problems(found, [])).toHaveLength(5)
      expect(problems(found, [])[0]).toBe("not on a list: sample.tsx:6: command: Run `opencode auth login <url>` to sign in again")
      expect(problems(found, [{ ...list[0], command: 2 }])[0]).toStartWith(
        "sample.tsx: 3 command occurrences, the list counts 2. A new one was added:",
      )
      expect(problems(found, [{ ...list[0], site: 2 }])).toEqual([
        "sample.tsx: 1 site occurrences, the list counts 2. Lower the entry.",
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
