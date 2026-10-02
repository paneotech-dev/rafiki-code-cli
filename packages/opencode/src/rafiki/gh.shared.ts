/**
 * Local GitHub capability: branch, commit, push, pull requests, issues and
 * comments, carried out by the user's own `git` and `gh` binaries with the
 * credentials already on their machine.
 *
 * rafikicode stores no GitHub credential. Nothing is written to
 * ~/.rafikicode, nothing is sealed, nothing can leak from here, and there is
 * no token for this code to lose: `gh` holds the user's auth in their keyring
 * and we only ever read its exit code and its output. The same reason means a
 * user who has not run `gh auth login` gets a message saying exactly that
 * rather than a prompt to paste a token.
 *
 * Every call goes out as an argv array through `Process.run`, never a shell
 * string and never `shell: true`, so a branch name, a commit message or an
 * issue body containing quotes, newlines or `$(...)` is passed through as one
 * argument and cannot become a command. That is why bodies go on argv here
 * instead of through a temporary file.
 *
 * The `Exec` seam is the whole point of this file: the command layer passes
 * `processExec`, tests pass a recorded fake, so no test spawns `git` or `gh`
 * or reaches github.com.
 */
import { Brand } from "@opencode-ai/core/brand/brand"
import { Process } from "@/util/process"

export interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface ExecOptions {
  readonly cwd?: string
}

/** Runs one argv array and reports its exit code and output. Never throws. */
export type Exec = (cmd: readonly string[], opts?: ExecOptions) => Promise<ExecResult>

/** The real seam: a subprocess with no shell, and a non-zero exit is data, not an error. */
export const processExec: Exec = async (cmd, opts) => {
  const out = await Process.run([...cmd], { cwd: opts?.cwd, nothrow: true })
  return { code: out.code, stdout: out.stdout.toString(), stderr: out.stderr.toString() }
}

/** `gh` and `git` disagree about which stream status goes to across versions; read both. */
export function bothStreams(result: ExecResult): string {
  return [result.stdout, result.stderr].filter((part) => part.trim()).join("\n")
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? ""
}

