import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawn, spawnSync } from "child_process"
import * as Run from "../../src/rafiki/attempts-run"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function temp() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "attempts-test-")))
  dirs.push(dir)
  return dir
}

const sh = (cwd: string, command: string) => {
  const run = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8" })
  if (run.status !== 0) throw new Error(run.stderr)
  return run.stdout
}

function repo() {
  const dir = temp()
  sh(
    dir,
    [
      "git init -q",
      "git config user.email t@example.com",
      "git config user.name t",
      "printf 'node_modules/\\n.env\\n' > .gitignore",
      "printf 'one\\ntwo\\nthree\\n' > app.txt",
      "git add -A && git commit -qm start",
      "printf 'one\\ntwo\\nthree\\nfour\\n' > app.txt",
      "printf 'draft\\n' > notes.txt",
      "mkdir -p node_modules/dep && printf 'real\\n' > node_modules/dep/index.js",
      "printf 'KEY=1\\n' > .env",
    ].join(" && "),
  )
  return dir
}

// A stand-in for `rafikicode run --format json`: each attempt edits its copy
// in its own way and prints the events a run prints.
function fake(args: string[], dir: string) {
  const index = Number(args[args.indexOf("--title") + 1]!.split(" ")[1])
  const event = (value: unknown) => `printf '%s\\n' '${JSON.stringify(value)}'`
  const scripts: Record<number, string> = {
    1: [
      "test -f notes.txt && test -f .env && test -f node_modules/dep/index.js && grep -q four app.txt",
      "printf 'a\\nb\\nc\\nd\\ne\\n' >> app.txt",
      event({ type: "step_finish", cost: 0.003 }),
      event({ type: "verify", status: "failing", checks: [{ status: "failed" }] }),
      "exit 8",
    ].join(" && "),
    2: [
      "test -f notes.txt",
      "sed -i.bak 's/two/TWO/' app.txt && rm app.txt.bak",
      "mkdir -p __pycache__ .rafiki/memory && printf 'x' > __pycache__/app.pyc && printf 'note' > .rafiki/memory/project.md",
      "printf 'x\\n' > node_modules/dep/added.js",
      event({ type: "step_finish", cost: 0.002 }),
      event({ type: "verify", status: "passed", checks: [{ status: "passed" }] }),
      event({ type: "review", status: "passed", cost: 0.001, criteria: [{ text: "a", pass: true }] }),
    ].join(" && "),
    3: [event({ type: "error", error: { name: "UnknownError", data: { message: "gateway down" } } }), "exit 1"].join(" && "),
  }
  return spawn("sh", ["-c", scripts[index]!], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], detached: true })
}

const worktrees = (dir: string) => sh(dir, "git worktree list --porcelain").match(/^worktree /gm)?.length ?? 0

describe("parallel attempts in a git repository", () => {
  test("the best attempt is applied, the others leave nothing behind", async () => {
    const dir = repo()
    const started: number[] = []
    const summary = await Run.run({
      dir,
      task: "fix it",
      count: 3,
      auto: true,
      spawnRun: fake,
      tpm: 2_000_000,
      staggerMs: 0,
      readSpend: (() => {
        const values = [1.0, 1.0081]
        return async () => values.shift()
      })(),
      onStart: (index) => started.push(index),
    })
    expect(started.sort()).toEqual([0, 1, 2])
    expect(summary.outcomes.map((item) => item.ended)).toEqual(["ok", "ok", "error"])
    expect(summary.outcomes[2]!.error).toBe("gateway down")
    expect(summary.outcomes[0]!.checks).toBe("failing")
    expect(summary.outcomes[1]!.diff).toEqual({ files: 1, added: 1, removed: 1 })
    expect(summary.outcomes[1]!.cost).toBeCloseTo(0.003)
    expect(summary.winner?.index).toBe(1)
    expect(summary.applied).toBe(true)
    expect(summary.totalSource).toBe("key_spend")
    expect(summary.total).toBeCloseTo(0.0081)
    // The winner's change on top of the uncommitted one; the rest untouched.
    expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("one\nTWO\nthree\nfour\n")
    expect(fs.readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("draft\n")
    expect(fs.existsSync(path.join(dir, "__pycache__"))).toBe(false)
    expect(fs.existsSync(path.join(dir, ".rafiki"))).toBe(false)
    expect(fs.readFileSync(path.join(dir, "node_modules/dep/index.js"), "utf8")).toBe("real\n")
    // Dependency folders are shared with the copies, so what an attempt adds there stays.
    expect(fs.existsSync(path.join(dir, "node_modules/dep/added.js"))).toBe(true)
    expect(worktrees(dir)).toBe(1)
    expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("rafikicode-attempts-"))).toEqual([])
  })

  test("nothing is applied when no attempt made a usable change", async () => {
    const dir = repo()
    const summary = await Run.run({
      dir,
      task: "fix it",
      count: 2,
      auto: true,
      spawnRun: (args, cwd) => spawn("sh", ["-c", "exit 1"], { cwd, stdio: ["ignore", "pipe", "pipe"] }),
      tpm: 200_000,
      staggerMs: 0,
      readSpend: async () => undefined,
    })
    expect(summary.winner).toBeUndefined()
    expect(summary.applied).toBe(false)
    expect(summary.totalSource).toBe("attempts")
    expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("one\ntwo\nthree\nfour\n")
    expect(worktrees(dir)).toBe(1)
  })

  test("a winner that no longer applies is saved as a patch", async () => {
    const dir = repo()
    const summary = await Run.run({
      dir,
      task: "fix it",
      count: 2,
      auto: true,
      spawnRun: (args, cwd) => {
        // The real file changes while the attempts run.
        fs.writeFileSync(path.join(dir, "app.txt"), "changed meanwhile\n")
        return spawn("sh", ["-c", "printf 'one\\nother\\nthree\\nfour\\n' > app.txt"], { cwd, stdio: ["ignore", "pipe", "pipe"] })
      },
      tpm: 200_000,
      staggerMs: 0,
      readSpend: async () => undefined,
    })
    expect(summary.winner).toBeDefined()
    expect(summary.applied).toBe(false)
    expect(summary.patchFile && fs.existsSync(summary.patchFile)).toBe(true)
    fs.rmSync(summary.patchFile!)
    expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("changed meanwhile\n")
  })
})

