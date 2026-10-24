// The language checks after an edit (rafiki/edit-check.ts): only the errors
// the edit introduced, a time limit on slow servers, and a syntax check when
// no server reported.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { which } from "@opencode-ai/core/util/which"
import * as EditCheck from "../../src/rafiki/edit-check"
import { DEFAULT_SERVERS } from "../../src/lsp/lsp"

const error = (message: string, line = 0) => ({
  range: { start: { line, character: 0 }, end: { line, character: 1 } },
  severity: 1 as const,
  message,
})

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-edit-check-"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const lsp = (after: Record<string, any[]>, touch: Effect.Effect<void> = Effect.void) => ({
  touchFile: () => touch,
  diagnostics: () => Effect.succeed(after),
})

describe("new errors only", () => {
  test("errors the file had before are left out and counted, even on another line", async () => {
    const file = path.join(dir, "a.ts")
    const result = await Effect.runPromise(
      EditCheck.afterEdit({
        lsp: lsp({ [file]: [error("old one", 9), error("new one", 3)] }),
        files: [file],
        before: { [file]: [error("old one", 4)] },
        env: {},
      }),
    )
    expect(result.reports).toHaveLength(1)
    expect(result.reports[0].kind).toBe("new")
    expect(result.reports[0].block).toContain("new one")
    expect(result.reports[0].block).not.toContain("old one")
    const text = EditCheck.render(result.reports[0], "this file")
    expect(text).toContain("New errors after this edit in this file")
    expect(text).toContain("1 error that was already there before this edit is not shown")
  })

  test("an edit that adds no error reports nothing; one the server did not know before reports all", async () => {
    const file = path.join(dir, "a.ts")
    const same = await Effect.runPromise(
      EditCheck.afterEdit({ lsp: lsp({ [file]: [error("x")] }), files: [file], before: { [file]: [error("x")] }, env: {} }),
    )
    expect(same.reports).toEqual([])
    const fresh = await Effect.runPromise(EditCheck.afterEdit({ lsp: lsp({ [file]: [error("x")] }), files: [file], before: {}, env: {} }))
    expect(fresh.reports[0].kind).toBe("all")
    expect(EditCheck.render(fresh.reports[0], "this file")).toContain("LSP errors detected in this file")
  })

  test("the same message twice after it was there once is one new error", () => {
    expect(EditCheck.introduced([error("dup")], [error("dup"), error("dup")])).toHaveLength(1)
  })
})

describe("time limit", () => {
  test("a server that never answers does not hold the edit past the limit", async () => {
    const file = path.join(dir, "a.ts")
    const started = Date.now()
    const result = await Effect.runPromise(
      EditCheck.afterEdit({
        lsp: lsp({}, Effect.never),
        files: [file],
        before: {},
        wait: 200,
        syntax: async () => undefined,
        env: {},
      }),
    )
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.reports).toEqual([])
  })

  test("RAFIKICODE_EDIT_CHECKS=off skips the checks", async () => {
    let touched = false
    const result = await Effect.runPromise(
      EditCheck.afterEdit({
        lsp: { touchFile: () => Effect.sync(() => void (touched = true)), diagnostics: () => Effect.succeed({}) },
        files: [path.join(dir, "a.ts")],
        before: {},
        env: { RAFIKICODE_EDIT_CHECKS: "off" },
      }),
    )
    expect(touched).toBe(false)
    expect(result.reports).toEqual([])
  })
})

describe("syntax checks when no server reported", () => {
  test("the syntax check runs only for a file no server reported on", async () => {
    const seen: string[] = []
    const a = path.join(dir, "a.py")
    const b = path.join(dir, "b.py")
    const result = await Effect.runPromise(
      EditCheck.afterEdit({
        lsp: lsp({ [a]: [] }),
        files: [a, b],
        before: {},
        syntax: async (file) => (seen.push(file), [error("SyntaxError: invalid syntax", 2)]),
        env: {},
      }),
    )
    expect(seen).toEqual([b])
    expect(result.reports[0].kind).toBe("syntax")
    expect(EditCheck.render(result.reports[0], "b.py")).toContain("Syntax errors in b.py")
  })

  test("package.json that is not valid JSON is reported", async () => {
    const file = path.join(dir, "package.json")
    fs.writeFileSync(file, '{ "name": "x", }')
    const found = await EditCheck.syntax(file, 5000)
    expect(found?.[0].message).toContain("Invalid JSON")
    fs.writeFileSync(file, '{ "name": "x" }')
    expect(await EditCheck.syntax(file, 5000)).toEqual([])
  })

  test.skipIf(!which("python3") && !which("python"))("python: a syntax error with its line, a valid file with none", async () => {
    const file = path.join(dir, "m.py")
    fs.writeFileSync(file, "def f():\n    return 1\n\ndef g(:\n    pass\n")
    const found = await EditCheck.syntax(file, 5000)
    expect(found).toHaveLength(1)
    expect(found![0].range.start.line).toBe(3)
    expect(found![0].message).toContain("SyntaxError")
    fs.writeFileSync(file, "def f():\n    return 1\n")
    expect(await EditCheck.syntax(file, 5000)).toEqual([])
  })

  test.skipIf(!which("node"))("node: a syntax error in an .mjs file; JSX in a .js file is left alone", async () => {
    const file = path.join(dir, "m.mjs")
    fs.writeFileSync(file, "export const a = 1\nconst b = {\n")
    const found = await EditCheck.syntax(file, 5000)
    expect(found?.[0].message).toContain("SyntaxError")
    const jsx = path.join(dir, "c.js")
    fs.writeFileSync(jsx, "export default function C() {\n  return <div>hi</div>\n}\n")
    expect(await EditCheck.syntax(jsx, 5000)).toBeUndefined()
  })

  test("php -l output is read as one error with its line", () => {
    const found = EditCheck.parse("php", {
      code: 255,
      timedOut: false,
      output: 'PHP Parse error:  syntax error, unexpected token "}" in /p/app/Http/Controller.php on line 12\nErrors parsing /p/app/Http/Controller.php\n',
    })
    expect(found?.[0].range.start.line).toBe(11)
    expect(found?.[0].message).toContain('Parse error: syntax error, unexpected token "}"')
    expect(EditCheck.parse("php", { code: 0, timedOut: false, output: "No syntax errors detected" })).toEqual([])
    expect(EditCheck.parse("php", { code: null, timedOut: true, output: "" })).toBeUndefined()
  })

  test("other file types get no syntax check", async () => {
    const file = path.join(dir, "a.ts")
    fs.writeFileSync(file, "const = ")
    expect(await EditCheck.syntax(file, 5000)).toBeUndefined()
  })
})

test("TypeScript, Python and PHP language servers are on by default", () => {
  expect(DEFAULT_SERVERS).toEqual(expect.arrayContaining(["typescript", "pyright", "php intelephense"]))
})
