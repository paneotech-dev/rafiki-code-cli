import { test } from "node:test"
import * as assert from "node:assert/strict"
import { findBinary, expandHome, missingMessage, INSTALL_LINE, type BinaryProbe } from "../../lib/binary"

function probe(existing: string[], over: Partial<BinaryProbe> = {}): BinaryProbe {
  return {
    platform: "linux",
    home: "/home/ada",
    env: { PATH: "/usr/bin:/opt/tools/bin" },
    isExecutable: (file) => existing.includes(file),
    ...over,
  }
}

test("the setting wins over PATH", () => {
  const result = findBinary("/srv/rafikicode", probe(["/srv/rafikicode", "/usr/bin/rafikicode"]))
  assert.deepEqual(result, { found: true, path: "/srv/rafikicode", source: "setting" })
})

test("the setting expands ~", () => {
  const result = findBinary("~/tools/rafikicode", probe(["/home/ada/tools/rafikicode"]))
  assert.deepEqual(result, { found: true, path: "/home/ada/tools/rafikicode", source: "setting" })
})

test("a setting that points nowhere is reported, not silently skipped", () => {
  const result = findBinary("/nope/rafikicode", probe(["/usr/bin/rafikicode"]))
  assert.equal(result.found, false)
  if (!result.found) {
    assert.match(result.settingProblem ?? "", /not an executable file/)
    assert.match(missingMessage(result), /Fix the setting/)
  }
})

test("a relative setting is refused", () => {
  const result = findBinary("bin/rafikicode", probe([]))
  assert.equal(result.found, false)
  if (!result.found) {
    assert.match(result.settingProblem ?? "", /absolute path/)
  }
})

test("PATH is searched in order", () => {
  const result = findBinary("", probe(["/opt/tools/bin/rafikicode", "/home/ada/.rafikicode/bin/rafikicode"]))
  assert.deepEqual(result, { found: true, path: "/opt/tools/bin/rafikicode", source: "path" })
})

test("the installer directory is used when PATH has no rafikicode", () => {
  const result = findBinary(undefined, probe(["/home/ada/.rafikicode/bin/rafikicode"]))
  assert.deepEqual(result, { found: true, path: "/home/ada/.rafikicode/bin/rafikicode", source: "installer" })
})

test("RAFIKICODE_INSTALL_DIR is checked before the default installer directory", () => {
  const result = findBinary(
    undefined,
    probe(["/data/rc/rafikicode", "/home/ada/.rafikicode/bin/rafikicode"], { env: { PATH: "/usr/bin", RAFIKICODE_INSTALL_DIR: "/data/rc" } }),
  )
  assert.deepEqual(result, { found: true, path: "/data/rc/rafikicode", source: "installer" })
})

test("common directories come last, Homebrew only on macOS", () => {
  assert.deepEqual(findBinary(undefined, probe(["/home/ada/.local/bin/rafikicode"])), {
    found: true,
    path: "/home/ada/.local/bin/rafikicode",
    source: "common",
  })
  assert.equal(findBinary(undefined, probe(["/opt/homebrew/bin/rafikicode"])).found, false)
  assert.equal(findBinary(undefined, probe(["/opt/homebrew/bin/rafikicode"], { platform: "darwin" })).found, true)
})

test("missing everywhere: every checked file is listed and the install line is given", () => {
  const result = findBinary(undefined, probe([], { env: {} }))
  assert.equal(result.found, false)
  if (!result.found) {
    assert.ok(result.tried.includes("/home/ada/.rafikicode/bin/rafikicode"))
    assert.equal(missingMessage(result), `Rafiki Code could not find the rafikicode command. Install it with: ${INSTALL_LINE}`)
  }
  assert.equal(INSTALL_LINE, "curl -fsSL https://get.rafikiai.io | bash")
})

test("Windows: Path in any case, .exe first, installer directory under the profile", () => {
  const win = (existing: string[], env: Record<string, string>) =>
    findBinary(undefined, { platform: "win32", home: "C:\\Users\\ada", env, isExecutable: (f) => existing.includes(f) })
  assert.deepEqual(win(["C:\\Tools\\rafikicode.exe", "C:\\Tools\\rafikicode"], { Path: "C:\\Windows;\"C:\\Tools\"" }), {
    found: true,
    path: "C:\\Tools\\rafikicode.exe",
    source: "path",
  })
  assert.deepEqual(win(["C:\\Users\\ada\\.rafikicode\\bin\\rafikicode.exe"], { Path: "C:\\Windows" }), {
    found: true,
    path: "C:\\Users\\ada\\.rafikicode\\bin\\rafikicode.exe",
    source: "installer",
  })
})

test("expandHome leaves other paths alone", () => {
  assert.equal(expandHome("/a/~b", "/h", "linux"), "/a/~b")
  assert.equal(expandHome("~", "/h", "linux"), "/h")
  assert.equal(expandHome("~\\x", "C:\\h", "win32"), "C:\\h\\x")
})
