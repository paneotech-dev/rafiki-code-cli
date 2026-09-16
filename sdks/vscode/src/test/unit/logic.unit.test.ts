import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { canStart, parseWhoami, statusView, stripAnsi } from "../../lib/keystate"
import { summarizeDoctor } from "../../lib/doctor"
import { fileReference, lineRange, openingPrompt } from "../../lib/prompt"
import * as Launch from "../../lib/launch"
import { modelFor, normalizeTier, TIERS } from "../../lib/tier"

// Output shapes below are copied from rafikicode 0.1.2-console-only runs.
test("whoami: no key", () => {
  const state = parseWhoami("Error: Missing API key. Run rafikicode login, or set RAFIKICODE_API_KEY.\n", 2)
  assert.deepEqual(state, { kind: "no-key" })
  assert.equal(canStart(state), false)
  const view = statusView(state, "")
  assert.equal(view.warning, true)
  assert.match(view.text, /sign in/)
})

test("whoami: server key from the environment", () => {
  const out = [
    "Console: https://console.rafikiai.io",
    "Gateway: https://gateway.rafikiai.io/v1",
    "Credential: RAFIKICODE_API_KEY (environment)",
    "Account: a server key from the environment (details are on the Console key page).",
  ].join("\n")
  const state = parseWhoami(out, 0)
  assert.deepEqual(state, { kind: "server-key" })
  assert.equal(canStart(state), true)
  assert.equal(statusView(state, "pro").text, "$(sparkle) Rafiki Code (pro)")
})

test("whoami: stored sign in, with colours", () => {
  const out = [
    "\u001b[90mRAFIKICODE_API_KEY is set\u001b[0m",
    "Console: https://console.rafikiai.io",
    "Credential: /home/ada/.rafikicode/credentials",
    "Account: Ada Lovelace ada@example.com",
    "Key: rc-ada-laptop (expires in 29 days)",
  ].join("\n")
  const state = parseWhoami(out, 0)
  assert.deepEqual(state, { kind: "signed-in", account: "Ada Lovelace ada@example.com", key: "rc-ada-laptop (expires in 29 days)", expired: false })
  assert.equal(canStart(state), true)
  const view = statusView(state, "")
  assert.equal(view.text, "$(sparkle) Rafiki Code")
  assert.match(view.tooltip, /Signed in as Ada Lovelace/)
})

test("whoami: expired stored sign in asks to sign in again", () => {
  const state = parseWhoami("Credential: /h/.rafikicode/credentials\nAccount: Ada\nKey: rc-1 (expired 2026-01-01T00:00:00Z)\n", 0)
  assert.equal(state.kind, "signed-in")
  assert.equal(canStart(state), false)
  assert.match(statusView(state, "").text, /sign in again/)
})

test("whoami: unsafe credential file is a problem, not a missing key", () => {
  const state = parseWhoami(
    "Error: The credential file /h/.rafikicode/credentials is readable by other users, so it is not used. Fix it with: chmod 600 /h/.rafikicode/credentials\n",
    2,
  )
  assert.equal(state.kind, "problem")
  if (state.kind === "problem") {
    assert.match(state.message, /^The credential file/)
  }
  assert.equal(statusView(state, "").warning, true)
})

test("whoami: other failures keep the first message", () => {
  assert.deepEqual(parseWhoami("", 5), { kind: "problem", message: "rafikicode whoami failed with no output." })
  assert.deepEqual(parseWhoami("boom\nmore", null), { kind: "problem", message: "boom" })
  assert.equal(parseWhoami("Console: x\n", 0).kind, "problem")
})

test("stripAnsi removes colour codes", () => {
  assert.equal(stripAnsi("\u001b[1m\u001b[92mok\u001b[0m"), "ok")
})

test("doctor summary", () => {
  const passed = "ok    config      /h/.rafikicode/config.json\nWARN  console     not registered\n\nAll checks passed, 1 warning, see the line marked WARN.\n"
  assert.deepEqual(summarizeDoctor(passed, 0), {
    ok: true,
    failed: 0,
    warned: 1,
    message: "Rafiki Code doctor: all checks passed, 1 warning.",
  })
  const failed = "ok    config      x\nFAIL  credential  none\nFAIL  gateway     down\nError: 2 checks need attention, see the lines marked FAIL.\n"
  assert.deepEqual(summarizeDoctor(failed, 2), {
    ok: false,
    failed: 2,
    warned: 0,
    message: "Rafiki Code doctor: 2 checks need attention (exit 2).",
  })
  assert.equal(summarizeDoctor("", null).message, "Rafiki Code doctor: a check failed (exit unknown).")
})

test("doctor summary on real coloured output (0.1.2-console-only, gateway and Console unreachable)", () => {
  const real = [
    "\u001b[92m\u001b[1mok  \u001b[0m  config      /h/.rafikicode/config.json not created yet, built in defaults apply",
    "\u001b[92m\u001b[1mok  \u001b[0m  credential  RAFIKICODE_API_KEY from the environment",
    "\u001b[91m\u001b[1mFAIL\u001b[0m  gateway     http://127.0.0.1:9 unreachable (Unable to connect. Is the computer able to access the url?). Fix: Check the network, and RAFIKICODE_GATEWAY_URL which is set.",
    "\u001b[90m\u001b[1mskip\u001b[0m  key         gateway unreachable",
    "\u001b[90m\u001b[1mskip\u001b[0m  tiers       gateway unreachable",
    "\u001b[91m\u001b[1mFAIL\u001b[0m  console     http://127.0.0.1:9 unreachable (Unable to connect. Is the computer able to access the url?). Fix: Check the network, and RAFIKICODE_CONSOLE_URL which is set.",
    "\u001b[92m\u001b[1mok  \u001b[0m  version     rafikicode 0.1.2-console-only, latest channel",
    "\u001b[0m",
    "\u001b[91m\u001b[1mError: \u001b[0m2 checks need attention, see the lines marked FAIL.",
  ].join("\n")
  assert.equal(summarizeDoctor(real, 4).message, "Rafiki Code doctor: 2 checks need attention (exit 4).")
  assert.deepEqual(parseWhoami("\u001b[91m\u001b[1mError: \u001b[0mMissing API key. Run rafikicode login, or set RAFIKICODE_API_KEY.\n", 2), { kind: "no-key" })
})

