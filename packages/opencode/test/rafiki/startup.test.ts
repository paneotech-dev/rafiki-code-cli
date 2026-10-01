// What a user sees when rafikicode cannot start.
//
// Every case here drives the real binary as a subprocess and asserts on the
// bytes that reach the terminal plus the exit code, because that is the whole
// point of the diagnosis layer: a test that only proves a function was called
// proves nothing about what the user reads.
//
// Startup failures of a given shape are produced with
// RAFIKICODE_TEST_STARTUP_ERROR, which makes src/index.ts throw an error with
// that exact message (the dlopen case below is the verbatim text from the
// session that prompted this work). Two cases need no injection at all: a
// terminal that cannot host the full screen interface, and a home directory
// that cannot be written.
import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as Startup from "../../src/rafiki/startup"
import * as ExecTmp from "../../src/rafiki/exec-tmp"

const root = path.resolve(import.meta.dir, "../..")

// The verbatim failure from the real session: a shared host with /tmp mounted
// noexec, reported to the user as "Error: Unexpected error" and a dlopen string.
const NOEXEC =
  'Failed to initialize OpenTUI render library: Failed to open library "/tmp/.9adb7abbf6e5efff-00000001.so": /tmp/.9adb7abbf6e5efff-00000001.so: failed to map segment from shared object'

async function run(args: string[], extra: Record<string, string | undefined> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-startup-"))
  const env: Record<string, string | undefined> = {
    ...process.env,
    COLUMNS: "120",
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    RAFIKICODE_API_KEY: "sk-test-startup",
  }
  delete env["XDG_CONFIG_HOME"]
  delete env["CI"]
  delete env["GITHUB_ACTIONS"]
  delete env["RAFIKICODE_TEST_TTY"]
  delete env["RAFIKICODE_VERBOSE"]
  delete env["RAFIKICODE_TEST_STARTUP_ERROR"]
  delete env["OPENCODE_PRINT_LOGS"]
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: env as Record<string, string>,
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {}
  return { exitCode, stdout, stderr, all: stdout + stderr }
}

