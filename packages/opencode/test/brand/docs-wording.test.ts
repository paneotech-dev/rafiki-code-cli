// The public docs checker (docs/check.mjs): the README and every Markdown file
// under docs/ pass it, and it fails on the wording the public docs must not use
// (unreleased features, the old product names, long dashes) while exact
// command output in code stays allowed. Also: what the pages say about update
// methods is what `upgrade --method` offers, and the translated README files,
// which are the upstream project's, do not tell anyone how to install it.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"

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

describe("update methods in the docs", () => {
  const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8")
  // What the command offers, read from its help as a user sees it.
  const snapshot = read("packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap")
  const help = snapshot.slice(snapshot.indexOf("opencode upgrade --help 1"))
  const offered = [...help.slice(help.indexOf("--method")).match(/\[choices: ([^\]]+)\]/)![1].matchAll(/"([a-z]+)"/g)].map(
    (match) => match[1],
  )
  // Pages a user reads for the current version. Release notes say what a past
  // version did and plans say what was found, so neither is held to this.
  const pages = [
    "README.md",
    ...fs
      .readdirSync(path.join(root, "docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => path.join("docs", name)),
  ]

  test("the command offers the installer and the package managers this product is published through", () => {
    expect(offered).toEqual(["curl", ...Brand.packageManagers])
    expect(offered).not.toContain("choco")
    expect(offered).not.toContain("scoop")
  })

  test("the install page names every method the command takes, in one sentence", () => {
    const sentence = read("docs/install.md")
      .split("\n")
      .find((line) => line.includes("`--method` names the channel"))
    expect(sentence).toBeDefined()
    for (const method of offered) expect(sentence).toContain(`\`${method}\``)
  })

  test("no page offers Chocolatey or Scoop", () => {
    expect(pages.length).toBeGreaterThan(10)
    const found = pages.flatMap((file) =>
      read(file)
        .split("\n")
        .flatMap((line, index) => (/\b(choco|chocolatey|scoop)\b/i.test(line) ? [`${file}:${index + 1}: ${line}`] : [])),
    )
    expect(found.join("\n")).toBe("")
  })

  test("the translated README files point at the install page and carry no upstream install command", () => {
    const translated = fs.readdirSync(root).filter((name) => /^README\.[a-z]+\.md$/.test(name))
    expect(translated.length).toBe(21)
    const upstream = /opencode\.ai\/install|opencode-ai@|\b(install|add|use|-S|run)\b[^\n]*\bopencode(-desktop|-bin)?\b|OPENCODE_INSTALL_DIR/
    for (const file of translated) {
      const text = read(file)
      expect(text).toContain("[docs/install.md](./docs/install.md)")
      const found = text.split("\n").flatMap((line, index) => (upstream.test(line) ? [`${file}:${index + 1}: ${line}`] : []))
      expect(found.join("\n")).toBe("")
    }
  })
})
