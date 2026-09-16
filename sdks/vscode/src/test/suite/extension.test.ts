// Runs inside VS Code (bun run test, through @vscode/test-cli) against a stub
// rafikicode: a small node script that answers whoami, login, logout and
// doctor, and plays the terminal interface's control server for the rest.
import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import type { RafikiCodeApi } from "../../extension"

const EXTENSION_ID = "paneotech.rafiki-code"

function stubSource(dir: string) {
  const mode = path.join(dir, "mode")
  const log = path.join(dir, "requests.log")
  return `#!/usr/bin/env node
const fs = require("fs")
const http = require("http")
const mode = () => { try { return fs.readFileSync(${JSON.stringify(mode)}, "utf8").trim() } catch { return "no-key" } }
const record = (entry) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n")
const args = process.argv.slice(2)
record({ args })
if (args[0] === "whoami") {
  if (mode() === "signed-in") {
    console.log("Console: https://console.rafikiai.io\\nCredential: /stub/credentials\\nAccount: Stub User stub@example.com\\nKey: rc-stub (expires in 30 days)")
    process.exit(0)
  }
  console.log("Error: Missing API key. Run rafikicode login, or set RAFIKICODE_API_KEY.")
  process.exit(2)
} else if (args[0] === "login" && args.includes("--help")) {
  console.log("rafikicode login\\n\\nOptions:\\n      --label  name\\n      --surface  where the key is used: cli for a terminal, ide for an editor")
  process.exit(0)
} else if (args[0] === "login") {
  fs.writeFileSync(${JSON.stringify(mode)}, "signed-in")
  console.log("Signed in as Stub User.")
  process.exit(0)
} else if (args[0] === "logout") {
  fs.writeFileSync(${JSON.stringify(mode)}, "no-key")
  console.log("Removed /stub/credentials. Signed out.")
  process.exit(0)
} else if (args[0] === "doctor") {
  console.log("ok    config      stub\\nok    credential  stub\\n\\nAll checks passed.")
  process.exit(0)
} else {
  const port = Number(args[args.indexOf("--port") + 1])
  const expected = "Basic " + Buffer.from((process.env.OPENCODE_SERVER_USERNAME || "") + ":" + (process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64")
  http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      const auth = req.headers.authorization === expected && Boolean(process.env.OPENCODE_SERVER_PASSWORD)
      record({ url: req.url, auth, body, hostname: args[args.indexOf("--hostname") + 1], cwd: process.cwd() })
      res.statusCode = auth ? 200 : 401
      res.end("true")
    })
  }).listen(port, "127.0.0.1")
}
`
}

