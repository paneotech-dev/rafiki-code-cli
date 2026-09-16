// Rafiki Code for VS Code. Based on the opencode VS Code extension (MIT, see
// LICENSE): it runs the rafikicode terminal interface in an editor terminal
// and pushes file references into its prompt over the local control server.
// Sign in, sign out, doctor and the key state all call the rafikicode
// command, so the editor and the terminal share one sign in.
import * as vscode from "vscode"
import * as fs from "fs"
import * as os from "os"
import * as net from "net"
import * as path from "path"
import { randomBytes } from "crypto"
import { execFile } from "child_process"
import { findBinary, INSTALL_LINE, missingMessage, type BinaryResult } from "./lib/binary"
import { canStart, parseWhoami, statusView, stripAnsi, type KeyState } from "./lib/keystate"
import { summarizeDoctor } from "./lib/doctor"
import { fileReference, openingPrompt } from "./lib/prompt"
import * as Launch from "./lib/launch"
import { normalizeTier, TIER_INFO, TIERS, type TierSetting } from "./lib/tier"

const TERMINAL_NAME = "Rafiki Code"
const SIGN_IN_TERMINAL_NAME = "Rafiki Code Sign In"
const CONSOLE_URL = "https://console.rafikiai.io"
const KEYS_URL = `${CONSOLE_URL}/keys`
const DOCS_URL = "https://github.com/paneotech-dev/rafiki-code-cli/blob/main/docs/vscode.md"
const SECTION = "rafikicode"

export interface RafikiCodeApi {
  keyState(): KeyState
  refresh(): Promise<KeyState>
  binary(): BinaryResult
  sessions(): Launch.Session[]
}

interface RunResult {
  code: number | null
  output: string
}

function config() {
  return vscode.workspace.getConfiguration(SECTION)
}

function isExecutable(file: string) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) {
      return false
    }
    if (process.platform === "win32") {
      return true
    }
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function locateBinary(): BinaryResult {
  return findBinary(config().get<string>("path"), {
    platform: process.platform,
    home: os.homedir(),
    env: process.env,
    isExecutable,
  })
}

