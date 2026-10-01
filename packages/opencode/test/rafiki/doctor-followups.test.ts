// The first-run checks doctor grew after v0.1.7: the PATH check that catches the
// failure class v0.1.5 fixed, the project config check, and the workspace-trust
// line. Every check is a pure function taking what it compares, so each case
// here is the situation a person is actually in, not a mocked filesystem.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Trust from "@opencode-ai/core/brand/trust"
import * as Doctor from "../../src/rafiki/doctor"

const upstreamWord = /(?<![A-Z_])opencode(?![A-Z_])/i

let home: string

beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-doctor-followups-")))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

describe("doctor: the path check", () => {
  const installed = "/home/someone/.rafikicode/bin/rafikicode"

  test("the installer's symlink into a PATH directory is the normal case and passes", () => {
    const real = write(path.join(home, ".rafikicode", "bin", Brand.name), "#!/bin/sh\n")
    const link = path.join(home, ".local", "bin", Brand.name)
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(real, link)

    const line = Doctor.checkPath(link, real, "latest")
    expect(line).toMatchObject({ name: "path", status: "ok" })
    expect(line.detail).toContain(link)
    expect(line.detail).toContain(`a link to ${real}`)
    expect(line.fix).toBeUndefined()
  })

  test("a direct hit with no symlink passes and says so plainly", () => {
    const real = write(path.join(home, "bin", Brand.name), "#!/bin/sh\n")
    const line = Doctor.checkPath(real, real, "latest")
    expect(line).toMatchObject({ name: "path", status: "ok" })
    expect(line.detail).not.toContain("a link to")
  })

  test("a chain of symlinks still resolves to the same binary", () => {
    const real = write(path.join(home, ".rafikicode", "bin", Brand.name), "#!/bin/sh\n")
    const middle = path.join(home, "middle")
    const link = path.join(home, "front")
    fs.symlinkSync(real, middle)
    fs.symlinkSync(middle, link)
    expect(Doctor.checkPath(link, real, "latest").status).toBe("ok")
  })

  test("a shadowing copy earlier on PATH fails with both paths and what to do", () => {
    const running = write(path.join(home, ".rafikicode", "bin", Brand.name), "\x7fELF binary-ish")
    // A build of the product, not a launcher script: this is the v0.1.5 failure.
    const shadow = write(path.join(home, "shadow", Brand.name), "\x7fELF older build")

    const line = Doctor.checkPath(shadow, running, "latest")
    expect(line).toMatchObject({ name: "path", status: "fail" })
    expect(line.detail).toContain(shadow)
    expect(line.detail).toContain(running)
    expect(line.fix).toContain(`Remove ${shadow}`)
    expect(line.fix).toContain(path.dirname(running))
    expect(line.fix).toContain(`${Brand.name} doctor`)
  })

  // A package manager or version manager that puts a launcher on PATH (pnpm, the
  // shim based version managers) is not a broken install, and doctor must not
  // call it one.
  test("a launcher script on PATH warns instead of failing", () => {
    const running = write(path.join(home, ".rafikicode", "bin", Brand.name), "\x7fELF binary-ish")
    const shim = write(path.join(home, "shims", Brand.name), `#!/bin/sh\nexec "${running}" "$@"\n`)

    const line = Doctor.checkPath(shim, running, "latest")
    expect(line).toMatchObject({ name: "path", status: "warn" })
    expect(line.detail).toContain("a launcher script")
    expect(line.note).toBe(Doctor.PATH_LAUNCHER)
    expect(line.fix).toContain(`${Brand.name} --version`)
  })

  test("a launcher is told apart from a shadowing build by what is in the file", () => {
    const script = write(path.join(home, "a", Brand.name), "#!/usr/bin/env node\n")
    const windowsShim = write(path.join(home, "b", `${Brand.name}.cmd`), "@echo off\r\n")
    const binary = write(path.join(home, "c", Brand.name), "\x7fELF binary-ish")
    expect(Doctor.looksLikeLauncher(script)).toBe(true)
    expect(Doctor.looksLikeLauncher(windowsShim)).toBe(true)
    expect(Doctor.looksLikeLauncher(binary)).toBe(false)
    expect(Doctor.looksLikeLauncher(path.join(home, "nothing-here"))).toBe(false)
  })

  test("a stale symlink pointing at a binary that is no longer there fails", () => {
    const gone = path.join(home, "old", Brand.name)
    const link = path.join(home, "bin", Brand.name)
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(gone, link)
    const running = write(path.join(home, ".rafikicode", "bin", Brand.name), "\x7fELF binary-ish")

    expect(Doctor.checkPath(link, running, "latest")).toMatchObject({ name: "path", status: "fail" })
  })

  test("nothing on PATH names the directory to add and the installer", () => {
    const line = Doctor.checkPath(null, installed, "latest")
    expect(line).toMatchObject({ name: "path", status: "fail" })
    expect(line.detail).toContain("is not on PATH")
    expect(line.fix).toContain("/home/someone/.rafikicode/bin")
    expect(line.fix).toContain(Brand.release.installer)
  })

  test("a source checkout is skipped rather than guessed at", () => {
    expect(Doctor.checkPath("/usr/local/bin/rafikicode", "/usr/bin/bun", "latest")).toMatchObject({ status: "skip" })
    expect(Doctor.checkPath(installed, installed, "local")).toMatchObject({ status: "skip" })
  })

  test("no path line ever names the upstream project", () => {
    for (const line of [
      Doctor.checkPath(null, installed, "latest"),
      Doctor.checkPath("/usr/bin/rafikicode", installed, "latest"),
      Doctor.checkPath(write(path.join(home, "shim", Brand.name), "#!/bin/sh\n"), installed, "latest"),
    ]) {
      expect(Doctor.format(line)).not.toMatch(upstreamWord)
    }
  })
})

