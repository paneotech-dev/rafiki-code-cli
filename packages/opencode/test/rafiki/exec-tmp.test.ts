// A temporary directory the terminal interface can unpack and run its render
// library from. The bug being tested: a temporary directory mounted noexec takes
// the write and then refuses the mapping, so writability alone is not enough and
// the probe has to really run a file.
//
// The noexec cases mount a small tmpfs with the noexec flag, which needs root,
// so they are skipped when that is not available. The selection around the probe
// is tested separately with an injected probe, so it is covered either way.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import * as ExecTmp from "../../src/rafiki/exec-tmp"
import { Brand } from "@opencode-ai/core/brand/brand"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-exec-tmp-"))
const mounts: string[] = []

// A directory on a tmpfs mounted noexec, or undefined when this machine will not
// let us make one.
function noexecDir(name: string) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  const run = spawnSync("mount", ["-t", "tmpfs", "-o", "noexec,size=1M", "tmpfs", dir], { stdio: "ignore" })
  if (run.error || run.status !== 0) return undefined
  mounts.push(dir)
  return dir
}

const noexec = noexecDir("noexec")

afterAll(() => {
  for (const dir of mounts) spawnSync("umount", [dir], { stdio: "ignore" })
  fs.rmSync(root, { recursive: true, force: true })
})

describe("the executability probe", () => {
  test("accepts a normal directory", () => {
    const dir = path.join(root, "normal")
    expect(ExecTmp.probe(dir)).toBe("ok")
  })

  test("creates the directory it is given", () => {
    const dir = path.join(root, "made", "deeper")
    expect(ExecTmp.probe(dir)).toBe("ok")
    expect(fs.existsSync(dir)).toBe(true)
  })

  test("leaves nothing behind", () => {
    const dir = path.join(root, "clean")
    expect(ExecTmp.probe(dir)).toBe("ok")
    expect(fs.readdirSync(dir)).toEqual([])
  })

  test.if(noexec !== undefined)("rejects a noexec directory the write succeeds in", () => {
    const dir = noexec!
    // The write is what works on these machines and the execution is what does
    // not, so assert both halves: a verdict of "noexec" with an unwritable
    // directory would prove nothing.
    const witness = path.join(dir, "writable")
    fs.writeFileSync(witness, "x")
    expect(fs.readFileSync(witness, "utf8")).toBe("x")
    fs.unlinkSync(witness)
    expect(ExecTmp.probe(dir)).toBe("noexec")
  })

  test("reports a path that is not a directory as unwritable", () => {
    const file = path.join(root, "a-file")
    fs.writeFileSync(file, "")
    expect(ExecTmp.probe(path.join(file, "under"))).toBe("unwritable")
  })
})

describe("choosing a directory", () => {
  test("takes the first one that can run a file and records the rest", () => {
    const verdicts: Record<string, ExecTmp.Verdict> = {
      "/one": "noexec",
      "/two": "full",
      "/three": "ok",
      "/four": "ok",
    }
    const picked = ExecTmp.choose(["/one", "/two", "/three", "/four"], [], (dir) => verdicts[dir])
    expect(picked.dir).toBe("/three")
    expect(picked.tried).toEqual([
      { dir: "/one", verdict: "noexec" },
      { dir: "/two", verdict: "full" },
      { dir: "/three", verdict: "ok" },
    ])
  })

  test("returns no directory when none can run a file", () => {
    const picked = ExecTmp.choose(["/one", "/two"], [], () => "noexec")
    expect(picked.dir).toBeUndefined()
    expect(picked.tried.map((attempt) => attempt.dir)).toEqual(["/one", "/two"])
  })

  test("does not probe a directory already tried", () => {
    const seen: string[] = []
    const tried: ExecTmp.Attempt[] = [{ dir: "/one", verdict: "noexec" }]
    const picked = ExecTmp.choose(["/one", "/two"], tried, (dir) => {
      seen.push(dir)
      return "ok"
    })
    expect(seen).toEqual(["/two"])
    expect(picked.dir).toBe("/two")
  })

  test.if(noexec !== undefined)("falls through a real noexec directory to a usable one", () => {
    const good = path.join(root, "good")
    const picked = ExecTmp.choose([noexec!, good])
    expect(picked.dir).toBe(good)
    expect(picked.tried[0]).toEqual({ dir: noexec!, verdict: "noexec" })
  })
})

