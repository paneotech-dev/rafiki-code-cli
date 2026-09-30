/**
 * `rafikicode gh ...`: branch, commit, push, open a pull request, read and
 * comment on issues — all through the user's own `git` and `gh`, with the
 * credentials already on their machine. See gh.shared.ts for why nothing is
 * stored and why every call is an argv array.
 *
 * This is a separate command from the unregistered `github` group (the GitHub
 * Actions agent, github.handler.ts), which runs inside a workflow with a
 * workflow token and is a different mechanism entirely.
 */
import { Brand } from "@opencode-ai/core/brand/brand"
import { Effect } from "effect"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import {
  branchArgs,
  branchExists,
  checkGh,
  commitArgs,
  currentBranch,
  failureDetail,
  formatIssueLine,
  ghTroubleMessage,
  gitRoot,
  hasChanges,
  issueCommentArgs,
  issueListArgs,
  issueViewArgs,
  notARepoMessage,
  parseIssueDetail,
  parseIssueList,
  parsePrUrl,
  prCommentArgs,
  prCreateArgs,
  processExec,
  pushArgs,
  stageArgs,
  type Exec,
  type ExecResult,
} from "./gh.shared"

const exec: Exec = processExec

/** The repository root, or a printed message naming what the user should do. */
const requireRepo = (cwd: string) =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => gitRoot(exec, cwd))
    if (!root) return yield* fail(notARepoMessage())
    return root
  })

/** `gh` present and logged in, or a message naming `gh auth login`. */
const requireGh = (cwd: string) =>
  Effect.gen(function* () {
    const check = yield* Effect.promise(() => checkGh(exec, { cwd }))
    if (!check.ok) return yield* fail(ghTroubleMessage(check.reason))
    return check
  })

/** Run one argv array, or fail with the command's own first line of output. */
const runOrFail = (args: readonly string[], cwd: string, what: string) =>
  Effect.gen(function* () {
    const out: ExecResult = yield* Effect.promise(() => exec(args, { cwd }))
    if (out.code !== 0) return yield* fail(`${what}: ${failureDetail(out)}`)
    return out
  })

const GhStatusCommand = effectCmd({
  command: "status",
  describe: "show the git repository and GitHub CLI status",
  instance: false,
  handler: Effect.fn("Cli.gh.status")(function* () {
    const cwd = process.cwd()
    const root = yield* Effect.promise(() => gitRoot(exec, cwd))
    UI.println(root ? `repository: ${root}` : `repository: none (not a git repository)`)
    if (root) {
      const branch = yield* Effect.promise(() => currentBranch(exec, root))
      UI.println(`branch:     ${branch ?? "(detached HEAD)"}`)
    }

    const check = yield* Effect.promise(() => checkGh(exec, { cwd }))
    if (check.ok) {
      UI.println(`gh:         logged in${check.account ? ` as ${check.account}` : ""}`)
      UI.println()
      UI.println(`${Brand.name} uses your own gh and git and stores no GitHub credential.`)
      return
    }
    UI.println(`gh:         ${check.reason === "gh_missing" ? "not installed" : "not logged in"}`)
    UI.println()
    UI.println(ghTroubleMessage(check.reason))
  }),
})

const GhBranchCommand = effectCmd({
  command: "branch <name>",
  describe: "create or switch to a branch",
  instance: false,
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "branch name",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.gh.branch")(function* (args) {
    const root = yield* requireRepo(process.cwd())
    const exists = yield* Effect.promise(() => branchExists(exec, root, args.name))
    yield* runOrFail(branchArgs(args.name, exists), root, `Could not switch to branch '${args.name}'`)
    UI.println(exists ? `Switched to branch '${args.name}'` : `Created and switched to branch '${args.name}'`)
  }),
})

const GhCommitCommand = effectCmd({
  command: "commit",
  describe: "stage the work tree and commit",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("message", {
        type: "string",
        alias: "m",
        describe: "commit message",
        demandOption: true,
      })
      .option("stage", {
        type: "boolean",
        default: true,
        describe: "stage every change first (--no-stage commits only what is already staged)",
      }),
  handler: Effect.fn("Cli.gh.commit")(function* (args) {
    const root = yield* requireRepo(process.cwd())
    if (args.stage) {
      const dirty = yield* Effect.promise(() => hasChanges(exec, root))
      if (!dirty) return yield* fail("Nothing to commit: the work tree is clean.")
      yield* runOrFail(stageArgs(), root, "Could not stage changes")
    }
    yield* runOrFail(commitArgs(args.message), root, "Could not commit")
    const branch = yield* Effect.promise(() => currentBranch(exec, root))
    UI.println(`Committed on ${branch ?? "HEAD"}`)
  }),
})

const GhPushCommand = effectCmd({
  command: "push",
  describe: "push the current branch and set its upstream",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("remote", {
        type: "string",
        default: "origin",
        describe: "remote to push to",
      })
      .option("force-with-lease", {
        type: "boolean",
        default: false,
        describe: "overwrite the remote branch only if it has not moved since you fetched",
      }),
  handler: Effect.fn("Cli.gh.push")(function* (args) {
    const root = yield* requireRepo(process.cwd())
    const branch = yield* Effect.promise(() => currentBranch(exec, root))
    if (!branch) return yield* fail("HEAD is detached. Switch to a branch before pushing.")
    yield* runOrFail(
      pushArgs(branch, { remote: args.remote, forceWithLease: args["force-with-lease"] }),
      root,
      `Could not push '${branch}' to ${args.remote}`,
    )
    UI.println(`Pushed '${branch}' to ${args.remote}`)
  }),
})