describe("startup diagnosis in the terminal", () => {
  test("the noexec dlopen failure names its cause, a step to paste, the ways out and the original error", async () => {
    const result = await run([], { RAFIKICODE_TEST_STARTUP_ERROR: NOEXEC })

    // The line that made a real user give up is gone.
    expect(result.all).not.toContain("Unexpected error")

    expect(result.all).toContain("Rafiki Code cannot start: a library it needs could not be loaded on this machine.")
    // The cause is the temporary directory probe's own, measured on this
    // machine, not a guess read off the error text: that it probed at all is
    // the absence of the text the fallback would have printed.
    expect(result.all).toContain("Probable cause:")
    expect(result.all).not.toContain("does not allow an executable file to be loaded from it")
    expect(result.all).toContain("noexec")
    // The directory it tested is named, whichever verdict it reached.
    expect(result.all).toContain("/tmp")
    // The sentence users need: they arrive at this certain their account or
    // their key is broken, and it is neither.
    expect(result.all).toContain("your sign in and your key are fine")
    // One command, pasteable as printed: indented on a line of its own.
    expect(result.all).toMatch(/^ {2}\S/m)
    // The escape hatches, every time.
    expect(result.all).toContain("rafikicode doctor")
    expect(result.all).toContain('rafikicode run "your task"')
    // Nothing swallowed: the original text is still on stderr, verbatim.
    expect(result.stderr).toContain(`Original error: ${NOEXEC}`)
    expect(result.all).toContain("--print-logs")
    // The machine cannot run it: not 1, and not the not-signed-in code 2.
    expect(result.exitCode).toBe(6)
  }, 30_000)

  test("--print-logs adds the full error and its stack", async () => {
    const result = await run(["--print-logs"], { RAFIKICODE_TEST_STARTUP_ERROR: NOEXEC })

    expect(result.stderr).toContain(`Original error: ${NOEXEC}`)
    expect(result.stderr).toMatch(/\n\s+at .+index\.ts/)
    expect(result.exitCode).toBe(6)
  }, 30_000)

  test("an illegal instruction is reported as a bug, and not sent for a reinstall that changes nothing", async () => {
    const result = await run([], { RAFIKICODE_TEST_STARTUP_ERROR: "Illegal instruction (core dumped)" })

    expect(result.all).toContain("Rafiki Code cannot start: it stopped on an instruction this machine's CPU would not run.")
    // No reinstall: the four archives labelled "baseline" are byte identical
    // to their siblings, and the binary has been driven on an emulated 2008
    // CPU with neither AVX nor AVX2, so there is no other build to fetch.
    expect(result.all).not.toContain("curl -fsSL https://get.rafikiai.io | bash")
    expect(result.all).not.toContain("baseline")
    // A build that will not execute here is not helped by another command.
    expect(result.all).not.toContain('rafikicode run "your task"')
    expect(result.all).toContain("report it at")
    // Something to put in the report: which CPU this happened on.
    expect(result.all).toContain("lscpu")
    expect(result.stderr).toContain("Original error: Illegal instruction (core dumped)")
    expect(result.exitCode).toBe(6)
  }, 30_000)

  test("a glibc version mismatch names the version asked for", async () => {
    const message =
      "/home/u/.rafikicode/bin/rafikicode: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.32' not found"
    const result = await run([], { RAFIKICODE_TEST_STARTUP_ERROR: message })

    expect(result.all).toContain("does not match the system C library")
    expect(result.all).toContain("GLIBC_2.32")
    expect(result.all).toContain("curl -fsSL https://get.rafikiai.io | bash")
    expect(result.stderr).toContain(`Original error: ${message}`)
    expect(result.exitCode).toBe(6)
  }, 30_000)

  test("a musl loader failure says which C library this machine uses", async () => {
    const message = "Error relocating /root/.rafikicode/bin/rafikicode: ld-musl-x86_64.so.1: symbol not found"
    const result = await run([], { RAFIKICODE_TEST_STARTUP_ERROR: message })

    expect(result.all).toContain("musl (Alpine Linux and similar)")
    expect(result.exitCode).toBe(6)
  }, 30_000)

  test("a home directory it cannot write to is reported without any injected error", async () => {
    // No RAFIKICODE_TEST_STARTUP_ERROR: this crash happens for real, while
    // the module graph is still loading, and used to print a raw runtime dump.
    const broken = "/dev/null/no-home"
    const result = await run(["models"], {
      HOME: broken,
      OPENCODE_TEST_HOME: broken,
      XDG_DATA_HOME: undefined,
      XDG_STATE_HOME: undefined,
      XDG_CACHE_HOME: undefined,
    })

    expect(result.all).not.toContain("Unexpected error")
    expect(result.all).toContain("Rafiki Code cannot start: it has no directory it can write to.")
    expect(result.all).toContain("ENOTDIR")
    expect(result.all).toContain("HOME=/path/you/own rafikicode")
    expect(result.stderr).toContain("Original error: ENOTDIR: not a directory, mkdir")
    expect(result.exitCode).toBe(6)
  }, 30_000)

  test("a terminal that cannot draw is told so, and pointed at the run command, with no injected error", async () => {
    // stdout is a pipe here, which is exactly the no-TTY case.
    const result = await run([])

    expect(result.all).not.toContain("Unexpected error")
    expect(result.all).toContain("standard output is not a terminal")
    expect(result.all).toContain('rafikicode run "your task"')
    expect(result.all).toContain("rafikicode doctor")
    // Runs here, just not as a full screen interface: its own code, not 6.
    expect(result.exitCode).toBe(7)
  }, 30_000)

  test("attach says the same thing, before it goes near the server", async () => {
    // Nothing listens on port 1: if the terminal were not checked first, this
    // would fail with a connection error instead.
    const result = await run(["attach", "http://127.0.0.1:1"])

    expect(result.all).toContain("standard output is not a terminal")
    expect(result.all).toContain('rafikicode run "your task"')
    expect(result.exitCode).toBe(7)
  }, 30_000)

  test("a failure with no diagnosis still gets a way out and keeps its text", async () => {
    const message = "Cannot find package 'react' imported from /opt/rafikicode/tui/config/index.tsx"
    const result = await run([], { RAFIKICODE_TEST_STARTUP_ERROR: message })

    expect(result.all).not.toContain("Unexpected error")
    expect(result.all).toContain("Rafiki Code stopped with a failure it has no diagnosis for.")
    expect(result.all).toContain("rafikicode doctor")
    expect(result.all).toContain('rafikicode run "your task"')
    expect(result.all).toContain("report it at")
    expect(result.stderr).toContain(`Original error: ${message}`)
    // An unrecognised failure keeps the exit code it always had.
    expect(result.exitCode).toBe(1)
  }, 30_000)

  test("the run command works where the full screen interface cannot start", async () => {
    // The proof that the escape hatch is real: run gets all the way to the
    // gateway with no render library in the picture, on the same terminal
    // where the full screen interface refuses to start with 7. The test key
    // is rejected (2), or the gateway is unreachable from this machine (4);
    // either way the render library never came into it.
    const result = await run(["run", "say hi"])

    expect(result.all).not.toContain("render library")
    expect(result.all).not.toContain("Unexpected error")
    expect(result.all).not.toContain("has no diagnosis for")
    // Both are codes a script can tell apart from 6 and 7.
    expect([2, 4]).toContain(result.exitCode)
  }, 60_000)
})