describe("the candidate directories", () => {
  test("are the cache directory then the config directory, both named tmp", () => {
    expect(ExecTmp.candidates({ cache: "/c/rafikicode", config: "/h/.rafikicode" })).toEqual([
      path.join("/c/rafikicode", "tmp"),
      path.join("/h/.rafikicode", "tmp"),
    ])
  })
})

describe("reading the mount table", () => {
  const mountinfo = [
    "24 30 0:22 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
    "36 24 0:30 / /tmp rw,nosuid,nodev,noexec,relatime shared:5 - tmpfs tmpfs rw,size=1048576k",
    "41 24 0:31 / /home rw,relatime shared:6 - ext4 /dev/sdb rw",
    "42 41 0:32 / /home/my\\040dir rw,noexec,relatime shared:7 - tmpfs tmpfs rw",
  ].join("\n")

  test("finds the options of the longest matching mount point", () => {
    expect(ExecTmp.mountOptions("/tmp/.x.so", mountinfo)).toContain("noexec")
    expect(ExecTmp.mountOptions("/home/me/.cache", mountinfo)).not.toContain("noexec")
    expect(ExecTmp.mountOptions("/var/anything", mountinfo)).toEqual(["rw", "relatime"])
  })

  test("decodes an escaped mount point", () => {
    expect(ExecTmp.mountedNoexec("/home/my dir/tmp", mountinfo)).toBe(true)
    expect(ExecTmp.mountedNoexec("/home/mydir/tmp", mountinfo)).toBe(false)
  })

  test("does not mistake a mount point for a prefix of a longer name", () => {
    expect(ExecTmp.mountedNoexec("/tmpfiles", mountinfo)).toBe(false)
  })

  test("says nothing when the mount table is empty or says nothing about this path", () => {
    expect(ExecTmp.mountedNoexec("/tmp", "")).toBeUndefined()
    expect(ExecTmp.mountOptions("/tmp", "nonsense")).toBeUndefined()
    expect(ExecTmp.mountOptions("/tmp", "36 24 0:30 / /srv rw,noexec - tmpfs tmpfs rw")).toBeUndefined()
  })
})