const GhPrCreateCommand = effectCmd({
  command: "create",
  describe: "open a pull request for the current branch",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("title", { type: "string", describe: "pull request title", demandOption: true })
      .option("body", { type: "string", default: "", describe: "pull request body" })
      .option("base", { type: "string", describe: "branch to merge into (defaults to the repository default)" })
      .option("draft", { type: "boolean", default: false, describe: "open as a draft" }),
  handler: Effect.fn("Cli.gh.pr.create")(function* (args) {
    const root = yield* requireRepo(process.cwd())
    yield* requireGh(root)
    const out = yield* runOrFail(
      prCreateArgs({ title: args.title, body: args.body, base: args.base, draft: args.draft }),
      root,
      "Could not open the pull request",
    )
    const url = parsePrUrl(out.stdout) ?? parsePrUrl(out.stderr)
    UI.println(url ? `Opened pull request: ${url}` : "Opened pull request")
  }),
})

const GhPrCommentCommand = effectCmd({
  command: "comment <number>",
  describe: "comment on a pull request",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("number", { type: "number", describe: "pull request number", demandOption: true })
      .option("body", { type: "string", describe: "comment body", demandOption: true }),
  handler: Effect.fn("Cli.gh.pr.comment")(function* (args) {
    const root = yield* requireRepo(process.cwd())
    yield* requireGh(root)
    yield* runOrFail(
      prCommentArgs(args.number, args.body),
      root,
      `Could not comment on pull request #${args.number}`,
    )
    UI.println(`Commented on pull request #${args.number}`)
  }),
})

const GhPrCommand = cmd({
  command: "pr",
  describe: "open and comment on pull requests",
  builder: (yargs) => yargs.command(GhPrCreateCommand).command(GhPrCommentCommand).demandCommand(),
  async handler() {},
})

const GhIssueListCommand = effectCmd({
  command: "list",
  describe: "list issues",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("limit", { type: "number", default: 20, describe: "how many issues to list" })
      .option("state", { type: "string", choices: ["open", "closed", "all"], describe: "filter by state" }),
  handler: Effect.fn("Cli.gh.issue.list")(function* (args) {
    const root = yield* requireRepo(process.cwd())
    yield* requireGh(root)
    const out = yield* runOrFail(issueListArgs({ limit: args.limit, state: args.state }), root, "Could not list issues")
    const issues = parseIssueList(out.stdout)
    if (issues.length === 0) {
      UI.println("No issues found.")
      return
    }
    for (const issue of issues) UI.println(formatIssueLine(issue))
  }),
})

const GhIssueViewCommand = effectCmd({
  command: "view <number>",
  describe: "read an issue and its comments",
  instance: false,
  builder: (yargs) =>
    yargs.positional("number", { type: "number", describe: "issue number", demandOption: true }),
  handler: Effect.fn("Cli.gh.issue.view")(function* (args) {
    const root = yield* requireRepo(process.cwd())
    yield* requireGh(root)
    const out = yield* runOrFail(issueViewArgs(args.number), root, `Could not read issue #${args.number}`)
    const issue = parseIssueDetail(out.stdout)
    if (!issue) return yield* fail(`Could not read issue #${args.number}: unexpected output from gh.`)
    UI.println(`#${issue.number}  ${issue.title}`)
    UI.println(
      [issue.state.toLowerCase(), issue.author ? `by ${issue.author}` : undefined, ...issue.labels]
        .filter((part): part is string => Boolean(part))
        .join(", "),
    )
    if (issue.url) UI.println(issue.url)
    if (issue.body.trim()) {
      UI.println()
      UI.println(issue.body.trim())
    }
    for (const comment of issue.comments) {
      UI.println()
      UI.println(`--- ${comment.author ?? "comment"} ---`)
      UI.println(comment.body.trim())
    }
  }),
})

const GhIssueCommentCommand = effectCmd({
  command: "comment <number>",
  describe: "comment on an issue",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("number", { type: "number", describe: "issue number", demandOption: true })
      .option("body", { type: "string", describe: "comment body", demandOption: true }),
  handler: Effect.fn("Cli.gh.issue.comment")(function* (args) {
    const root = yield* requireRepo(process.cwd())
    yield* requireGh(root)
    yield* runOrFail(issueCommentArgs(args.number, args.body), root, `Could not comment on issue #${args.number}`)
    UI.println(`Commented on issue #${args.number}`)
  }),
})

const GhIssueCommand = cmd({
  command: "issue",
  describe: "read and comment on issues",
  builder: (yargs) =>
    yargs.command(GhIssueListCommand).command(GhIssueViewCommand).command(GhIssueCommentCommand).demandCommand(),
  async handler() {},
})

export const GhCommand = cmd({
  command: "gh",
  describe: "work with GitHub through your own git and gh",
  builder: (yargs) =>
    yargs
      .command(GhStatusCommand)
      .command(GhBranchCommand)
      .command(GhCommitCommand)
      .command(GhPushCommand)
      .command(GhPrCommand)
      .command(GhIssueCommand)
      .demandCommand(),
  async handler() {},
})
