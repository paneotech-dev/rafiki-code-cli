// The key state shown in the status bar, read from `rafikicode whoami --offline`
// (no network: it reports the stored sign in or the environment key).

export type KeyState =
  | { kind: "checking" }
  | { kind: "missing-binary"; message: string }
  | { kind: "signed-in"; account: string; key?: string; expired: boolean }
  | { kind: "server-key" }
  | { kind: "no-key" }
  | { kind: "problem"; message: string }

// Exit code 2 is the contract's usage code: no key, or an unusable credential file.
export const EXIT_USAGE = 2

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

export function stripAnsi(text: string) {
  return text.replace(ANSI, "")
}

function lines(output: string) {
  return stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function field(all: string[], name: string) {
  const prefix = `${name}:`
  const line = all.find((l) => l.startsWith(prefix))
  return line?.slice(prefix.length).trim()
}

function firstMessage(all: string[]) {
  const line = all.find((l) => l.startsWith("Error:")) ?? all[0]
  return line ? line.replace(/^Error:\s*/, "") : "rafikicode whoami failed with no output."
}

export function parseWhoami(output: string, exitCode: number | null): KeyState {
  const all = lines(output)
  if (exitCode === 0) {
    const credential = field(all, "Credential") ?? ""
    const account = field(all, "Account")
    if (/\(environment\)\s*$/.test(credential) || account?.startsWith("a server key from the environment")) {
      return { kind: "server-key" }
    }
    if (account) {
      const key = field(all, "Key")
      return { kind: "signed-in", account, key, expired: Boolean(key && /\(expired\b/.test(key)) }
    }
    return { kind: "problem", message: "rafikicode whoami answered without an account line. Run Rafiki Code: Doctor." }
  }
  const text = all.join("\n")
  if (exitCode === EXIT_USAGE && /Missing API key|not signed in/i.test(text)) {
    return { kind: "no-key" }
  }
  return { kind: "problem", message: firstMessage(all) }
}

export interface StatusView {
  text: string
  tooltip: string
  warning: boolean
}

export function statusView(state: KeyState, tierLabel: string): StatusView {
  const tier = tierLabel ? ` (${tierLabel})` : ""
  switch (state.kind) {
    case "checking":
      return { text: "$(sync~spin) Rafiki Code", tooltip: "Checking the Rafiki Code key", warning: false }
    case "missing-binary":
      return { text: "$(warning) Rafiki Code: install", tooltip: state.message, warning: true }
    case "no-key":
      return {
        text: "$(key) Rafiki Code: sign in",
        tooltip: "No Rafiki key. Click to sign in with your Rafiki AI account.",
        warning: true,
      }
    case "server-key":
      return {
        text: `$(sparkle) Rafiki Code${tier}`,
        tooltip: "Using the server key from RAFIKICODE_API_KEY in the VS Code environment.",
        warning: false,
      }
    case "signed-in":
      if (state.expired) {
        return {
          text: "$(key) Rafiki Code: sign in again",
          tooltip: `The key for ${state.account} has expired. Click to sign in again.`,
          warning: true,
        }
      }
      return {
        text: `$(sparkle) Rafiki Code${tier}`,
        tooltip: `Signed in as ${state.account}${state.key ? `\nKey: ${state.key}` : ""}`,
        warning: false,
      }
    case "problem":
      return { text: "$(warning) Rafiki Code", tooltip: `${state.message}\nClick for actions, or run Rafiki Code: Doctor.`, warning: true }
  }
}

// True when a session can start: a key is present and not known to be expired.
export function canStart(state: KeyState) {
  return state.kind === "server-key" || (state.kind === "signed-in" && !state.expired)
}
