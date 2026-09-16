// User-visible wording in the brand layer. Every string literal in the brand
// message catalogs (the CLI brand modules, the terminal interface lines that
// name the account, the VS Code extension) follows the product naming: the
// account is "your Rafiki AI account", the site is "the Rafiki AI console
// (console.rafikiai.io)". The old product name, the word "wallet" and the
// capitalised "the Console" never appear. Comments and identifiers are not
// user-visible and are not checked; the "Console:" field label of whoami stays,
// since the VS Code extension parses it.
import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import ts from "typescript"

const root = path.resolve(import.meta.dir, "../../../..")

function sourcesIn(dir: string) {
  return fs
    .readdirSync(path.join(root, dir))
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => path.join(dir, name))
}

const catalogs = [
  ...sourcesIn("packages/core/src/brand"),
  ...sourcesIn("packages/opencode/src/rafiki"),
  "packages/opencode/src/cli/cmd/models.ts",
  "packages/tui/src/component/prompt/index.tsx",
  "packages/tui/src/feature-plugins/sidebar/footer.tsx",
  "packages/tui/src/feature-plugins/home/tips-view.tsx",
  ...sourcesIn("sdks/vscode/src"),
  ...sourcesIn("sdks/vscode/src/lib"),
]

const banned: Array<[string, RegExp]> = [
  ["Rafiki Console", /rafiki\s+console/i],
  ["wallet", /wallet/i],
  ["the Console", /\b([Tt]he|[Yy]our|Open) Console\b|, Console,|^Console [a-z]/],
  ["long dash", /[\u2013\u2014]/],
  ["roadmap wording", /coming soon|not yet available|in preview/i],
]

// The text of every string and template literal in a file, with its line.
function literals(file: string) {
  const text = fs.readFileSync(path.join(root, file), "utf8")
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
      // Module specifiers are paths, not text.
      if (!(ts.isStringLiteral(node) && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)))) {
        found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function problems(file: string) {
  return literals(file).flatMap(({ line, text }) =>
    banned.filter(([, pattern]) => pattern.test(text)).map(([label]) => `${file}:${line}: ${label}: ${text}`),
  )
}

describe("brand message wording", () => {
  test("the catalogs exist", () => {
    expect(catalogs.length).toBeGreaterThan(20)
    for (const file of catalogs) expect(fs.existsSync(path.join(root, file))).toBe(true)
  })

  test("no string in the brand message catalogs uses a banned word", () => {
    expect(catalogs.flatMap(problems).join("\n")).toBe("")
  })

  test("the scan finds banned words in string literals and ignores comments", () => {
    const dir = fs.mkdtempSync(path.join(root, "packages/opencode/test/brand/.wording-"))
    try {
      const file = path.join(dir, "sample.ts")
      fs.writeFileSync(
        file,
        [
          "// the Console wallet, Rafiki Console: comments are not shown",
          "const wallet = 1",
          'export const a = "needs a Rafiki Console account"',
          "export const b = `Top up your Wallet ${wallet}`",
          'export const c = "Open the Console key page"',
          'export const d = "Create a key in the Rafiki AI console (console.rafikiai.io)"',
          'export const e = "Console: https://console.rafikiai.io"',
          "export const f = `${a}Console asked to slow down`",
        ].join("\n"),
      )
      const found = problems(path.relative(root, file)).map((line) => line.split(": ")[1])
      expect(found).toEqual(["Rafiki Console", "wallet", "the Console", "the Console"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