describe("recognising the failure", () => {
  // Verbatim from two users on the same shared host.
  const reported =
    'Failed to initialize OpenTUI render library: Failed to open library "/tmp/.9adb7abbf6e5efff-00000001.so": /tmp/.9adb7abbf6e5efff-00000001.so: failed to map segment from shared object'

  test("matches the error the users reported", () => {
    expect(ExecTmp.isRenderLibFailure(new Error(reported))).toBe(true)
  })

  test("matches the unpack failing before the mapping", () => {
    expect(
      ExecTmp.isRenderLibFailure(
        new Error(
          'Failed to open library "/$bunfs/root/libopentui-h3hyjpa5.so": /$bunfs/root/libopentui-h3hyjpa5.so: cannot open shared object file: No such file or directory',
        ),
      ),
    ).toBe(true)
  })

  test("ignores a missing library that has nothing to do with this", () => {
    expect(
      ExecTmp.isRenderLibFailure(new Error("libpq.so.5: cannot open shared object file: No such file or directory")),
    ).toBe(false)
  })

  test("ignores unrelated errors", () => {
    expect(ExecTmp.isRenderLibFailure(new Error("fetch failed"))).toBe(false)
    expect(ExecTmp.isRenderLibFailure(undefined)).toBe(false)
    expect(ExecTmp.isRenderLibFailure({})).toBe(false)
  })

  test("explain says nothing about an unrelated error", () => {
    expect(ExecTmp.explain(new Error("fetch failed"))).toBeUndefined()
  })

  test("explain hands the reported error to the diagnosis layer as a cause and a step", () => {
    // Not a finished message any more: the words below are printed as the cause
    // and the step of a startup diagnosis, which is what carries the exit code,
    // the original error and the --print-logs hint (rafiki/startup.ts).
    const detail = ExecTmp.explain(new Error(reported), [])
    expect(detail).toBeDefined()
    expect(detail!.cause).toContain("Probable cause:")
    expect(detail!.step.split("\n").length).toBeGreaterThan(1)
  })

  test("explain does not blame noexec when the temporary directory can run a file", () => {
    // This suite runs with a usable temporary directory, so the same error has to
    // be explained by what is left: a build for another machine, a C library, a
    // memory limit. The library that failed is still named; the original words
    // are printed by the diagnosis layer as "Original error:", asserted there.
    const detail = ExecTmp.explain(new Error(reported), [])!
    expect(detail.cause).toContain("is not this")
    expect(detail.cause).toContain("ldd --version")
    expect(detail.cause).toContain("/tmp/.9adb7abbf6e5efff-00000001.so could not be mapped")
    expect(detail.cause).toContain("your sign in and your key are fine")
    expect(detail.cause).not.toContain("Directories tried")
    // A build problem is worth sending to us, unlike a host's noexec mount.
    expect(detail.report).toBe(true)
  })
})

describe("the message when no directory works", () => {
  const text = ExecTmp.message([
    { dir: "/tmp", verdict: "noexec" },
    { dir: "/home/me/.cache/rafikicode/tmp", verdict: "noexec" },
    { dir: "/home/me/.rafikicode/tmp", verdict: "noexec" },
  ])

  test("names the cause in words", () => {
    expect(text).toContain("noexec")
    expect(text).toContain("will not run it")
  })

  test("names every directory tried", () => {
    expect(text).toContain("/tmp")
    expect(text).toContain("/home/me/.cache/rafikicode/tmp")
    expect(text).toContain("/home/me/.rafikicode/tmp")
  })

  test("says the account and the sign in are not the problem", () => {
    expect(text).toContain("your sign in and your key are fine")
  })

  test("gives a command to type and a line to send the host", () => {
    // Both live in the step rather than in the message, because the diagnosis
    // layer prints a cause and a step (rafiki/startup.ts). Same words.
    const step = ExecTmp.step()
    expect(step).toContain(`TMPDIR=/that/directory ${Brand.name}`)
    expect(step).toContain("not mounted noexec")
  })

  test("uses this product's name and never the upstream one", () => {
    expect(text).toContain(Brand.product)
    expect(text).not.toContain(Brand.upstream.name)
    expect(text).not.toContain("OpenTUI")
  })

  test("explains a full temporary directory as space, not as noexec", () => {
    const full = ExecTmp.message([{ dir: "/tmp", verdict: "full" }])
    expect(full).toContain("full")
    expect(full).toContain("Free some space")
  })
})

describe("deciding whether to act at all", () => {
  test("a compiled binary is recognised by its entry path", () => {
    expect(ExecTmp.compiled(["bun", "/$bunfs/root/index.js", "run"])).toBe(true)
    expect(ExecTmp.compiled(["bun", "B:/~BUN/root/index.js", "run"])).toBe(true)
  })

  test("a source run is not a compiled binary, so it is left alone", () => {
    expect(ExecTmp.compiled(["bun", "/repo/packages/opencode/src/index.ts", "run"])).toBe(false)
    expect(ExecTmp.compiled(["bun"])).toBe(false)
  })

  test("ensure does nothing in a source run", () => {
    const before = process.env["TMPDIR"]
    expect(() => ExecTmp.ensure()).not.toThrow()
    expect(process.env["TMPDIR"]).toBe(before)
  })
})
