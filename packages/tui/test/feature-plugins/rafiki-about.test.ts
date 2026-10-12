import { expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as About from "@opencode-ai/core/brand/about"
import { byline, where } from "../../src/feature-plugins/sidebar/footer"

test("two sentences from the project memory first", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "about-"))
  try {
    expect(About.describe(dir)).toBeUndefined()
    fs.writeFileSync(
      path.join(dir, "README.md"),
      "# Shop\n\n[![build](https://x/b.svg)](https://x)\n\nA small shop for **books**. It runs on Bun, e.g. on a laptop. Third sentence.\n\nMore.\n",
    )
    expect(About.describe(dir)).toEqual({ text: "A small shop for books. It runs on Bun, e.g. on a laptop.", source: "README.md" })
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agents\n\nThe API of the shop, version 1.2 in 2026. Uses Postgres. Not this.\n")
    expect(About.describe(dir)?.text).toBe("The API of the shop, version 1.2 in 2026. Uses Postgres.")
    fs.mkdirSync(path.join(dir, ".rafiki/memory"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".rafiki/memory/project.md"), "# Project\n")
    expect(About.describe(dir)?.source).toBe("AGENTS.md")
    const before = About.stamp(dir)
    fs.writeFileSync(path.join(dir, ".rafiki/memory/project.md"), "# Project\n\n- Online bookshop\n- Stack: Bun and Postgres\n- Third\n")
    expect(About.stamp(dir)).not.toBe(before)
    expect(About.describe(dir)).toEqual({ text: "Online bookshop. Stack: Bun and Postgres.", source: ".rafiki/memory/project.md" })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a long description is cut to fit", () => {
  const text = About.sentences("word ".repeat(200) + ".")
  expect(text.length).toBeLessThanOrEqual(About.MAX_LENGTH)
  expect(text.endsWith("…")).toBe(true)
})

test("the footer heading names the product and its maker, the folder stays under it", () => {
  expect(byline()).toBe("Rafiki Code by PANEOTECH")
  expect(where("~/RafikiCode:main", "0.1.11")).toBe("~/RafikiCode:main · 0.1.11")
  const long = where("~/projects/clients/a-very-long-folder-name/and-more", "0.1.11-rc.1")
  expect(long.length).toBe(36)
  expect(long.startsWith("…")).toBe(true)
  expect(long.endsWith("and-more · 0.1.11-rc.1")).toBe(true)
})