async function until<T>(what: () => T | undefined | false, timeoutMs = 15000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = what()
    if (value) {
      return value
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out")
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function requests(dir: string): Array<Record<string, unknown>> {
  try {
    return fs
      .readFileSync(path.join(dir, "requests.log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

suite("Rafiki Code extension", () => {
  let dir: string
  let api: RafikiCodeApi

  suiteSetup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rafiki-vscode-"))
    const stub = path.join(dir, "rafikicode")
    fs.writeFileSync(stub, stubSource(dir), { mode: 0o755 })
    const extension = vscode.extensions.getExtension<RafikiCodeApi>(EXTENSION_ID)
    assert.ok(extension, "extension is installed under its Rafiki id")
    api = await extension.activate()
    await vscode.workspace.getConfiguration("rafikicode").update("path", stub, vscode.ConfigurationTarget.Global)
  })

  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration("rafikicode").update("path", undefined, vscode.ConfigurationTarget.Global)
    await vscode.workspace.getConfiguration("rafikicode").update("tier", undefined, vscode.ConfigurationTarget.Global)
    for (const terminal of vscode.window.terminals) {
      terminal.dispose()
    }
  })

  test("contributes the Rafiki commands and none of the upstream ones", async () => {
    const commands = await vscode.commands.getCommands(true)
    for (const id of ["open", "openNew", "sendSelection", "sendFile", "signIn", "signOut", "doctor", "pickTier", "showAccount", "refreshStatus"]) {
      assert.ok(commands.includes(`rafikicode.${id}`), `rafikicode.${id}`)
    }
    assert.ok(!commands.some((c) => c.startsWith("opencode.")))
  })

  test("reports the missing binary with the install line", async () => {
    await vscode.workspace.getConfiguration("rafikicode").update("path", "/nonexistent/rafikicode", vscode.ConfigurationTarget.Global)
    const state = await api.refresh()
    assert.equal(state.kind, "missing-binary")
    await vscode.workspace.getConfiguration("rafikicode").update("path", path.join(dir, "rafikicode"), vscode.ConfigurationTarget.Global)
  })

  test("shows the no key state", async () => {
    const state = await api.refresh()
    assert.deepEqual(state, { kind: "no-key" })
    assert.equal(api.binary().found, true)
  })

  test("opening without a key starts no session", async () => {
    await vscode.commands.executeCommand("rafikicode.openNew")
    assert.equal(api.sessions().length, 0)
    assert.ok(!vscode.window.terminals.some((t) => t.name === "Rafiki Code"))
  })

  test("sign in runs rafikicode login in a terminal and updates the status", async () => {
    await vscode.commands.executeCommand("rafikicode.signIn")
    const state = await until(() => {
      const s = api.keyState()
      return s.kind === "signed-in" ? s : undefined
    })
    assert.equal(state.kind, "signed-in")
    const login = requests(dir).find((r) => Array.isArray(r.args) && r.args[0] === "login" && !(r.args as string[]).includes("--help"))
    assert.ok(login)
    assert.equal((login.args as string[])[1], "--label")
    assert.match((login.args as string[])[2], /^Rafiki Code for VS Code 0\.1\.0 on /)
    assert.deepEqual((login.args as string[]).slice(3), ["--surface", "ide"])
  })

  test("open starts the terminal interface on loopback with the tier and a password, and sends the file", async () => {
    await vscode.workspace.getConfiguration("rafikicode").update("tier", "max", vscode.ConfigurationTarget.Global)
    const file = path.join(dir, "sample.ts")
    fs.writeFileSync(file, "one\ntwo\nthree\nfour\n")
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file))
    editor.selection = new vscode.Selection(1, 0, 2, 3)
    await vscode.commands.executeCommand("rafikicode.openNew")
    assert.equal(api.sessions().length, 1)
    const opened = await until(() => requests(dir).find((r) => r.url === "/tui/append-prompt"))
    assert.equal(opened.auth, true)
    assert.equal(opened.hostname, "127.0.0.1")
    assert.deepEqual(JSON.parse(String(opened.body)), { text: `In @${file.replace(/\\/g, "/")}#L2-3` })
    const launch = requests(dir).find((r) => Array.isArray(r.args) && (r.args as string[]).includes("--port"))
    assert.ok(launch)
    assert.deepEqual((launch.args as string[]).slice(-2), ["--model", "rafiki/rafiki-max"])

    await vscode.window.showTextDocument(vscode.Uri.file(file))
    vscode.window.activeTextEditor!.selection = new vscode.Selection(3, 0, 3, 2)
    await vscode.commands.executeCommand("rafikicode.sendSelection")
    const sent = await until(() => requests(dir).filter((r) => r.url === "/tui/append-prompt")[1])
    assert.equal(sent.auth, true)
    assert.deepEqual(JSON.parse(String(sent.body)), { text: `@${file.replace(/\\/g, "/")}#L4` })

    await vscode.commands.executeCommand("rafikicode.sendFile", vscode.Uri.file(file))
    const whole = await until(() => requests(dir).filter((r) => r.url === "/tui/append-prompt")[2])
    assert.deepEqual(JSON.parse(String(whole.body)), { text: `@${file.replace(/\\/g, "/")}` })
  })

  test("doctor runs rafikicode doctor", async () => {
    await vscode.commands.executeCommand("rafikicode.doctor")
    assert.ok(requests(dir).some((r) => Array.isArray(r.args) && r.args[0] === "doctor"))
  })

  // Optional: a real rafikicode binary in a VS Code terminal. Set
  // RAFIKI_VSCODE_REAL_BIN to its path, and RAFIKICODE_API_KEY (a stub is
  // enough) plus RAFIKICODE_GATEWAY_URL for a gateway that is never called.
  test("a real rafikicode starts in a VS Code terminal behind its password", async function () {
    const real = process.env["RAFIKI_VSCODE_REAL_BIN"]
    if (!real) {
      this.skip()
    }
    for (const terminal of vscode.window.terminals) {
      terminal.dispose()
    }
    await until(() => api.sessions().length === 0)
    await vscode.workspace.getConfiguration("rafikicode").update("path", real, vscode.ConfigurationTarget.Global)
    await vscode.workspace.getConfiguration("rafikicode").update("tier", "pro", vscode.ConfigurationTarget.Global)
    assert.equal((await api.refresh()).kind, "server-key")
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    await vscode.commands.executeCommand("rafikicode.openNew")
    const [session] = api.sessions()
    assert.ok(session, "a session was started")
    const base = `http://127.0.0.1:${session.port}`
    const auth = `Basic ${Buffer.from(`rafikicode:${session.password}`).toString("base64")}`
    let health: { status: number; body: string } | undefined
    for (let i = 0; i < 60 && health?.status !== 200; i++) {
      health = await fetch(`${base}/global/health`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(1000) })
        .then(async (r) => ({ status: r.status, body: await r.text() }))
        .catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.equal(health?.status, 200)
    assert.match(health!.body, /"healthy":true/)
    console.log(`      real rafikicode answered: ${health!.body}`)
    assert.equal((await fetch(`${base}/global/health`)).status, 401)
    await vscode.commands.executeCommand("rafikicode.sendFile", vscode.Uri.file(path.join(dir, "sample.ts")))
    const append = await fetch(`${base}/tui/append-prompt`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ text: " real check" }),
    })
    assert.equal(append.status, 200)
  })
})
