// The public docs checker (docs/check.mjs): the README and every Markdown file
// under docs/ pass it, and it fails on the wording the public docs must not use
// (unreleased features, the old product names, long dashes) while exact
// command output in code stays allowed.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

const root = path.resolve(import.meta.dir, "../../../..")
const script = path.join(root, "docs", "check.mjs")
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "docs-wording-"))

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

function check(...files: string[]) {
  const result = Bun.spawnSync(["node", script, ...files], { cwd: root })
  return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
}

function page(name: string, text: string) {
  const file = path.join(scratch, name)
  fs.writeFileSync(file, text)
  return file
}

describe("docs check", () => {
  test("the README and every docs page pass", () => {
    const result = check()
    expect(result.out).toContain("docs check passed")
    expect(result.code).toBe(0)
  })

  test.each([
    ["Login is coming soon.", "coming soon"],
    ["This command is not available on Windows.", "not available"],
    ["Try the preview build.", "preview"],
    ["See the roadmap.", "roadmap"],
    ["It ships in the next release.", "next release"],
    ["Open Rafiki Console to create a key.", "Rafiki Console"],
    ["Top up your wallet.", "wallet"],
    ["Rafiki Code \u2014 the agent.", "long dash"],
    ["Rafiki Code \u2013 the agent.", "long dash"],
  ])("fails on %p", (line, label) => {
    const result = check(page("bad.md", `# Page\n\n${line}\n`))
    expect(result.code).toBe(1)
    expect(result.out).toContain(label)
  })

  test("allows quoted command output in code", () => {
    const text = [
      "# Page",
      "",
      "The installer prints `Connect your Rafiki Console account with a key:`.",
      "",
      "```text",
      "No terminal is attached, so the browser sign-in is not available.",
      "```",
      "",
    ].join("\n")
    const result = check(page("good.md", text))
    expect(result.out).toContain("docs check passed")
    expect(result.code).toBe(0)
  })
})