test("file references", () => {
  assert.equal(fileReference("src/app.ts"), "@src/app.ts")
  assert.equal(fileReference("src\\win.ts"), "@src/win.ts")
  assert.equal(fileReference("a.ts", { startLine: 4, endLine: 4, endCharacter: 9, isEmpty: false }), "@a.ts#L5")
  assert.equal(fileReference("a.ts", { startLine: 4, endLine: 9, endCharacter: 3, isEmpty: false }), "@a.ts#L5-10")
  // Whole lines selected with the keyboard end at column 0 of the next line.
  assert.equal(fileReference("a.ts", { startLine: 4, endLine: 7, endCharacter: 0, isEmpty: false }), "@a.ts#L5-7")
  assert.equal(fileReference("a.ts", { startLine: 4, endLine: 5, endCharacter: 0, isEmpty: false }), "@a.ts#L5")
  assert.equal(lineRange({ startLine: 1, endLine: 1, endCharacter: 1, isEmpty: true }), undefined)
  assert.equal(openingPrompt("@a.ts"), "In @a.ts")
})

test("tiers map to Rafiki models only", () => {
  assert.deepEqual([...TIERS], ["fast", "pro", "max"])
  assert.equal(modelFor("fast"), "rafiki/rafiki-fast")
  assert.equal(modelFor("pro"), "rafiki/rafiki-pro")
  assert.equal(modelFor("max"), "rafiki/rafiki-max")
  assert.equal(modelFor("default"), undefined)
  assert.equal(normalizeTier("gpt-4o"), "default")
  assert.equal(normalizeTier(undefined), "default")
})

test("launch arguments listen on loopback and pass the tier", () => {
  assert.deepEqual(Launch.tuiArgs(4150, "default"), ["--hostname", "127.0.0.1", "--port", "4150"])
  assert.deepEqual(Launch.tuiArgs(4150, "max"), ["--hostname", "127.0.0.1", "--port", "4150", "--model", "rafiki/rafiki-max"])
  const env = Launch.terminalEnv({ port: 1, password: "p" })
  assert.deepEqual(env, { OPENCODE_SERVER_PASSWORD: "p", OPENCODE_SERVER_USERNAME: "rafikicode" })
  assert.deepEqual(Launch.loginArgs("x"), ["login", "--label", "x"])
  assert.deepEqual(Launch.loginArgs("x", true), ["login", "--label", "x", "--surface", "ide"])
  assert.equal(Launch.deviceLabel("0.1.0", "box"), "Rafiki Code for VS Code 0.1.0 on box")
  assert.equal(Launch.deviceLabel("0.1.0", "h".repeat(300)).length, 120)
})

// login --help lines copied from rafikicode 0.1.2 and the 0.1.3 candidate.
test("the surface option is used only when login --help lists it", () => {
  const v012 = "      --refresh     rotate the stored key instead of starting a new sign-in\n                                                                          [boolean] [default: false]\n"
  const v013 = v012 + '      --surface     where the key is used: cli for a terminal, ide for an editor       [string] [default: "cli"]\n'
  assert.equal(Launch.supportsSurface(v012), false)
  assert.equal(Launch.supportsSurface(v013), true)
  assert.equal(Launch.supportsSurface(""), false)
})

test("append prompt talks to the control server with the terminal's password", async () => {
  const seen: Array<{ url?: string; auth?: string; body: string }> = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body })
      const expected = `Basic ${Buffer.from("rafikicode:s3cret").toString("base64")}`
      res.statusCode = req.headers.authorization === expected ? 200 : 401
      res.end("true")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const session = { port, password: "s3cret" }
    assert.equal(await Launch.waitReady(session, fetch, { timeoutMs: 2000, delayMs: 10 }), true)
    assert.equal(await Launch.appendPrompt(session, "@a.ts#L1", fetch), true)
    assert.equal(await Launch.appendPrompt({ port, password: "wrong" }, "x", fetch), false)
    assert.equal(seen[0].url, "/global/health")
    assert.equal(seen[1].url, "/tui/append-prompt")
    assert.deepEqual(JSON.parse(seen[1].body), { text: "@a.ts#L1" })
  } finally {
    server.close()
  }
  // Nothing listening: not ready after the tries run out.
  assert.equal(await Launch.waitReady({ port, password: "x" }, fetch, { timeoutMs: 100, delayMs: 5 }), false)
})

test("waitReady gets past a first request that is never answered", async () => {
  // rafikicode 0.1.2 accepts a request that arrives while it starts and never
  // answers it; the next attempt, after the per attempt timeout, succeeds.
  let calls = 0
  const server = http.createServer((req, res) => {
    calls++
    if (calls === 1) {
      return
    }
    res.statusCode = calls === 2 ? 404 : 200
    res.end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const started = Date.now()
    assert.equal(await Launch.waitReady({ port, password: "p" }, fetch, { timeoutMs: 5000, attemptMs: 300, delayMs: 10 }), true)
    assert.equal(calls, 3)
    assert.ok(Date.now() - started < 3000)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