describe("startup diagnosis", () => {
  test("classifies by what the error says", () => {
    expect(Startup.diagnose(new Error(NOEXEC)).kind).toBe("native_library")
    expect(Startup.diagnose(new Error("Illegal instruction")).kind).toBe("illegal_instruction")
    expect(Startup.diagnose(new Error("libc.so.6: version `GLIBC_2.32' not found")).kind).toBe("libc_mismatch")
    expect(Startup.diagnose(new Error("inappropriate ioctl for device")).kind).toBe("terminal")
    expect(Startup.diagnose(new Error("nothing recognisable")).kind).toBe("unknown")
  })

  test("reads code and path from a filesystem error and leaves a project file alone", () => {
    const mine = Object.assign(new Error("EACCES: permission denied, mkdir '/home/u/.rafikicode'"), {
      code: "EACCES",
      path: "/home/u/.rafikicode",
    })
    expect(Startup.diagnose(mine).kind).toBe("no_writable_directory")
    expect(Startup.diagnose(mine).exitCode).toBe(6)

    const theirs = Object.assign(new Error("EACCES: permission denied, open '/srv/app/secret.env'"), {
      code: "EACCES",
      path: "/srv/app/secret.env",
    })
    expect(Startup.diagnose(theirs).kind).toBe("unknown")
  })

  test("names the terminal condition it found", () => {
    const env = { TERM: "xterm-256color" }
    expect(Startup.terminal(env, { isTTY: false })?.headline).toContain("standard output is not a terminal")
    expect(Startup.terminal({ TERM: "dumb" }, { isTTY: true, columns: 80, rows: 24 })?.cause).toContain(
      'TERM is "dumb"',
    )
    expect(Startup.terminal(env, { isTTY: true, columns: 8, rows: 2 })?.cause).toContain("8 columns by 2 rows")
    expect(Startup.terminal(env, { isTTY: true, columns: 80, rows: 24 })).toBeUndefined()
    // The switch the test suites use to drive the full screen interface.
    expect(Startup.terminal({ ...env, RAFIKICODE_TEST_TTY: "1" }, { isTTY: false })).toBeUndefined()
  })

  // The two halves of a render library failure, each driven without needing a
  // machine in that state: a noexec mount cannot be created everywhere, and a
  // machine whose temporary directory works cannot be made to fail. The probe
  // is injected, the words it produces are its real ones, and the report around
  // them is the one every other class gets.
  test("no temporary directory will run a file: every directory tried, why, and the line to send the host", () => {
    const dirs = ["/home/me/.cache/rafikicode/tmp", "/home/me/.rafikicode/tmp"]
    const detail = ExecTmp.explain(new Error(NOEXEC), dirs, () => "noexec")!
    const diagnosis = Startup.diagnose(new Error(NOEXEC), () => detail)
    const text = Startup.render(diagnosis, new Error(NOEXEC))

    expect(diagnosis.kind).toBe("native_library")
    // The code this class was created for, which is what a script branches on.
    expect(diagnosis.exitCode).toBe(6)
    expect(text).toContain("Rafiki Code cannot start: a library it needs could not be loaded on this machine.")
    expect(text).toContain("Probable cause: no temporary directory on this machine will run a file.")
    expect(text).toContain("Directories tried:")
    for (const dir of dirs) expect(text).toContain(dir)
    expect(text).toContain('mounted "noexec", so a file written there cannot be run')
    expect(text).toContain("your sign in and your key are fine")
    // The command to type and the line to send whoever runs the machine.
    expect(text).toContain("TMPDIR=/that/directory rafikicode")
    expect(text).toContain("not mounted noexec, or allow execution under my home directory")
    expect(text).toContain("rafikicode doctor")
    expect(text).toContain('rafikicode run "your task"')
    expect(text).toContain(`Original error: ${NOEXEC}`)
    expect(text).toContain("--print-logs")
  })

  test("a temporary directory that does run a file is ruled out by name, not blamed", () => {
    const detail = ExecTmp.explain(new Error(NOEXEC), [], () => "ok")!
    const text = Startup.render(Startup.diagnose(new Error(NOEXEC), () => detail), new Error(NOEXEC))

    expect(text).toContain('a temporary directory mounted "noexec", is not this')
    expect(text).toContain("/tmp/.9adb7abbf6e5efff-00000001.so could not be mapped")
    expect(text).toContain("ldd --version")
    // Nothing was at fault, so nothing is listed as if it were.
    expect(text).not.toContain("Directories tried")
    expect(text).toContain("your sign in and your key are fine")
    expect(text).toContain("report it at")
    expect(text).toContain(`Original error: ${NOEXEC}`)
  })

  test("looks through a wrapped error to the cause that names the problem, and prints both", () => {
    const wrapped = new Error("Failed to start the full screen interface", { cause: new Error(NOEXEC) })

    expect(Startup.diagnose(wrapped).kind).toBe("native_library")
    const text = Startup.render(Startup.diagnose(wrapped), wrapped)
    expect(text).toContain("Original error: Failed to start the full screen interface")
    expect(text).toContain(`Caused by: ${NOEXEC}`)
  })

  test("every diagnosis carries a cause, a pasteable step and an exit code that means something", () => {
    const errors = [
      new Error(NOEXEC),
      new Error("Illegal instruction"),
      new Error("libc.so.6: version `GLIBC_2.32' not found"),
      new Error("inappropriate ioctl for device"),
      new Error("nothing recognisable"),
    ]
    for (const error of errors) {
      const diagnosis = Startup.diagnose(error)
      expect(diagnosis.cause).toContain("Probable cause")
      expect(diagnosis.step.split("\n").length).toBeGreaterThan(1)
      expect([1, 6, 7]).toContain(diagnosis.exitCode)
      // The original text is never dropped from the report.
      expect(Startup.render(diagnosis, error)).toContain(error.message)
    }
  })
})