describe("doctor: the project config check", () => {
  // The decoder the loader itself uses, so a case that doctor calls invalid is a
  // case that would refuse to start.
  let validate: Doctor.Validate

  beforeEach(async () => {
    validate = (await Doctor.loadValidate())!
    expect(typeof validate).toBe("function")
  })

  test("no project configuration is not a problem", () => {
    expect(Doctor.checkProject([], validate, false)).toMatchObject({ name: "project", status: "ok" })
    expect(Doctor.checkProject([], validate, false).detail).toContain("no project configuration")
  })

  test("a valid project config passes and reports the model it selects", () => {
    const file = write(
      path.join(home, "repo", `${Brand.project.file}.json`),
      '{\n  // a comment is fine\n  "model": "rafiki/rafiki-pro",\n}\n',
    )
    const line = Doctor.checkProject([file], validate, false)
    expect(line).toMatchObject({ name: "project", status: "ok" })
    expect(line.detail).toContain(file)
    expect(line.detail).toContain("model rafiki/rafiki-pro")
  })

  test("the nearest file wins the reported model, as the loader merges it", () => {
    const outer = write(path.join(home, "repo", `${Brand.project.file}.json`), '{"model":"rafiki/rafiki-fast"}')
    const inner = write(path.join(home, "repo", "sub", `${Brand.project.file}.json`), '{"model":"rafiki/rafiki-pro"}')
    expect(Doctor.checkProject([outer, inner], validate, false).detail).toContain("model rafiki/rafiki-pro")
  })

  test("broken syntax fails, names the line, and offers the project switch", () => {
    const file = write(
      path.join(home, "repo", `${Brand.project.file}.json`),
      '{\n  "model": "rafiki/rafiki-pro"\n  "share": "manual"\n}\n',
    )
    const line = Doctor.checkProject([file], validate, false)
    expect(line).toMatchObject({ name: "project", status: "fail" })
    expect(line.detail).toContain("is not valid JSON")
    expect(line.detail).toContain("line 3")
    expect(line.fix).toContain(`${Brand.env.disableProjectConfig}=1`)
  })

  // The failure the audit found: valid JSON, wrong shape, invisible to doctor
  // and a hard failure at session start.
  test("a shape the schema refuses fails and names the field", () => {
    const file = write(path.join(home, "repo", `${Brand.project.file}.json`), '{"instructions":"AGENTS.md"}')
    const line = Doctor.checkProject([file], validate, false)
    expect(line).toMatchObject({ name: "project", status: "fail" })
    expect(line.detail).toContain("does not match the configuration schema")
    expect(line.detail).toContain("instructions")
    expect(line.fix).toContain(Brand.schema.config)
  })

  test('"permissions" for "permission" is caught with the loader\'s own message', () => {
    const file = write(path.join(home, "repo", `${Brand.project.file}.json`), '{"permissions":{"edit":"deny"}}')
    const line = Doctor.checkProject([file], validate, false)
    expect(line).toMatchObject({ name: "project", status: "fail" })
    expect(line.detail).toContain('Use "permission" for access rules')
  })

  test("a file that is not an object fails with what to put there instead", () => {
    const file = write(path.join(home, "repo", `${Brand.project.file}.json`), "[1,2,3]")
    const line = Doctor.checkProject([file], validate, false)
    expect(line).toMatchObject({ name: "project", status: "fail" })
    expect(line.fix).toContain("for example {}")
  })

  test("the first broken file of several is the one reported", () => {
    const good = write(path.join(home, "repo", `${Brand.project.file}.json`), "{}")
    const bad = write(path.join(home, "repo", "sub", `${Brand.project.file}.json`), '{"share":"yes"}')
    expect(Doctor.checkProject([good, bad], validate, false).detail).toContain(bad)
  })

  test("the switch that turns project config off turns the check into a skip", () => {
    const line = Doctor.checkProject(["ignored"], validate, true)
    expect(line).toMatchObject({ name: "project", status: "skip" })
    expect(line.detail).toContain(Brand.env.disableProjectConfig)
  })

  test("the global config check refuses the same shapes, with its own fix", () => {
    const dir = path.join(home, ".rafikicode")
    write(path.join(dir, Brand.configFile), '{"instructions":"AGENTS.md"}')
    const line = Doctor.checkConfig(dir, validate)
    expect(line).toMatchObject({ name: "config", status: "fail" })
    expect(line.detail).toContain("does not match the configuration schema")
    // A global file is ours to recreate; a project file is the repository's.
    expect(line.fix).toContain("recreated with defaults")
    expect(line.fix).not.toContain(Brand.env.disableProjectConfig)
  })

  test("a valid global config still passes with no validator at all", () => {
    const dir = path.join(home, ".rafikicode")
    write(path.join(dir, Brand.configFile), '{"model":"rafiki/rafiki-pro"}')
    expect(Doctor.checkConfig(dir, undefined)).toMatchObject({ name: "config", status: "ok" })
  })

  test("no project line ever names the upstream project", () => {
    const file = write(path.join(home, "repo", `${Brand.project.file}.json`), '{"share":"yes"}')
    expect(Doctor.format(Doctor.checkProject([file], validate, false))).not.toMatch(upstreamWord)
  })
})

