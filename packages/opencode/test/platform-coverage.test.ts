// The rules that decide which released binaries were actually executed, and
// which ones are duplicates wearing a different name. The facts here are the
// ones the 0.1.7 release got wrong: twelve published targets, four baseline
// archives byte identical to their siblings, and a smoke test that only ever
// started the glibc x64 pair on an AVX2 runner.
import { describe, expect, test } from "bun:test"
import {
  baselineCollisions,
  coverageRows,
  duplicateGroups,
  duplicateWarning,
  renderReport,
  runCaveat,
  skipReason,
  type BuiltBinary,
  type HostSpec,
} from "../script/platform-coverage.ts"

// The release runner: Linux x64, glibc, and a CPU that has AVX2.
const runner: HostSpec = { os: "linux", arch: "x64", avx2: true }

const target = (over: Partial<BuiltBinary["target"]> = {}): BuiltBinary["target"] => ({
  os: "linux",
  arch: "x64",
  ...over,
})

describe("skipReason", () => {
  test("runs a target matching the host", () => {
    expect(skipReason(target(), runner)).toBeUndefined()
  })

  test("names the dimension that differs", () => {
    expect(skipReason(target({ os: "darwin" }), runner)).toBe("built for darwin, host is linux")
    expect(skipReason(target({ arch: "arm64" }), runner)).toBe("built for arm64, host is x64")
    expect(skipReason(target({ abi: "musl" }), runner)).toBe("built against musl, host libc is glibc")
  })

  test("a musl host runs musl targets and not glibc ones", () => {
    const alpine: HostSpec = { os: "linux", arch: "x64", abi: "musl", avx2: true }
    expect(skipReason(target({ abi: "musl" }), alpine)).toBeUndefined()
    expect(skipReason(target(), alpine)).toBe("built against glibc, host libc is musl")
  })

  test("a baseline target still runs on a host that has AVX2", () => {
    expect(skipReason(target({ avx2: false }), runner)).toBeUndefined()
  })

  test("a host without AVX2 cannot test a build that assumes it", () => {
    const old: HostSpec = { os: "linux", arch: "x64", avx2: false }
    expect(skipReason(target(), old)).toBe("needs a CPU with AVX2, host CPU has none")
    expect(skipReason(target({ avx2: false }), old)).toBeUndefined()
  })

  test("windows targets are compared on their own platform name", () => {
    expect(skipReason(target({ os: "win32" }), runner)).toBe("built for win32, host is linux")
    expect(skipReason(target({ os: "win32" }), { os: "win32", arch: "x64", avx2: true })).toBeUndefined()
  })
})

describe("runCaveat", () => {
  test("a baseline run on an AVX2 host proves nothing about the CPUs it is for", () => {
    expect(runCaveat(target({ avx2: false }), runner)).toBe(
      "ran on a host with AVX2, so the CPUs this variant exists for are still untested",
    )
  })

  test("no caveat for an ordinary target, or for baseline on a host without AVX2", () => {
    expect(runCaveat(target(), runner)).toBeUndefined()
    expect(runCaveat(target({ avx2: false }), { os: "linux", arch: "x64", avx2: false })).toBeUndefined()
  })
})

// The shape of the real 0.1.7 release: each baseline archive carries the same
// bytes as the sibling it is supposed to differ from.
const released: BuiltBinary[] = [
  { name: "rafikicode-linux-x64", target: target(), sha256: "aaa" },
  { name: "rafikicode-linux-x64-baseline", target: target({ avx2: false }), sha256: "aaa" },
  { name: "rafikicode-linux-x64-musl", target: target({ abi: "musl" }), sha256: "bbb" },
  { name: "rafikicode-linux-x64-baseline-musl", target: target({ abi: "musl", avx2: false }), sha256: "bbb" },
  { name: "rafikicode-linux-arm64", target: target({ arch: "arm64" }), sha256: "ccc" },
  { name: "rafikicode-darwin-x64", target: target({ os: "darwin" }), sha256: "ddd" },
  { name: "rafikicode-darwin-x64-baseline", target: target({ os: "darwin", avx2: false }), sha256: "ddd" },
]

describe("duplicateGroups", () => {
  test("finds every set of targets sharing bytes", () => {
    const groups = duplicateGroups(released).map((group) => group.map((member) => member.name).sort())
    expect(groups).toHaveLength(3)
    expect(groups).toContainEqual(["rafikicode-linux-x64", "rafikicode-linux-x64-baseline"])
    expect(groups).toContainEqual(["rafikicode-linux-x64-baseline-musl", "rafikicode-linux-x64-musl"])
    expect(groups).toContainEqual(["rafikicode-darwin-x64", "rafikicode-darwin-x64-baseline"])
  })

  test("distinct builds produce no groups", () => {
    const distinct = released.map((binary, index) => ({ ...binary, sha256: `sha-${index}` }))
    expect(duplicateGroups(distinct)).toEqual([])
  })
})

