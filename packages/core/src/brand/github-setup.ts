// The guided GitHub setup behind `/github` in the terminal interface and
// `rafikicode github`: put the project in the current folder on GitHub as a
// private repository, one confirmed step at a time.
//
//   1. git and the GitHub CLI (gh) are installed, and gh is signed in
//      (`gh auth status`); if not, say how to fix it on this system and stop.
//   2. The folder is a git repository; if not, offer to create one.
//   3. Scan what would be pushed for secrets (.env files, private keys,
//      obvious tokens). Anything found: add the file names to .gitignore,
//      list what was found and stop.
//   4. Make the first commit when there is none.
//   5. Create a private repository with `gh repo create` (name suggested
//      from the folder, the person confirms or changes it), unless the
//      repository already has a remote named origin.
//   6. Push the branch and show the repository's URL.
//   7. Offer the next steps: a pull request, and deploying to a server
//      (docs/github.md).
//
// Every step that changes something asks first. The person's own git and gh
// do the work with the credentials already on the machine; nothing is stored
// here. All I/O goes through the Io interface, so the interface, the command
// line and the tests each bring their own.
import { spawn } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  // The program was not found.
  missing?: boolean
}

export type Exec = (cmd: readonly string[], opts?: { cwd?: string }) => Promise<ExecResult>

export interface Io {
  exec: Exec
  cwd: string
  platform: NodeJS.Platform
  home: string
  // A line of progress for the person.
  say(text: string): void | Promise<void>
  // A yes or no question; false when declined or when nobody can answer.
  confirm(question: string): Promise<boolean>
  // A question with a suggested answer; undefined when cancelled.
  ask(question: string, suggested: string): Promise<string | undefined>
  // Where the deploy guide lives, for the next steps.
  guide: string
}

export type Outcome =
  | { status: "done"; url?: string; message: string }
  | { status: "stopped"; message: string }
  | { status: "cancelled"; message: string }

// The real seam: no shell, a non-zero exit is data, a missing program is reported.
export const processExec: Exec = (cmd, opts) =>
  new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const done = (result: ExecResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      const child = spawn(cmd[0], cmd.slice(1), { cwd: opts?.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" } })
      child.stdout?.on("data", (chunk) => (stdout += chunk))
      child.stderr?.on("data", (chunk) => (stderr += chunk))
      child.on("error", (error: NodeJS.ErrnoException) => done({ code: -1, stdout, stderr: stderr || error.message, missing: error.code === "ENOENT" }))
      child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }))
    } catch (error) {
      done({ code: -1, stdout, stderr: error instanceof Error ? error.message : String(error), missing: true })
    }
  })

function firstLine(result: ExecResult) {
  return (
    [result.stderr, result.stdout]
      .join("\n")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? `exited with code ${result.code}`
  )
}

// ---------------------------------------------------------------------------
// What to install, per system
// ---------------------------------------------------------------------------

export function installGit(platform: NodeJS.Platform) {
  if (platform === "win32")
    return [
      "git is not installed. Install it in PowerShell:",
      "  winget install --id Git.Git -e",
      "Then close this window, open a new PowerShell window, and run this again.",
    ].join("\n")
  if (platform === "darwin")
    return [
      "git is not installed. Install it with the Apple command line tools:",
      "  xcode-select --install",
      "or with Homebrew: brew install git. Then run this again.",
    ].join("\n")
  return [
    "git is not installed. Install it with your system's package manager:",
    "  Debian or Ubuntu: sudo apt install git",
    "  Fedora: sudo dnf install git",
    "  Arch: sudo pacman -S git",
    "Then run this again.",
  ].join("\n")
}

