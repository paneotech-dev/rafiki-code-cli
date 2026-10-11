// The verify step's rules (rafiki/verify.ts): finding the checks, choosing the
// narrowest ones for a change, running them within the budget, and the lines
// the model and the user read.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as Verify from "../../src/rafiki/verify"
import * as CachePrefix from "../../src/rafiki/cache-prefix"
import { withVerifyRounds } from "../../src/rafiki/cost"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-verify-"))
  Verify.clearCache()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function write(file: string, text = "") {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), text)
}

const yes = () => true
const no = () => false

describe("switches", () => {
  test("on by default; RAFIKICODE_VERIFY wins over the config", () => {
    expect(Verify.enabled(undefined, {})).toBe(true)
    expect(Verify.enabled({ enabled: false }, {})).toBe(false)
    expect(Verify.enabled({ enabled: false }, { RAFIKICODE_VERIFY: "1" })).toBe(true)
    expect(Verify.enabled(undefined, { RAFIKICODE_VERIFY: "off" })).toBe(false)
    expect(Verify.enabled(undefined, { RAFIKICODE_VERIFY: "maybe" })).toBe(true)
  })

  test("budget and rounds have defaults and caps", () => {
    expect(Verify.timeout(undefined)).toBe(120)
    expect(Verify.timeout({ timeout: 1 })).toBe(5)
    expect(Verify.timeout({ timeout: 99999 })).toBe(1800)
    expect(Verify.rounds(undefined)).toBe(2)
    expect(Verify.rounds({ rounds: 0 })).toBe(0)
    expect(Verify.rounds({ rounds: 50 })).toBe(5)
  })
})

describe("AGENTS.md", () => {
  test("a verify section lists the commands, from code blocks and code list items", () => {
    const text = [
      "# Project",
      "## Verify",
      "Run these before calling a change done:",
      "```sh",
      "# comment",
      "$ bun run typecheck",
      "bun test --timeout 30000",
      "```",
      "- `make lint`",
      "## Other",
      "- `not this`",
    ].join("\n")
    expect(Verify.verifySection(text)).toEqual(["bun run typecheck", "bun test --timeout 30000", "make lint"])
  })

  test("a verify: line works too, and no section means undefined", () => {
    expect(Verify.verifySection("Notes\nverify: `npm test`\n")).toEqual(["npm test"])
    expect(Verify.verifySection("# Nothing here\n")).toBeUndefined()
  })

  test("commands named for testing, linting and building", () => {
    const text = [
      "- Run the tests with `pytest -q` from the root.",
      "- Lint: `ruff check .`",
      "- Type check with `mypy src`",
      "- The editor is `vim` and the build uses `make dist`",
      "- Say `hello` to the test team",
    ].join("\n")
    expect(Verify.agentsCommands(text)).toEqual([
      { kind: "test", command: "pytest -q" },
      { kind: "lint", command: "ruff check ." },
      { kind: "typecheck", command: "mypy src" },
      { kind: "build", command: "make dist" },
    ])
  })
})