describe("doctor: finding the project config files", () => {
  test("files are found up to the repository root and reported outermost first", () => {
    const repo = path.join(home, "repo")
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
    const root = write(path.join(repo, `${Brand.project.file}.json`), "{}")
    const nested = write(path.join(repo, "a", "b", `${Brand.project.file}.json`), "{}")
    const inDir = write(path.join(repo, Brand.project.dir, `${Brand.project.file}.json`), "{}")

    const found = Doctor.projectFiles(path.join(repo, "a", "b"))
    expect(found).toContain(root)
    expect(found).toContain(nested)
    expect(found).toContain(inDir)
    // Outermost first: the loader merges in this order, so the last one wins.
    expect(found.indexOf(root)).toBeLessThan(found.indexOf(nested))
  })

  test("the walk stops at the repository root", () => {
    const repo = path.join(home, "repo")
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
    const above = write(path.join(home, `${Brand.project.file}.json`), "{}")
    write(path.join(repo, `${Brand.project.file}.json`), "{}")
    expect(Doctor.projectFiles(repo)).not.toContain(above)
  })

  test("the upstream file names are still found, since the loader still reads them", () => {
    const repo = path.join(home, "repo")
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
    const legacy = write(path.join(repo, "opencode.json"), "{}")
    expect(Doctor.projectFiles(repo)).toContain(legacy)
  })

  test("nothing is reported when the project switch is set", () => {
    const repo = path.join(home, "repo")
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
    write(path.join(repo, `${Brand.project.file}.json`), "{}")
    process.env[Brand.env.disableProjectConfig] = "1"
    try {
      expect(Doctor.projectFiles(repo)).toEqual([])
    } finally {
      delete process.env[Brand.env.disableProjectConfig]
    }
  })
})

describe("doctor: the trust check", () => {
  test("a stored trust passes and names the store", () => {
    const line = Doctor.checkTrust("/work/repo", "store", false, "/work/repo")
    expect(line).toMatchObject({ name: "trust", status: "ok" })
    expect(line.detail).toContain(Trust.storeName)
  })

  test("trust from the environment passes and names the variable", () => {
    const line = Doctor.checkTrust("/work/repo", "env", false, "/work/repo")
    expect(line).toMatchObject({ name: "trust", status: "ok" })
    expect(line.detail).toContain(Brand.env.trustWorkspace)
  })

  test("an untrusted workspace warns, says what is dropped, and does not fail", () => {
    const line = Doctor.checkTrust("/work/repo", undefined, false, "/work/repo")
    expect(line).toMatchObject({ name: "trust", status: "warn" })
    expect(line.fix).toBe(`Run ${Brand.name} trust /work/repo.`)
    expect(line.note).toBe(Doctor.TRUST_DROPPED)
    expect(Doctor.format(line)).toContain(Doctor.TRUST_DROPPED)
  })

  test("the fix points at the repository root, not the working directory", () => {
    expect(Doctor.checkTrust("/work/repo/src", undefined, false, "/work/repo").fix).toContain("trust /work/repo.")
  })

  test("no trust line ever names the upstream project", () => {
    // The config directory is the machine's, and the test harness puts it under
    // a path of its own naming; only the wording is this check's business.
    const wording = (line: Doctor.Line) => Doctor.format(line).split(Brand.configDir()).join("<config>")
    for (const by of ["store", "env", undefined] as const) {
      expect(wording(Doctor.checkTrust("/work/repo", by, false, "/work/repo"))).not.toMatch(upstreamWord)
    }
  })
})