export function installGh(platform: NodeJS.Platform) {
  const signIn = "Then sign in once with: gh auth login (choose GitHub.com, HTTPS, and Login with a web browser)."
  if (platform === "win32")
    return [
      "The GitHub CLI (gh) is not installed. Install it in PowerShell:",
      "  winget install --id GitHub.cli -e",
      "Close this window and open a new PowerShell window so gh is found.",
      signIn,
    ].join("\n")
  if (platform === "darwin")
    return ["The GitHub CLI (gh) is not installed. Install it with Homebrew:", "  brew install gh", "or download it from https://cli.github.com.", signIn].join("\n")
  return [
    "The GitHub CLI (gh) is not installed. Install it with your system's package manager:",
    "  Debian or Ubuntu: sudo apt install gh",
    "  Fedora: sudo dnf install gh",
    "  Arch: sudo pacman -S github-cli",
    "If your system has no gh package, or only an old one, follow https://github.com/cli/cli/blob/trunk/docs/install_linux.md.",
    signIn,
  ].join("\n")
}

export function signIn(platform: NodeJS.Platform) {
  const where = platform === "win32" ? "a PowerShell window" : "a terminal"
  return [
    "The GitHub CLI (gh) is installed but not signed in. In " + where + ", run:",
    "  gh auth login",
    "Choose GitHub.com, then HTTPS, then Login with a web browser, and follow the steps. Then run this again.",
    "Your GitHub sign-in stays with gh; it is not stored here.",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export interface SecretFinding {
  file: string
  line?: number
  kind: string
  // Where it is: "file" (would be pushed now) or "history" (in an earlier commit).
  where: "file" | "history"
}

const ENV_SAFE = /\.(example|sample|template|dist|defaults?)$/i
const KEY_FILES = /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$|\.(pem|key|p12|pfx|jks|keystore|ppk)$/i
const OTHER_FILES = /^(\.netrc|_netrc|\.pgpass|\.git-credentials)$/i

// The kind of secret a file's name says it holds, or undefined.
export function secretFileKind(file: string) {
  const name = path.posix.basename(file.replaceAll("\\", "/"))
  if ((name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) && !ENV_SAFE.test(name)) return "environment file"
  if (KEY_FILES.test(name)) return "private key or certificate file"
  if (OTHER_FILES.test(name)) return "credentials file"
  return undefined
}

const PATTERNS: { kind: string; pattern: RegExp }[] = [
  { kind: "private key", pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { kind: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: "Stripe live key", pattern: /\b[rs]k_live_[0-9A-Za-z]{20,}/ },
  { kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { kind: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b|_authToken=[^\s$]{10,}/ },
  { kind: "API key (sk-...)", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
]
// A line carrying this text is not reported (a test fixture, a documented example).
export const ALLOW_MARK = "secret-scan: allow"
const MAX_FILE_BYTES = 1_000_000
const MAX_FILES = 20_000

// The secrets in one file's text, by line.
export function scanText(file: string, text: string): SecretFinding[] {
  const found: SecretFinding[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes(ALLOW_MARK)) continue
    for (const { kind, pattern } of PATTERNS) {
      if (pattern.test(line)) {
        found.push({ file, line: i + 1, kind, where: "file" })
        break
      }
    }
  }
  return found
}

function nul(text: string) {
  return text.split("\0").filter(Boolean)
}

// Everything a push from `root` would carry that looks like a secret: files
// `git add -A` would include or that are tracked, and secret-looking file
// names in earlier commits.
export async function scan(exec: Exec, root: string): Promise<{ findings: SecretFinding[]; files: number }> {
  const listed = await exec(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root })
  const files = Array.from(new Set(nul(listed.stdout))).filter((file) => fs.existsSync(path.join(root, file)))
  const findings: SecretFinding[] = []
  for (const file of files.slice(0, MAX_FILES)) {
    const kind = secretFileKind(file)
    if (kind) {
      findings.push({ file, kind, where: "file" })
      continue
    }
    const full = path.join(root, file)
    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue
    const buffer = fs.readFileSync(full)
    if (buffer.subarray(0, 8000).includes(0)) continue
    findings.push(...scanText(file, buffer.toString("utf8")))
  }
  const head = await exec(["git", "rev-parse", "--verify", "-q", "HEAD"], { cwd: root })
  if (head.code === 0) {
    const history = await exec(["git", "log", "--all", "--pretty=format:", "--name-only", "-z"], { cwd: root })
    const now = new Set(files)
    for (const file of new Set(history.stdout.split(/[\0\n]/).map((f) => f.trim()).filter(Boolean))) {
      if (now.has(file)) continue
      const kind = secretFileKind(file)
      if (kind) findings.push({ file, kind, where: "history" })
    }
  }
  return { findings, files: files.length }
}

// The .gitignore lines that keep the found secret files out, added once.
export function gitignoreAdditions(existing: string, findings: SecretFinding[]) {
  const have = new Set(existing.split(/\r?\n/).map((line) => line.trim()))
  const wanted: string[] = []
  const add = (line: string) => {
    if (!have.has(line) && !wanted.includes(line)) wanted.push(line)
  }
  for (const item of findings) {
    if (item.where !== "file" || item.line !== undefined) continue
    const name = path.posix.basename(item.file.replaceAll("\\", "/"))
    if (item.kind === "environment file") {
      add(".env")
      add(".env.*")
      add("!.env.example")
      if (name !== ".env" && !name.startsWith(".env.")) add(name)
    } else add("/" + item.file.replaceAll("\\", "/"))
  }
  return wanted
}

function describe(item: SecretFinding) {
  if (item.where === "history") return `  ${item.file}: ${item.kind}, in an earlier commit`
  return item.line === undefined ? `  ${item.file}: ${item.kind}` : `  ${item.file}:${item.line}: ${item.kind}`
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

// A repository name GitHub accepts, suggested from the folder name.
export function suggestName(folder: string) {
  const name = path
    .basename(folder)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100)
  return name || "my-project"
}

export function validName(name: string) {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== "." && name !== ".."
}

// The web address of a GitHub remote, when it is one.
export function webUrl(remote: string) {
  const ssh = remote.match(/^(?:ssh:\/\/)?git@github\.com[:/](.+?)(?:\.git)?\/?$/)
  if (ssh) return `https://github.com/${ssh[1]}`
  const https = remote.match(/^https:\/\/(?:[^@/]+@)?github\.com\/(.+?)(?:\.git)?\/?$/)
  if (https) return `https://github.com/${https[1]}`
  return undefined
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

const DEPENDENCY_DIRS = new Set(["node_modules", ".venv", "venv", "__pycache__", ".pnpm-store"])

function unsafeFolder(dir: string, home: string) {
  const resolved = path.resolve(dir)
  return resolved === path.resolve(home) || resolved === path.parse(resolved).root
}

export function nextSteps(guide: string, opts: { pr?: string } = {}) {
  return [
    "Next steps:",
    opts.pr
      ? `  Pull request: ${opts.pr}`
      : "  Pull request: work on a branch (git switch -c my-change), commit, push it, then run gh pr create --fill. Every push asks for your yes first.",
    `  Deploy to a server: pull-based deploy is recommended, GitHub Actions over SSH is the alternative. Guide: ${guide}`,
  ].join("\n")
}

export async function run(io: Io): Promise<Outcome> {
  const stop = (message: string): Outcome => ({ status: "stopped", message })
  const cancel = (message = "Stopped. Nothing else was changed."): Outcome => ({ status: "cancelled", message })
  const { exec } = io

  // 1. Tools.
  const git = await exec(["git", "--version"])
  if (git.missing || git.code !== 0) return stop(installGit(io.platform))
  const gh = await exec(["gh", "--version"])
  if (gh.missing || gh.code !== 0) return stop(installGh(io.platform))
  const auth = await exec(["gh", "auth", "status"], { cwd: io.cwd })
  if (auth.code !== 0) return stop(signIn(io.platform))
  const login = await exec(["gh", "api", "user", "--jq", ".login"], { cwd: io.cwd })
  const account = login.code === 0 ? login.stdout.trim() : ""
  await io.say(`GitHub CLI signed in${account ? ` as ${account}` : ""}.`)

  // 2. Repository.
  const top = await exec(["git", "rev-parse", "--show-toplevel"], { cwd: io.cwd })
  let root = top.code === 0 ? path.resolve(top.stdout.trim()) : ""
  if (!root) {
    if (unsafeFolder(io.cwd, io.home))
      return stop(`${io.cwd} is your home folder or the top of a drive. Open the project's own folder first, then run this again.`)
    if (!(await io.confirm(`${io.cwd} is not a git repository yet. Create one here?`))) return cancel()
    const init = await exec(["git", "init"], { cwd: io.cwd })
    if (init.code !== 0) return stop(`git init failed: ${firstLine(init)}`)
    await exec(["git", "symbolic-ref", "HEAD", "refs/heads/main"], { cwd: io.cwd })
    root = path.resolve(io.cwd)
    await io.say(`Created a git repository in ${root}.`)
  } else if (unsafeFolder(root, io.home)) {
    return stop(`The git repository here starts at ${root}, your home folder or the top of a drive. Open the project's own folder, with a repository of its own, then run this again.`)
  }

  // Installed dependencies do not belong in the first commit (and are not scanned).
  const first = (await exec(["git", "rev-parse", "--verify", "-q", "HEAD"], { cwd: root })).code !== 0
  if (first) {
    const deps = await exec(["git", "ls-files", "-z", "--others", "--exclude-standard", "--directory"], { cwd: root })
    const heavy = nul(deps.stdout).map((dir) => dir.replace(/[\\/]+$/, "")).filter((dir) => DEPENDENCY_DIRS.has(dir))
    if (heavy.length) {
      const gitignore = path.join(root, ".gitignore")
      const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : ""
      const prefix = existing && !existing.endsWith("\n") ? "\n" : ""
      fs.appendFileSync(gitignore, `${prefix}${heavy.map((dir) => "/" + dir + "/").join("\n")}\n`)
      await io.say(`Added ${heavy.join(", ")} to .gitignore: installed dependencies are not committed.`)
    }
  }

  // 3. Secrets.
  const scanned = await scan(exec, root)
  if (scanned.findings.length) {
    const gitignore = path.join(root, ".gitignore")
    const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : ""
    const additions = gitignoreAdditions(existing, scanned.findings)
    if (additions.length) {
      const prefix = existing && !existing.endsWith("\n") ? "\n" : ""
      fs.appendFileSync(gitignore, `${prefix}# Secrets, kept out of the repository\n${additions.join("\n")}\n`)
    }
    const tracked = await exec(["git", "ls-files", "-z", "--cached"], { cwd: root })
    const trackedFiles = new Set(nul(tracked.stdout))
    const stillTracked = scanned.findings.filter((item) => item.where === "file" && item.line === undefined && trackedFiles.has(item.file))
    const lines = [
      "Nothing was pushed: these look like secrets.",
      ...scanned.findings.slice(0, 30).map(describe),
      ...(scanned.findings.length > 30 ? [`  and ${scanned.findings.length - 30} more`] : []),
      ...(additions.length ? [`Added to .gitignore: ${additions.join(", ")}.`] : []),
      ...(stillTracked.length
        ? [`Already committed, so .gitignore alone does not remove them: run git rm --cached ${stillTracked.map((item) => item.file).join(" ")} and commit.`]
        : []),
      ...(scanned.findings.some((item) => item.line !== undefined)
        ? [`Move secrets inside files to an environment file that is ignored. A line that is not a secret (a test value) can carry the comment "${ALLOW_MARK}".`]
        : []),
      ...(scanned.findings.some((item) => item.where === "history")
        ? ["A file in an earlier commit is pushed with the history. Remove it from the history, or start a new repository from the current files, before pushing."]
        : []),
      "Then run this again.",
    ]
    return stop(lines.join("\n"))
  }
  await io.say(`No secrets found in ${scanned.files} files.`)

  // 4. First commit.
  if (first) {
    if (scanned.files === 0) return stop("The folder has no files to put on GitHub yet.")
    if (!(await io.confirm(`Commit the ${scanned.files} files in ${root} as the first commit ("Initial commit")?`))) return cancel()
    const add = await exec(["git", "add", "-A"], { cwd: root })
    if (add.code !== 0) return stop(`git add failed: ${firstLine(add)}`)
    const commit = await exec(["git", "commit", "-q", "-m", "Initial commit"], { cwd: root })
    if (commit.code !== 0) {
      const text = `${commit.stderr}\n${commit.stdout}`
      if (/tell me who you are|user\.email|user\.name|author identity/i.test(text))
        return stop(
          [
            "git does not know your name and email yet, so it cannot commit. Set them once:",
            '  git config --global user.name "Your Name"',
            '  git config --global user.email "you@example.com"',
            "Then run this again.",
          ].join("\n"),
        )
      return stop(`git commit failed: ${firstLine(commit)}`)
    }
    await io.say("Made the first commit.")
  } else {
    const status = await exec(["git", "status", "--porcelain"], { cwd: root })
    const changed = status.stdout.split("\n").filter((line) => line.trim()).length
    if (changed) await io.say(`${changed} changed ${changed === 1 ? "file is" : "files are"} not committed and will not be pushed.`)
  }

  const branch = await exec(["git", "symbolic-ref", "--short", "HEAD"], { cwd: root })
  if (branch.code !== 0) return stop("HEAD is detached: switch to a branch (git switch main), then run this again.")
  const current = branch.stdout.trim()

  // 5. Repository on GitHub.
  const origin = await exec(["git", "remote", "get-url", "origin"], { cwd: root })
  let remote = origin.code === 0 ? origin.stdout.trim() : ""
  let created = false
  if (remote) {
    await io.say(`This repository already has a remote: origin is ${remote}.`)
  } else {
    let name: string | undefined = suggestName(root)
    for (;;) {
      name = await io.ask("Name of the new private repository on GitHub", name)
      if (name === undefined) return cancel()
      name = name.trim()
      if (validName(name)) break
      await io.say("A repository name uses letters, digits, '.', '-' and '_' only, up to 100 characters.")
      name = suggestName(name)
    }
    const owner = account ? `${account}/` : ""
    if (!(await io.confirm(`Create the private repository ${owner}${name} on GitHub and add it as origin?`))) return cancel()
    const create = await exec(["gh", "repo", "create", name, "--private", "--source", root, "--remote", "origin"], { cwd: root })
    if (create.code !== 0) return stop(`gh repo create failed: ${firstLine(create)}`)
    const after = await exec(["git", "remote", "get-url", "origin"], { cwd: root })
    remote = after.stdout.trim()
    created = true
    await io.say(`Created the private repository ${owner}${name}.`)
  }

  // 6. Push.
  if (!(await io.confirm(`Push the branch ${current} to origin (${remote})?`))) return cancel(created ? "The repository was created on GitHub; nothing was pushed." : undefined)
  const push = await exec(["git", "push", "-u", "origin", current], { cwd: root })
  if (push.code !== 0) return stop(`git push failed: ${firstLine(push)}`)
  const view = await exec(["gh", "repo", "view", "--json", "url", "--jq", ".url"], { cwd: root })
  const url = (view.code === 0 && view.stdout.trim()) || webUrl(remote) || remote
  await io.say(`Pushed ${current}. The repository is at ${url}`)

  // 7. Next steps.
  const base = await exec(["gh", "repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], { cwd: root })
  const defaultBranch = base.code === 0 ? base.stdout.trim() : ""
  let pr: string | undefined
  if (defaultBranch && defaultBranch !== current && (await io.confirm(`Open a pull request from ${current} into ${defaultBranch}?`))) {
    const create = await exec(["gh", "pr", "create", "--fill", "--base", defaultBranch, "--head", current], { cwd: root })
    if (create.code !== 0) await io.say(`gh pr create failed: ${firstLine(create)}`)
    else pr = create.stdout.split(/\s+/).find((word) => /^https:\/\/\S+\/pull\/\d+/.test(word)) ?? create.stdout.trim()
  }
  return { status: "done", url, message: `Done: ${url}\n${nextSteps(io.guide, { pr })}` }
}

export function defaults() {
  return { exec: processExec, platform: process.platform, home: os.homedir() }
}