/** The most useful line of a failed command, for a message the user can act on. */
export function failureDetail(result: ExecResult): string {
  return firstLine(bothStreams(result)) || `exited with code ${result.code}`
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export type GhTrouble = "gh_missing" | "gh_unauthenticated"

export type GhCheck = { readonly ok: true; readonly account?: string } | { readonly ok: false; readonly reason: GhTrouble }

/**
 * The account name out of `gh auth status`. Two formats are in the wild:
 *   ✓ Logged in to github.com account octocat (keyring)
 *   ✓ Logged in to github.com as octocat (oauth_token)
 * Returns undefined when neither matches — an unnamed account is still a
 * working one, so this never decides whether auth is present.
 */
export function parseGhAccount(text: string): string | undefined {
  const match = /Logged in to \S+ (?:account|as) ([A-Za-z0-9-]+)/.exec(text)
  return match ? match[1] : undefined
}

/**
 * Whether `gh` is installed and logged in. `gh --version` separates "not
 * installed" from "not logged in", which matter to the user for different
 * reasons and get different messages.
 */
export async function checkGh(exec: Exec, opts?: ExecOptions): Promise<GhCheck> {
  const version = await exec(["gh", "--version"], opts)
  if (version.code !== 0) return { ok: false, reason: "gh_missing" }
  const status = await exec(["gh", "auth", "status"], opts)
  if (status.code !== 0) return { ok: false, reason: "gh_unauthenticated" }
  return { ok: true, account: parseGhAccount(bothStreams(status)) }
}

/** What to tell the user, naming the command that fixes it. */
export function ghTroubleMessage(reason: GhTrouble): string {
  if (reason === "gh_missing") {
    return [
      `The GitHub CLI (gh) was not found on your PATH.`,
      `${Brand.name} uses your own gh and git, and stores no GitHub credential of its own.`,
      `Install it from https://cli.github.com, then run: gh auth login`,
    ].join("\n")
  }
  return [
    `The GitHub CLI (gh) is installed but not logged in.`,
    `${Brand.name} uses the GitHub account gh is already logged in to, and stores no credential of its own.`,
    `Run: gh auth login`,
  ].join("\n")
}

/** The repository root, or undefined when the directory is not a git work tree. */
export async function gitRoot(exec: Exec, cwd: string): Promise<string | undefined> {
  const out = await exec(["git", "rev-parse", "--show-toplevel"], { cwd })
  if (out.code !== 0) return undefined
  return firstLine(out.stdout) || undefined
}

export function notARepoMessage(): string {
  return `Could not find a git repository here. Run this command from inside a git repository.`
}

/**
 * The checked out branch, or undefined on a detached HEAD or outside a
 * repository. `branch --show-current` rather than `rev-parse --abbrev-ref`:
 * it still names a branch that has no commits yet (where rev-parse fails), and
 * it prints nothing for a detached HEAD instead of the literal "HEAD".
 */
export async function currentBranch(exec: Exec, cwd: string): Promise<string | undefined> {
  const out = await exec(["git", "branch", "--show-current"], { cwd })
  if (out.code !== 0) return undefined
  return firstLine(out.stdout) || undefined
}

// ---------------------------------------------------------------------------
// Argv builders. Pure, so tests can assert the exact argv without a subprocess.
// ---------------------------------------------------------------------------

/**
 * `git switch -c` when the branch is new, `git switch` when it exists. Using
 * switch rather than checkout keeps the failure clear: it refuses rather than
 * silently treating the name as a path.
 */
export function branchArgs(name: string, exists: boolean): string[] {
  return exists ? ["git", "switch", "--", name] : ["git", "switch", "--create", name]
}

export function commitArgs(message: string): string[] {
  return ["git", "commit", "-m", message]
}

/** `-A` from the repository root, so the whole work tree is staged the same way wherever the command ran. */
export function stageArgs(): string[] {
  return ["git", "add", "-A"]
}

export function pushArgs(branch: string, opts?: { readonly remote?: string; readonly forceWithLease?: boolean }): string[] {
  const args = ["git", "push", "--set-upstream", opts?.remote ?? "origin", branch]
  // --force-with-lease, never --force: it refuses when the remote moved under us.
  if (opts?.forceWithLease) args.splice(2, 0, "--force-with-lease")
  return args
}

export interface PrCreateInput {
  readonly title: string
  readonly body: string
  readonly base?: string
  readonly draft?: boolean
}

export function prCreateArgs(input: PrCreateInput): string[] {
  const args = ["gh", "pr", "create", "--title", input.title, "--body", input.body]
  if (input.base) args.push("--base", input.base)
  if (input.draft) args.push("--draft")
  return args
}

export function prCommentArgs(number: number, body: string): string[] {
  return ["gh", "pr", "comment", String(number), "--body", body]
}

export const ISSUE_LIST_FIELDS = "number,title,state,author,url,labels" as const
export const ISSUE_VIEW_FIELDS = "number,title,state,author,url,body,comments" as const

export function issueListArgs(opts?: { readonly limit?: number; readonly state?: string }): string[] {
  const args = ["gh", "issue", "list", "--json", ISSUE_LIST_FIELDS]
  args.push("--limit", String(opts?.limit ?? 20))
  if (opts?.state) args.push("--state", opts.state)
  return args
}

export function issueViewArgs(number: number): string[] {
  return ["gh", "issue", "view", String(number), "--json", ISSUE_VIEW_FIELDS]
}

export function issueCommentArgs(number: number, body: string): string[] {
  return ["gh", "issue", "comment", String(number), "--body", body]
}

// ---------------------------------------------------------------------------
// Reading what gh returns
// ---------------------------------------------------------------------------

export interface IssueSummary {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly author?: string
  readonly url?: string
  readonly labels: string[]
}

export interface IssueComment {
  readonly author?: string
  readonly body: string
}

export interface IssueDetail extends IssueSummary {
  readonly body: string
  readonly comments: IssueComment[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function login(value: unknown): string | undefined {
  const record = asRecord(value)
  const name = record?.["login"]
  return typeof name === "string" && name ? name : undefined
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => asRecord(entry)?.["name"]).filter((name): name is string => typeof name === "string" && name !== "")
}

function summary(record: Record<string, unknown>): IssueSummary {
  return {
    number: typeof record["number"] === "number" ? record["number"] : 0,
    title: typeof record["title"] === "string" ? record["title"] : "",
    state: typeof record["state"] === "string" ? record["state"] : "",
    author: login(record["author"]),
    url: typeof record["url"] === "string" ? record["url"] : undefined,
    labels: labelNames(record["labels"]),
  }
}

/** `gh issue list --json` output. Anything unparseable is an empty list, never a throw. */
export function parseIssueList(text: string): IssueSummary[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map(asRecord).filter((record): record is Record<string, unknown> => record !== undefined).map(summary)
}

export function parseIssueDetail(text: string): IssueDetail | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const record = asRecord(parsed)
  if (!record) return undefined
  const comments = Array.isArray(record["comments"])
    ? record["comments"]
        .map(asRecord)
        .filter((entry): entry is Record<string, unknown> => entry !== undefined)
        .map((entry) => ({
          author: login(entry["author"]),
          body: typeof entry["body"] === "string" ? entry["body"] : "",
        }))
    : []
  return {
    ...summary(record),
    body: typeof record["body"] === "string" ? record["body"] : "",
    comments,
  }
}

/** The pull request URL `gh pr create` prints, so the command can name it. */
export function parsePrUrl(text: string): string | undefined {
  const match = /https:\/\/[^\s]*\/pull\/\d+/.exec(text)
  return match ? match[0] : undefined
}

/** Whether a local branch already exists, deciding between `switch` and `switch -c`. */
export async function branchExists(exec: Exec, cwd: string, name: string): Promise<boolean> {
  const out = await exec(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { cwd })
  return out.code === 0
}

/** Whether anything is staged or unstaged, so `commit` can say "nothing to commit" itself. */
export async function hasChanges(exec: Exec, cwd: string): Promise<boolean> {
  const out = await exec(["git", "status", "--porcelain"], { cwd })
  return out.code === 0 && out.stdout.trim().length > 0
}

/** One line per issue, for `issue list`. */
export function formatIssueLine(issue: IssueSummary): string {
  const parts = [`#${issue.number}`, issue.title]
  const trailing = [issue.state.toLowerCase(), issue.author ? `by ${issue.author}` : undefined, ...issue.labels]
    .filter((part): part is string => Boolean(part))
    .join(", ")
  return trailing ? `${parts.join("  ")}  (${trailing})` : parts.join("  ")
}