describe("stopping the attempts", () => {
  test("an abort stops every child, removes the copies and applies nothing", async () => {
    const dir = repo()
    const controller = new AbortController()
    const children: ReturnType<typeof spawn>[] = []
    const summary = await Run.run({
      dir,
      task: "fix it",
      count: 2,
      auto: true,
      signal: controller.signal,
      spawnRun: (args, cwd) => {
        const child = spawn("sh", ["-c", "printf 'x\\n' >> app.txt; sleep 30"], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true })
        children.push(child)
        if (children.length === 2) setTimeout(() => controller.abort(), 300)
        return child
      },
      tpm: undefined,
      staggerMs: 0,
      readSpend: async () => undefined,
    })
    expect(summary.applied).toBe(false)
    expect(summary.winner).toBeUndefined()
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true)
    expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("one\ntwo\nthree\nfour\n")
    expect(worktrees(dir)).toBe(1)
  })
})

describe("parallel attempts in a folder without git", () => {
  test("a copy per attempt, and the change applied to the folder", async () => {
    const dir = temp()
    sh(dir, "printf 'one\\n' > a.txt && mkdir -p node_modules/x && printf 'dep\\n' > node_modules/x/i.js")
    const summary = await Run.run({
      dir,
      task: "fix it",
      count: 2,
      auto: false,
      spawnRun: (args, cwd) => {
        const index = Number(args[args.indexOf("--title") + 1]!.split(" ")[1])
        const script =
          index === 1
            ? "test -f node_modules/x/i.js && printf 'one\\ntwo\\n' > a.txt && printf 'new\\nnew\\nnew\\n' > b.txt"
            : "printf 'uno\\n' > a.txt"
        return spawn("sh", ["-c", script], { cwd, stdio: ["ignore", "pipe", "pipe"] })
      },
      tpm: undefined,
      staggerMs: 0,
      readSpend: async () => undefined,
    })
    expect(summary.outcomes[0]!.diff).toEqual({ files: 2, added: 4, removed: 0 })
    // Same checks and criteria: the smaller diff wins.
    expect(summary.winner?.index).toBe(1)
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("uno\n")
    expect(fs.existsSync(path.join(dir, "b.txt"))).toBe(false)
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false)
    expect(fs.readFileSync(path.join(dir, "node_modules/x/i.js"), "utf8")).toBe("dep\n")
  })
})

describe("the command line of an attempt", () => {
  test("the binary itself, or the runtime and the entry file from source", () => {
    expect(Run.self(["run"], "/p", ["/bin/rafikicode", "/$bunfs/root/index.js"], "/bin/rafikicode")).toEqual({
      file: "/bin/rafikicode",
      args: ["run"],
      cwd: "/p",
    })
    expect(Run.self(["run"], "/p", ["/usr/bin/bun", "/src/pkg/src/index.ts"], "/usr/bin/bun")).toEqual({
      file: "/usr/bin/bun",
      args: ["/src/pkg/src/index.ts", "run"],
      cwd: "/src/pkg",
    })
  })
})