describe("finding the checks", () => {
  test("package.json scripts with the package manager of the lock file", () => {
    write("package.json", JSON.stringify({ scripts: { test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit", build: "vite build" } }))
    write("pnpm-lock.yaml")
    const plan = Verify.detect(dir, undefined, no)
    expect(plan.source).toBe("detected")
    expect(plan.checks).toEqual([
      { kind: "typecheck", command: "pnpm run typecheck" },
      { kind: "lint", command: "pnpm run lint" },
      { kind: "test", command: "pnpm run test", narrow: { runner: "js", base: "pnpm run test" } },
    ])
  })

  test("npm's placeholder test script is not a check; build is used without a type check", () => {
    write("package.json", JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: "tsc" } }))
    expect(Verify.detect(dir, undefined, no).checks).toEqual([{ kind: "build", command: "npm run build" }])
  })

  test("Python with pytest installed", () => {
    write("pyproject.toml", "[tool.pytest.ini_options]\n")
    const plan = Verify.detect(dir, undefined, yes)
    const test = plan.checks.find((check) => check.kind === "test")!
    expect(test.command).toMatch(/^python3? -m pytest -q -x -p no:cacheprovider$/)
    expect(test.narrow?.runner).toBe("pytest")
  })

  test("Python with a bin/test runner and no pytest", () => {
    write("setup.py")
    write("bin/test")
    const test = Verify.detect(dir, undefined, no).checks.find((check) => check.kind === "test")!
    expect(test.command).toMatch(/^python3? bin\/test$/)
    expect(test.narrow?.runner).toBe("python-bin-test")
  })

  test("Go, Rust and PHP", () => {
    write("go.mod", "module x\n")
    expect(Verify.detect(dir, undefined, no).checks.map((check) => check.command)).toEqual(["go vet ./...", "go test ./..."])
    fs.rmSync(path.join(dir, "go.mod"))
    write("Cargo.toml")
    expect(Verify.detect(dir, undefined, no).checks.map((check) => check.command)).toEqual(["cargo check --quiet", "cargo test --quiet"])
    fs.rmSync(path.join(dir, "Cargo.toml"))
    write("composer.json", JSON.stringify({ scripts: { test: "phpunit" } }))
    write("vendor/bin/phpunit")
    write("phpunit.xml.dist")
    expect(Verify.detect(dir, undefined, no).checks).toEqual([
      { kind: "test", command: "vendor/bin/phpunit", narrow: { runner: "phpunit", base: "vendor/bin/phpunit" } },
    ])
  })

  test("Makefile targets and AGENTS.md fill the kinds the project files do not give", () => {
    write("package.json", JSON.stringify({ scripts: { test: "jest" } }))
    write("Makefile", "lint:\n\techo lint\ntest:\n\tjest\nVAR := 1\n")
    write("AGENTS.md", "Type check with `npm run tsc:check`.\n")
    const checks = Verify.detect(dir, undefined, no).checks
    expect(checks.map((check) => `${check.kind}:${check.command}`)).toEqual([
      "test:npm run test",
      "typecheck:npm run tsc:check",
      "lint:make lint",
    ])
  })

  test("a verify section in AGENTS.md replaces detection, and the config replaces both", () => {
    write("package.json", JSON.stringify({ scripts: { test: "jest" } }))
    write("AGENTS.md", "## Verify\n- `npm run check`\n")
    expect(Verify.detect(dir, undefined, no)).toEqual({ source: "agents", checks: [{ kind: "check", command: "npm run check" }] })
    expect(Verify.detect(dir, { commands: ["make ci"] }, no)).toEqual({ source: "config", checks: [{ kind: "check", command: "make ci" }] })
  })

  test("the result is kept per project until a file it came from changes", () => {
    write("package.json", JSON.stringify({ scripts: { test: "jest" } }))
    let probes = 0
    const probe = () => {
      probes++
      return false
    }
    Verify.detect(dir, undefined, probe)
    const first = Verify.detect(dir, undefined, probe)
    expect(Verify.detect(dir, undefined, probe)).toBe(first)
    write("package.json", JSON.stringify({ scripts: { test: "jest", lint: "eslint ." } }))
    const second = Verify.detect(dir, undefined, probe)
    expect(second).not.toBe(first)
    expect(second.checks.map((check) => check.kind)).toContain("lint")
  })

  test("nothing found", () => {
    write("notes.md", "hello")
    expect(Verify.detect(dir, undefined, no)).toEqual({ source: "detected", checks: [] })
  })
})

describe("choosing what to run", () => {
  const pytest: Verify.Plan = {
    source: "detected",
    checks: [
      { kind: "lint", command: "ruff check ." },
      { kind: "test", command: "python -m pytest -q", narrow: { runner: "pytest", base: "python -m pytest -q" } },
    ],
  }

  test("Python: the test file named after the module comes first, then wider checks without the full suite", () => {
    const listing = ["src/flask/config.py", "tests/test_config.py", "tests/test_cli.py", "src/flask/cli.py"]
    expect(Verify.select(pytest, dir, ["src/flask/config.py"], listing)).toEqual([
      { kind: "test", scope: "narrow", command: "python -m pytest -q tests/test_config.py" },
      { kind: "lint", scope: "wide", command: "ruff check ." },
    ])
  })

  test("Python: test files that import the module, then the package's tests folder", () => {
    write("pkg/core/tests/test_numbers.py", "from pkg.core.mod import Mod\n")
    write("pkg/core/tests/test_other.py", "import os\n")
    const listing = ["pkg/core/mod.py", "pkg/core/tests/test_numbers.py", "pkg/core/tests/test_other.py"]
    expect(Verify.pythonTests(dir, ["pkg/core/mod.py"], listing)).toEqual(["pkg/core/tests/test_numbers.py"])
    expect(Verify.pythonTests(dir, ["pkg/core/power.py"], listing)).toEqual(["pkg/core/tests"])
  })

  test("Python: a changed test file runs itself", () => {
    expect(Verify.pythonTests(dir, ["tests/test_a.py"], ["tests/test_a.py"])).toEqual(["tests/test_a.py"])
  })

  test("no narrow test: the full test suite runs as a wide check", () => {
    expect(Verify.select(pytest, dir, ["setup.py"], ["setup.py"]).map((step) => step.command)).toEqual([
      "ruff check .",
      "python -m pytest -q",
    ])
  })

  test("JavaScript: test files next to or named after the changed source", () => {
    const listing = ["src/a/util.ts", "src/a/util.test.ts", "test/b/util.spec.ts", "src/other.test.ts"]
    expect(Verify.jsTests(["src/a/util.ts"], listing)).toEqual(["src/a/util.test.ts", "test/b/util.spec.ts"])
    const plan: Verify.Plan = { source: "detected", checks: [{ kind: "test", command: "npm run test", narrow: { runner: "js", base: "npm run test --" } }] }
    expect(Verify.select(plan, dir, ["src/a/util.ts"], listing)[0].command).toBe("npm run test -- src/a/util.test.ts test/b/util.spec.ts")
  })

  test("Go: the packages of the changed files", () => {
    const plan = Verify.detect((write("go.mod"), dir), undefined, no)
    expect(Verify.select(plan, dir, ["internal/x/a.go", "internal/x/b.go", "main.go"], [])).toEqual([
      { kind: "test", scope: "narrow", command: "go test ./internal/x ." },
      { kind: "build", scope: "wide", command: "go vet ./..." },
    ])
  })

  test("configured commands run as given, with {files} replaced", () => {
    const plan: Verify.Plan = { source: "config", checks: [{ kind: "check", command: "lint {files}" }, { kind: "check", command: "make ci" }] }
    expect(Verify.select(plan, dir, ["a b.py", "c.py"], []).map((step) => step.command)).toEqual(
      process.platform === "win32" ? ['lint "a b.py" c.py', "make ci"] : ["lint 'a b.py' c.py", "make ci"],
    )
  })

  test("documentation only is not verified", () => {
    expect(Verify.onlyDocs(["README.md", "docs/a.rst", "LICENSE", "img/logo.png"])).toBe(true)
    expect(Verify.onlyDocs(["README.md", "src/a.py"])).toBe(false)
  })

  test("changed files outside the project or in the tool's folders are left out", () => {
    expect(Verify.relevant("/p", ["/p/src/a.py", "/elsewhere/b.py", "/p/.rafiki/memory/progress.md", "/p/.opencode/x"])).toEqual(["src/a.py"])
  })
})

describe("running", () => {
  const step = (command: string): Verify.Step => ({ kind: "test", scope: "narrow", command })

  test("a real command: output and exit code are kept, and the first failure stops the rest", async () => {
    const result = await Verify.run({
      steps: [step("echo fine"), step("echo broken && exit 3"), step("echo never")],
      cwd: dir,
      budget: 60,
    })
    expect(result.status).toBe("failing")
    expect(result.steps.map((item) => item.status)).toEqual(["passed", "failed"])
    expect(result.steps[1].exit).toBe(3)
    expect(result.steps[1].output).toContain("broken")
  })

  test("a command past the budget is stopped and reported as not finished, not as failing", async () => {
    const started = Date.now()
    const result = await Verify.run({ steps: [step("sleep 30"), step("echo later")], cwd: dir, budget: 2 })
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(result.status).toBe("incomplete")
    expect(result.steps.map((item) => item.status)).toEqual(["timeout", "skipped"])
  }, 30_000)

  test("missing tools are reported as unavailable", () => {
    expect(Verify.classify(step("python -m pytest"), 1, "/usr/bin/python: No module named pytest", false)).toBe("unavailable")
    expect(Verify.classify(step("phpunit"), 127, "", false)).toBe("unavailable")
    expect(Verify.classify(step("python -m pytest x.py"), 5, "no tests ran", false)).toBe("passed")
    expect(Verify.classify(step("npm test"), 1, "1 failed", false)).toBe("failed")
  })

  test("the overall status", () => {
    const item = (status: Verify.StepStatus): Verify.StepResult => ({ ...step("x"), status, exit: 0, seconds: 1, output: "" })
    expect(Verify.summarize([])).toBe("none")
    expect(Verify.summarize([item("passed"), item("failed")])).toBe("failing")
    expect(Verify.summarize([item("passed"), item("timeout")])).toBe("incomplete")
    expect(Verify.summarize([item("unavailable")])).toBe("unavailable")
    expect(Verify.summarize([item("passed"), item("unavailable")])).toBe("passed")
  })
})

describe("what the model and the user read", () => {
  const failing: Verify.Result = {
    status: "failing",
    budget: 120,
    steps: [
      { kind: "test", scope: "narrow", command: "pytest tests/test_a.py", status: "failed", exit: 1, seconds: 2.5, output: "FAILED tests/test_a.py::test_x - AssertionError" },
    ],
  }

  test("the failure sent back names the command, its exit code and its output", () => {
    const text = Verify.feedback(failing, 1, 2)
    expect(text).toContain("verify round 1 of 2")
    expect(text).toContain("$ pytest tests/test_a.py")
    expect(text).toContain("exit code 1 after 2.5 s")
    expect(text).toContain("AssertionError")
    expect(text).toContain("Do not weaken or delete tests")
  })

  test("a round that fails exactly like the one before is the same failure", () => {
    expect(Verify.sameFailure(undefined, failing)).toBe(false)
    expect(Verify.sameFailure(failing, { ...failing, steps: [{ ...failing.steps[0], seconds: 9 }] })).toBe(true)
    expect(Verify.sameFailure(failing, { ...failing, steps: [{ ...failing.steps[0], output: "other" }] })).toBe(false)
  })

  test("the line added to the answer", () => {
    expect(Verify.finalLine(failing, 2)).toBe("checks failing: pytest tests/test_a.py (exit code 1) after 2 fix rounds. The changes are not verified.")
    expect(Verify.finalLine({ ...failing, status: "passed", steps: [{ ...failing.steps[0], status: "passed", exit: 0 }] }, 0)).toBe(
      "checks passed: pytest tests/test_a.py",
    )
    expect(Verify.finalLine({ status: "none", steps: [], budget: 120 }, 0)).toContain("no checks found for this project")
    expect(Verify.finalLine({ ...failing, status: "incomplete", steps: [{ ...failing.steps[0], status: "timeout" }] }, 0)).toBe(
      "checks not finished within 120 s: pytest tests/test_a.py",
    )
    expect(Verify.statusLine("failing")).toBe("checks failing")
    expect(Verify.summary(undefined)).toEqual({ status: "not_run" })
  })

  test("the working practice goes first in the stable system text", () => {
    const system = CachePrefix.order({ environment: ["env"], instructions: ["agents"], practice: Verify.PRACTICE }, new Date(0))
    expect(system[0]).toBe(Verify.PRACTICE)
    expect(system.slice(1, 3)).toEqual(["agents", "env"])
    expect(Verify.PRACTICE).toContain("reproduce it first")
    expect(CachePrefix.order({ environment: ["env"], instructions: [] }, new Date(0))[0]).toBe("env")
  })
})

describe("a turn", () => {
  const user = (id: string, feedback = false) => ({
    info: { id, role: "user", sessionID: "s", time: { created: 1 } },
    parts: [{ type: "text", text: "x", ...(feedback ? { metadata: { verify: { kind: "feedback" } } } : {}) }],
  })
  const assistant = (id: string, parentID: string, parts: unknown[]) => ({
    info: { id, role: "assistant", parentID, sessionID: "s", time: { created: 2 } },
    parts,
  })

  test("files from patches, edits, writes and applied patches since the user's last message, and the rounds so far", () => {
    const messages = [
      user("u0"),
      assistant("a0", "u0", [{ type: "patch", files: ["/p/old.py"] }]),
      user("u1"),
      assistant("a1", "u1", [
        { type: "patch", files: ["/p/a.py"] },
        { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "b.py" } } },
        { type: "tool", tool: "write", state: { status: "error", input: { filePath: "c.py" } } },
      ]),
      user("u2", true),
      assistant("a2", "u2", [
        { type: "tool", tool: "apply_patch", state: { status: "completed", input: {}, metadata: { files: [{ filePath: "/p/d.py", movePath: "/p/e.py" }] } } },
      ]),
    ] as never
    const turn = Verify.turn(messages, "/p")
    expect(turn.files.toSorted()).toEqual(["/p/a.py", "/p/b.py", "/p/e.py"])
    expect(turn.rounds).toBe(1)
  })

  test("a fix round counts as the turn it follows on the Task: line", () => {
    const items = [user("u1"), assistant("a1", "u1", []), user("u2", true), assistant("a2", "u2", []), user("u3"), assistant("a3", "u3", [])]
    expect(withVerifyRounds(items as never).map((info) => info.parentID)).toEqual([undefined, "u1", undefined, "u1", undefined, "u3"])
  })
})