describe("baselineCollisions", () => {
  test("pairs each baseline archive with the sibling it duplicates", () => {
    const pairs = baselineCollisions(released).map(({ baseline, sibling }) => [baseline.name, sibling.name])
    expect(pairs).toHaveLength(3)
    expect(pairs).toContainEqual(["rafikicode-linux-x64-baseline", "rafikicode-linux-x64"])
    expect(pairs).toContainEqual(["rafikicode-linux-x64-baseline-musl", "rafikicode-linux-x64-musl"])
    expect(pairs).toContainEqual(["rafikicode-darwin-x64-baseline", "rafikicode-darwin-x64"])
  })

  test("does not pair across a differing libc", () => {
    const crossed: BuiltBinary[] = [
      { name: "glibc", target: target(), sha256: "same" },
      { name: "musl-baseline", target: target({ abi: "musl", avx2: false }), sha256: "same" },
    ]
    expect(baselineCollisions(crossed)).toEqual([])
    // Still a duplicate, just not a baseline one.
    expect(duplicateGroups(crossed)).toHaveLength(1)
  })

  test("a real baseline build is not a collision", () => {
    const fixed: BuiltBinary[] = [
      { name: "rafikicode-linux-x64", target: target(), sha256: "aaa" },
      { name: "rafikicode-linux-x64-baseline", target: target({ avx2: false }), sha256: "zzz" },
    ]
    expect(baselineCollisions(fixed)).toEqual([])
    expect(duplicateWarning(fixed)).toBe("")
  })
})

describe("duplicateWarning", () => {
  test("says what the collision costs the user and what to do", () => {
    const warning = duplicateWarning(released)
    expect(warning).toContain("3 baseline archive(s) are byte identical")
    expect(warning).toContain("rafikicode-linux-x64-baseline == rafikicode-linux-x64")
    expect(warning).toContain("no AVX2")
    expect(warning).toContain("stop")
  })

  test("reports non-baseline duplicates separately", () => {
    const odd: BuiltBinary[] = [
      { name: "rafikicode-linux-arm64", target: target({ arch: "arm64" }), sha256: "q" },
      { name: "rafikicode-linux-arm64-musl", target: target({ arch: "arm64", abi: "musl" }), sha256: "q" },
    ]
    const warning = duplicateWarning(odd)
    expect(warning).toContain("Other targets that produced identical bytes")
    expect(warning).toContain("rafikicode-linux-arm64 == rafikicode-linux-arm64-musl")
    expect(warning).not.toContain("baseline archive(s)")
  })
})

describe("coverageRows", () => {
  const executed = new Set(["rafikicode-linux-x64", "rafikicode-linux-x64-baseline"])
  const rows = coverageRows(released, runner, executed)

  test("marks exactly what ran", () => {
    expect(rows.filter((row) => row.ran).map((row) => row.name)).toEqual([
      "rafikicode-linux-x64",
      "rafikicode-linux-x64-baseline",
    ])
  })

  test("gives every unexecuted target a reason", () => {
    for (const row of rows.filter((row) => !row.ran)) expect(row.skipped).toBeTruthy()
  })

  test("carries the baseline caveat and the duplicate names", () => {
    const baseline = rows.find((row) => row.name === "rafikicode-linux-x64-baseline")!
    expect(baseline.caveat).toContain("still untested")
    expect(baseline.identicalTo).toEqual(["rafikicode-linux-x64"])
  })
})

describe("renderReport", () => {
  const report = renderReport(coverageRows(released, runner, new Set(["rafikicode-linux-x64"])), runner, "0.1.7")

  test("states the host and the count that was executed", () => {
    expect(report).toContain("# Platform coverage for 0.1.7")
    expect(report).toContain("host CPU has AVX2: yes")
    expect(report).toContain("1 of 7 targets were executed on the build host")
  })

  test("lists every target that was never started, with its reason", () => {
    expect(report).toContain("Never executed:")
    expect(report).toContain("rafikicode-darwin-x64 (built for darwin, host is linux)")
    expect(report).toContain("rafikicode-linux-x64-musl (built against musl, host libc is glibc)")
  })

  test("records an unknown host CPU rather than guessing", () => {
    const unknown = renderReport([], { os: "win32", arch: "arm64" }, "9.9.9")
    expect(unknown).toContain("host CPU has AVX2: unknown")
    expect(unknown).toContain("0 of 0 targets")
  })
})