function run(binary: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        shell: process.platform === "win32" && /\.cmd$/i.test(binary),
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`
        if (!error) {
          resolve({ code: 0, output })
          return
        }
        // A non zero exit carries the exit code; a spawn failure carries a string code.
        const exit: unknown = (error as { code?: unknown }).code
        resolve({ code: typeof exit === "number" ? exit : null, output: output || error.message })
      },
    )
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, Launch.LOOPBACK, () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port)
        } else {
          reject(new Error("no port"))
        }
      })
    })
  })
}

export function activate(context: vscode.ExtensionContext): RafikiCodeApi {
  const output = vscode.window.createOutputChannel("Rafiki Code")
  const status = vscode.window.createStatusBarItem("rafikicode.status", vscode.StatusBarAlignment.Right, 100)
  status.name = "Rafiki Code"
  status.command = "rafikicode.statusMenu"
  const sessions = new Map<vscode.Terminal, Launch.Session>()
  let lastTerminal: vscode.Terminal | undefined
  let signInTerminal: vscode.Terminal | undefined
  let state: KeyState = { kind: "checking" }
  let binary: BinaryResult = locateBinary()
  let refreshing: Promise<KeyState> | undefined
  let lastRefresh = 0

  context.subscriptions.push(output, status)

  function tier(): TierSetting {
    return normalizeTier(config().get<string>("tier"))
  }

  function render() {
    const t = tier()
    const view = statusView(state, t === "default" ? "" : TIER_INFO[t].label.toLowerCase())
    status.text = view.text
    status.tooltip = view.tooltip
    status.backgroundColor = view.warning ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined
    if (config().get<boolean>("showStatusBar", true)) {
      status.show()
    } else {
      status.hide()
    }
  }

  async function doRefresh(): Promise<KeyState> {
    binary = locateBinary()
    if (!binary.found) {
      state = { kind: "missing-binary", message: missingMessage(binary) }
      render()
      return state
    }
    const result = await run(binary.path, ["whoami", "--offline"], 15_000)
    state = parseWhoami(result.output, result.code)
    lastRefresh = Date.now()
    render()
    return state
  }

  function refresh(): Promise<KeyState> {
    if (!refreshing) {
      refreshing = doRefresh().finally(() => {
        refreshing = undefined
      })
    }
    return refreshing
  }

  // Resolves the binary or explains how to install it. Undefined when missing.
  async function requireBinary(): Promise<string | undefined> {
    binary = locateBinary()
    if (binary.found) {
      return binary.path
    }
    state = { kind: "missing-binary", message: missingMessage(binary) }
    render()
    output.appendLine(`[binary] not found. Checked:\n  ${binary.tried.join("\n  ")}`)
    const actions = binary.settingProblem ? ["Open Settings", "Show Checked Paths"] : ["Copy Install Command", "Install in Terminal", "Set Path", "Show Checked Paths"]
    // The choice is handled when the user makes it; the command does not wait for it.
    void vscode.window
      .showErrorMessage(missingMessage(binary), ...actions.filter((a) => a !== "Install in Terminal" || process.platform !== "win32"))
      .then(async (picked) => {
        if (picked === "Copy Install Command") {
          await vscode.env.clipboard.writeText(INSTALL_LINE)
          vscode.window.showInformationMessage(`Copied: ${INSTALL_LINE}. Run it in a terminal, then run Rafiki Code: Refresh Status.`)
        } else if (picked === "Install in Terminal") {
          const terminal = vscode.window.createTerminal({ name: "Rafiki Code Install" })
          terminal.show()
          terminal.sendText(INSTALL_LINE, true)
        } else if (picked === "Set Path" || picked === "Open Settings") {
          await vscode.commands.executeCommand("workbench.action.openSettings", "rafikicode.path")
        } else if (picked === "Show Checked Paths") {
          output.show(true)
        }
      })
    return undefined
  }

  // Resolves when a session may start; otherwise explains the no key state.
  async function requireKey(): Promise<boolean> {
    const current = await refresh()
    if (canStart(current)) {
      return true
    }
    if (current.kind === "missing-binary") {
      await requireBinary()
      return false
    }
    if (current.kind === "problem") {
      void vscode.window.showErrorMessage(`Rafiki Code cannot use its key: ${current.message}`, "Run Doctor", "Sign In").then((picked) => {
        if (picked === "Run Doctor") {
          void vscode.commands.executeCommand("rafikicode.doctor")
        } else if (picked === "Sign In") {
          void vscode.commands.executeCommand("rafikicode.signIn")
        }
      })
      return false
    }
    const expired = current.kind === "signed-in" && current.expired
    const message = expired
      ? "Your Rafiki Code key has expired. Sign in again to continue."
      : "Rafiki Code needs a Rafiki Console account. Sign in to use your Console wallet, or set RAFIKICODE_API_KEY to a server key before starting VS Code."
    void vscode.window.showWarningMessage(message, "Sign In", "Create Server Key", "Learn More").then((picked) => {
      if (picked === "Sign In") {
        void vscode.commands.executeCommand("rafikicode.signIn")
      } else if (picked === "Create Server Key") {
        void vscode.env.openExternal(vscode.Uri.parse(KEYS_URL))
      } else if (picked === "Learn More") {
        void vscode.env.openExternal(vscode.Uri.parse(DOCS_URL))
      }
    })
    return false
  }

  function workspaceCwd() {
    const editor = vscode.window.activeTextEditor
    const folder = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : undefined
    return (folder ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath
  }

  function terminalLocation(): vscode.TerminalOptions["location"] {
    return config().get<string>("terminalLocation", "editor") === "panel"
      ? vscode.TerminalLocation.Panel
      : { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }
  }

  async function openTerminal(initial?: string): Promise<vscode.Terminal | undefined> {
    const bin = await requireBinary()
    if (!bin || !(await requireKey())) {
      return undefined
    }
    const session: Launch.Session = { port: await freePort(), password: randomBytes(24).toString("hex") }
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      shellPath: bin,
      shellArgs: Launch.tuiArgs(session.port, tier()),
      cwd: workspaceCwd(),
      env: Launch.terminalEnv(session),
      iconPath: {
        light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
        dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
      },
      location: terminalLocation(),
      isTransient: true,
    })
    sessions.set(terminal, session)
    lastTerminal = terminal
    terminal.show()

    const text = initial ?? activeReference()
    if (!text) {
      return terminal
    }
    const ready = await Launch.waitReady(session, fetch)
    if (ready) {
      await Launch.appendPrompt(session, initial ?? openingPrompt(text), fetch).catch((cause) => {
        output.appendLine(`[append] ${cause instanceof Error ? cause.message : String(cause)}`)
      })
      terminal.show()
    } else {
      output.appendLine(`[open] the terminal interface did not answer on port ${session.port}`)
    }
    return terminal
  }

  function activeReference() {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      return undefined
    }
    const document = editor.document
    if (document.uri.scheme !== "file") {
      return undefined
    }
    const inWorkspace = vscode.workspace.getWorkspaceFolder(document.uri)
    const filePath = inWorkspace ? vscode.workspace.asRelativePath(document.uri, false) : document.uri.fsPath
    const selection = editor.selection
    return fileReference(filePath, {
      startLine: selection.start.line,
      endLine: selection.end.line,
      endCharacter: selection.end.character,
      isEmpty: selection.isEmpty,
    })
  }

  function targetTerminal(): vscode.Terminal | undefined {
    const active = vscode.window.activeTerminal
    if (active && sessions.has(active)) {
      return active
    }
    if (lastTerminal && sessions.has(lastTerminal)) {
      return lastTerminal
    }
    return sessions.keys().next().value
  }

  async function sendText(text: string) {
    const terminal = targetTerminal()
    if (!terminal) {
      await openTerminal(text)
      return
    }
    const session = sessions.get(terminal)!
    const ok = await Launch.appendPrompt(session, text, fetch).catch((cause) => {
      output.appendLine(`[append] ${cause instanceof Error ? cause.message : String(cause)}`)
      return false
    })
    if (!ok) {
      vscode.window.showWarningMessage("Rafiki Code did not accept the reference. Is the session still starting?")
    }
    terminal.show()
  }

  async function signIn() {
    const bin = await requireBinary()
    if (!bin) {
      return
    }
    const current = await refresh()
    if (current.kind === "server-key") {
      vscode.window.showInformationMessage(
        "RAFIKICODE_API_KEY is set in the VS Code environment, so Rafiki Code already uses that server key. Remove it from the environment and restart VS Code to sign in with your account instead.",
      )
      return
    }
    if (signInTerminal && vscode.window.terminals.includes(signInTerminal)) {
      signInTerminal.show()
      return
    }
    signInTerminal = vscode.window.createTerminal({
      name: SIGN_IN_TERMINAL_NAME,
      shellPath: bin,
      shellArgs: Launch.loginArgs(Launch.deviceLabel(String(context.extension.packageJSON.version ?? ""), os.hostname())),
      location: vscode.TerminalLocation.Panel,
      isTransient: true,
    })
    signInTerminal.show()
    void vscode.window.showInformationMessage("Follow the steps in the Rafiki Code Sign In terminal: open the link, enter the code, approve.", "Open Console").then((picked) => {
      if (picked === "Open Console") {
        vscode.env.openExternal(vscode.Uri.parse(`${CONSOLE_URL}/device`))
      }
    })
  }

  async function signOut() {
    const bin = await requireBinary()
    if (!bin) {
      return
    }
    const picked = await vscode.window.showWarningMessage(
      "Sign out of Rafiki Code? This revokes the key stored for this computer, for the editor and the terminal alike.",
      { modal: true },
      "Sign Out",
    )
    if (picked !== "Sign Out") {
      return
    }
    const result = await run(bin, ["logout"], 30_000)
    output.appendLine(`$ rafikicode logout (exit ${result.code})`)
    output.appendLine(stripAnsi(result.output).trimEnd())
    await refresh()
    if (result.code === 0) {
      vscode.window.showInformationMessage(stripAnsi(result.output).trim().split(/\r?\n/).pop() || "Signed out.")
    } else {
      void vscode.window.showErrorMessage("Rafiki Code sign out failed. See the Rafiki Code output.", "Show Output").then((p) => p && output.show(true))
    }
  }

  async function doctor() {
    const bin = await requireBinary()
    if (!bin) {
      return
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Rafiki Code: running doctor" },
      () => run(bin, ["doctor"], 120_000),
    )
    output.appendLine(`$ rafikicode doctor (exit ${result.code})`)
    output.appendLine(stripAnsi(result.output).trimEnd())
    output.appendLine("")
    output.show(true)
    const summary = summarizeDoctor(result.output, result.code)
    if (summary.ok) {
      vscode.window.showInformationMessage(summary.message)
    } else {
      void vscode.window.showWarningMessage(summary.message, "Show Output").then((p) => p && output.show(true))
    }
    await refresh()
  }

  async function showAccount() {
    const bin = await requireBinary()
    if (!bin) {
      return
    }
    const result = await run(bin, ["whoami"], 30_000)
    output.appendLine(`$ rafikicode whoami (exit ${result.code})`)
    output.appendLine(stripAnsi(result.output).trimEnd())
    output.appendLine("")
    output.show(true)
  }

  async function pickTier() {
    const current = tier()
    const items: Array<vscode.QuickPickItem & { value: TierSetting }> = [
      ...TIERS.map((t) => ({
        value: t as TierSetting,
        label: `${current === t ? "$(check) " : ""}${TIER_INFO[t].label}`,
        description: TIER_INFO[t].multiplier,
        detail: TIER_INFO[t].detail,
      })),
      {
        value: "default",
        label: `${current === "default" ? "$(check) " : ""}rafikicode default`,
        detail: "Use the model from your rafikicode configuration (rafiki-fast unless you changed it)",
      },
    ]
    const picked = await vscode.window.showQuickPick(items, {
      title: "Rafiki Code tier for the next session",
      placeHolder: "Credits are debited from your Rafiki Console wallet at the tier's multiplier",
    })
    if (!picked) {
      return
    }
    await config().update("tier", picked.value, vscode.ConfigurationTarget.Global)
    const suffix = sessions.size ? " Open a new Rafiki Code session to use it." : ""
    vscode.window.showInformationMessage(`Rafiki Code tier: ${picked.value === "default" ? "rafikicode default" : TIER_INFO[picked.value].label}.${suffix}`)
  }

  async function statusMenu() {
    const current = await refresh()
    if (current.kind === "missing-binary") {
      await requireBinary()
      return
    }
    if (current.kind === "no-key" || (current.kind === "signed-in" && current.expired)) {
      await signIn()
      return
    }
    const signedIn = current.kind === "signed-in"
    const items = [
      { label: "$(terminal) Open Rafiki Code", command: "rafikicode.open" },
      { label: "$(settings) Choose Tier", command: "rafikicode.pickTier" },
      { label: "$(account) Show Account", command: "rafikicode.showAccount" },
      { label: "$(pulse) Doctor", command: "rafikicode.doctor" },
      signedIn ? { label: "$(sign-out) Sign Out", command: "rafikicode.signOut" } : { label: "$(sign-in) Sign In", command: "rafikicode.signIn" },
    ]
    const picked = await vscode.window.showQuickPick(items, { title: "Rafiki Code" })
    if (picked) {
      await vscode.commands.executeCommand(picked.command)
    }
  }

  const register = (id: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))

  register("rafikicode.openNew", () => openTerminal())
  register("rafikicode.open", async () => {
    const existing = targetTerminal()
    if (existing) {
      existing.show()
      return
    }
    await openTerminal()
  })
  register("rafikicode.sendSelection", async () => {
    const reference = activeReference()
    if (reference) {
      await sendText(reference)
      return
    }
    const editor = vscode.window.activeTextEditor
    const text = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : undefined
    if (text) {
      await sendText(text)
      return
    }
    vscode.window.showInformationMessage("Open a file or select some text to send it to Rafiki Code.")
  })
  register("rafikicode.sendFile", async (uri: unknown) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri
    if (!target || target.scheme !== "file") {
      vscode.window.showInformationMessage("Choose a file to send to Rafiki Code.")
      return
    }
    const filePath = vscode.workspace.getWorkspaceFolder(target) ? vscode.workspace.asRelativePath(target, false) : target.fsPath
    await sendText(fileReference(filePath))
  })
  register("rafikicode.signIn", signIn)
  register("rafikicode.signOut", signOut)
  register("rafikicode.doctor", doctor)
  register("rafikicode.showAccount", showAccount)
  register("rafikicode.pickTier", pickTier)
  register("rafikicode.statusMenu", statusMenu)
  register("rafikicode.refreshStatus", refresh)

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal(async (terminal) => {
      sessions.delete(terminal)
      if (terminal === lastTerminal) {
        lastTerminal = undefined
      }
      if (terminal === signInTerminal) {
        signInTerminal = undefined
        const after = await refresh()
        if (after.kind === "signed-in" && !after.expired) {
          vscode.window.showInformationMessage(`Rafiki Code: signed in as ${after.account}.`)
        }
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SECTION)) {
        void refresh()
      }
    }),
    vscode.window.onDidChangeWindowState((window) => {
      if (window.focused && Date.now() - lastRefresh > 30_000) {
        void refresh()
      }
    }),
  )

  // The stored sign in lives in ~/.rafikicode/credentials (or under
  // XDG_CONFIG_HOME); a sign in or sign out from any terminal updates the status.
  const configDir = process.env["XDG_CONFIG_HOME"] ? path.join(process.env["XDG_CONFIG_HOME"], "rafikicode") : path.join(os.homedir(), ".rafikicode")
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(configDir), "credentials*"))
  watcher.onDidCreate(() => void refresh())
  watcher.onDidChange(() => void refresh())
  watcher.onDidDelete(() => void refresh())
  context.subscriptions.push(watcher)

  render()
  void refresh()

  return {
    keyState: () => state,
    refresh,
    binary: () => binary,
    sessions: () => [...sessions.values()],
  }
}

export function deactivate() {}
