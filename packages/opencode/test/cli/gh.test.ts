// Tests for the local GitHub capability (src/rafiki/gh.shared.ts).
//
// Every test drives a recorded fake Exec: no `git` or `gh` process is started,
// no repository is touched and nothing reaches github.com. `calls` is the
// argv-array log, so a test asserts the exact command that would have run.
import { test, expect, describe } from "bun:test"
import { Brand } from "@opencode-ai/core/brand/brand"
import {
  branchArgs,
  branchExists,
  bothStreams,
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
  parseGhAccount,
  parseIssueDetail,
  parseIssueList,
  parsePrUrl,
  prCommentArgs,
  prCreateArgs,
  pushArgs,
  stageArgs,
  type Exec,
  type ExecResult,
} from "../../src/rafiki/gh.shared"

const ok = (stdout = "", stderr = ""): ExecResult => ({ code: 0, stdout, stderr })
const nope = (stderr = "", code = 1): ExecResult => ({ code, stdout: "", stderr })

/**
 * A fake Exec that answers by argv prefix. `calls` records every argv array in
 * order, so a test can assert both the outcome and the commands taken to reach it.
 */
function fakeExec(answers: Array<{ match: string[]; result: ExecResult }>) {
  const calls: string[][] = []
  const exec: Exec = async (cmd) => {
    calls.push([...cmd])
    const hit = answers.find((answer) => answer.match.every((part, i) => cmd[i] === part))
    return hit ? hit.result : nope(`unexpected command: ${cmd.join(" ")}`, 127)
  }
  return { exec, calls }
}

describe("argv builders", () => {
  test("branchArgs creates a new branch or switches to an existing one", () => {
    expect(branchArgs("wp/feature", false)).toEqual(["git", "switch", "--create", "wp/feature"])
    expect(branchArgs("wp/feature", true)).toEqual(["git", "switch", "--", "wp/feature"])
  })

  test("stage and commit are separate argv arrays", () => {
    expect(stageArgs()).toEqual(["git", "add", "-A"])
    expect(commitArgs("fix: a thing")).toEqual(["git", "commit", "-m", "fix: a thing"])
  })

  test("a commit message is one argument, however it is punctuated", () => {
    // No shell is involved, so a message with quotes, newlines and a command
    // substitution stays a single argv entry and cannot become a command.
    const message = 'feat: add "quotes"\n\n$(rm -rf /) `whoami` && echo hi'
    const args = commitArgs(message)
    expect(args).toHaveLength(4)
    expect(args[3]).toBe(message)
  })

  test("pushArgs sets the upstream and never uses plain --force", () => {
    expect(pushArgs("wp/feature")).toEqual(["git", "push", "--set-upstream", "origin", "wp/feature"])
    expect(pushArgs("wp/feature", { remote: "fork" })).toEqual([
      "git",
      "push",
      "--set-upstream",
      "fork",
      "wp/feature",
    ])
    const forced = pushArgs("wp/feature", { forceWithLease: true })
    expect(forced).toEqual(["git", "push", "--force-with-lease", "--set-upstream", "origin", "wp/feature"])
    expect(forced).not.toContain("--force")
  })

  test("prCreateArgs passes title and body, and base and draft only when asked", () => {
    expect(prCreateArgs({ title: "T", body: "B" })).toEqual([
      "gh",
      "pr",
      "create",
      "--title",
      "T",
      "--body",
      "B",
    ])
    expect(prCreateArgs({ title: "T", body: "B", base: "main", draft: true })).toEqual([
      "gh",
      "pr",
      "create",
      "--title",
      "T",
      "--body",
      "B",
      "--base",
      "main",
      "--draft",
    ])
  })

  test("comment builders stringify the number", () => {
    expect(prCommentArgs(12, "hello")).toEqual(["gh", "pr", "comment", "12", "--body", "hello"])
    expect(issueCommentArgs(7, "hello")).toEqual(["gh", "issue", "comment", "7", "--body", "hello"])
  })

  test("issue reads ask gh for JSON", () => {
    expect(issueListArgs()).toEqual([
      "gh",
      "issue",
      "list",
      "--json",
      "number,title,state,author,url,labels",
      "--limit",
      "20",
    ])
    expect(issueListArgs({ limit: 5, state: "closed" })).toEqual([
      "gh",
      "issue",
      "list",
      "--json",
      "number,title,state,author,url,labels",
      "--limit",
      "5",
      "--state",
      "closed",
    ])
    expect(issueViewArgs(42)).toEqual([
      "gh",
      "issue",
      "view",
      "42",
      "--json",
      "number,title,state,author,url,body,comments",
    ])
  })
})

describe("gh preflight", () => {
  test("a missing gh binary is reported as missing, not as logged out", async () => {
    const { exec, calls } = fakeExec([{ match: ["gh", "--version"], result: nope("spawn gh ENOENT", 127) }])
    const check = await checkGh(exec)
    expect(check).toEqual({ ok: false, reason: "gh_missing" })
    // auth status is never attempted when the binary is absent.
    expect(calls).toEqual([["gh", "--version"]])
  })

  test("an installed but logged out gh is reported as unauthenticated", async () => {
    const { exec } = fakeExec([
      { match: ["gh", "--version"], result: ok("gh version 2.62.0") },
      { match: ["gh", "auth", "status"], result: nope("You are not logged into any GitHub hosts.") },
    ])
    expect(await checkGh(exec)).toEqual({ ok: false, reason: "gh_unauthenticated" })
  })

  test("an authenticated gh reports the account", async () => {
    const { exec } = fakeExec([
      { match: ["gh", "--version"], result: ok("gh version 2.62.0") },
      { match: ["gh", "auth", "status"], result: ok("✓ Logged in to github.com account octocat (keyring)") },
    ])
    expect(await checkGh(exec)).toEqual({ ok: true, account: "octocat" })
  })

  test("auth status is read from stderr too, as older gh versions write it there", async () => {
    const { exec } = fakeExec([
      { match: ["gh", "--version"], result: ok("gh version 2.20.0") },
      { match: ["gh", "auth", "status"], result: ok("", "✓ Logged in to github.com as octocat (oauth_token)") },
    ])
    expect(await checkGh(exec)).toEqual({ ok: true, account: "octocat" })
  })

  test("an unrecognised status line still counts as authenticated", async () => {
    const { exec } = fakeExec([
      { match: ["gh", "--version"], result: ok("gh version 3.0.0") },
      { match: ["gh", "auth", "status"], result: ok("all good") },
    ])
    expect(await checkGh(exec)).toEqual({ ok: true, account: undefined })
  })

  test("parseGhAccount reads both documented wordings", () => {
    expect(parseGhAccount("✓ Logged in to github.com account my-user (keyring)")).toBe("my-user")
    expect(parseGhAccount("✓ Logged in to github.com as my-user (oauth_token)")).toBe("my-user")
    expect(parseGhAccount("✓ Logged in to github.example.com account my-user")).toBe("my-user")
    expect(parseGhAccount("not a status line")).toBeUndefined()
  })
})

describe("messages", () => {
  test("both gh messages name the command that fixes the problem", () => {
    expect(ghTroubleMessage("gh_missing")).toContain("gh auth login")
    expect(ghTroubleMessage("gh_missing")).toContain("https://cli.github.com")
    expect(ghTroubleMessage("gh_unauthenticated")).toContain("gh auth login")
  })

  test("messages say rafikicode and never the upstream project name", () => {
    const texts = [ghTroubleMessage("gh_missing"), ghTroubleMessage("gh_unauthenticated"), notARepoMessage()]
    expect(Brand.name).toBe("rafikicode")
    expect(texts.filter((text) => text.includes(Brand.name))).toHaveLength(2)
    for (const text of texts) expect(text.toLowerCase()).not.toContain("opencode")
  })

  test("the messages promise no stored credential", () => {
    expect(ghTroubleMessage("gh_unauthenticated")).toContain("stores no credential")
  })

  test("failureDetail surfaces the first useful output line", () => {
    expect(failureDetail(nope("fatal: a branch named 'x' already exists"))).toBe(
      "fatal: a branch named 'x' already exists",
    )
    expect(failureDetail({ code: 2, stdout: "", stderr: "" })).toBe("exited with code 2")
    expect(bothStreams(ok("out", "err"))).toBe("out\nerr")
  })
})

describe("repository probes", () => {
  test("gitRoot returns the top level, trimmed", async () => {
    const { exec } = fakeExec([{ match: ["git", "rev-parse", "--show-toplevel"], result: ok("/repo\n") }])
    expect(await gitRoot(exec, "/repo/sub")).toBe("/repo")
  })

  test("gitRoot returns undefined outside a repository", async () => {
    const { exec } = fakeExec([
      { match: ["git", "rev-parse", "--show-toplevel"], result: nope("fatal: not a git repository") },
    ])
    expect(await gitRoot(exec, "/tmp")).toBeUndefined()
  })

  test("currentBranch names the branch, including one with no commits yet", async () => {
    const attached = fakeExec([{ match: ["git", "branch", "--show-current"], result: ok("wp/feature\n") }])
    expect(await currentBranch(attached.exec, "/repo")).toBe("wp/feature")
    // A repository with no commits: the branch exists and is named, unlike
    // `rev-parse --abbrev-ref HEAD`, which fails there.
    const unborn = fakeExec([{ match: ["git", "branch", "--show-current"], result: ok("main\n") }])
    expect(await currentBranch(unborn.exec, "/repo")).toBe("main")
  })

  test("currentBranch returns undefined on a detached HEAD", async () => {
    // `branch --show-current` prints an empty line when HEAD is detached.
    const detached = fakeExec([{ match: ["git", "branch", "--show-current"], result: ok("\n") }])
    expect(await currentBranch(detached.exec, "/repo")).toBeUndefined()
    const outside = fakeExec([{ match: ["git", "branch"], result: nope("fatal: not a git repository") }])
    expect(await currentBranch(outside.exec, "/tmp")).toBeUndefined()
  })

  test("branchExists asks git for the ref without printing to the terminal", async () => {
    const { exec, calls } = fakeExec([
      { match: ["git", "rev-parse", "--verify", "--quiet", "refs/heads/wp/feature"], result: ok("abc123\n") },
    ])
    expect(await branchExists(exec, "/repo", "wp/feature")).toBe(true)
    expect(calls[0]).toEqual(["git", "rev-parse", "--verify", "--quiet", "refs/heads/wp/feature"])
    const missing = fakeExec([{ match: ["git", "rev-parse"], result: nope("", 1) }])
    expect(await branchExists(missing.exec, "/repo", "nope")).toBe(false)
  })

  test("hasChanges is false for a clean work tree", async () => {
    const clean = fakeExec([{ match: ["git", "status", "--porcelain"], result: ok("") }])
    expect(await hasChanges(clean.exec, "/repo")).toBe(false)
    const dirty = fakeExec([{ match: ["git", "status", "--porcelain"], result: ok(" M src/a.ts\n?? src/b.ts\n") }])
    expect(await hasChanges(dirty.exec, "/repo")).toBe(true)
  })
})

describe("reading gh output", () => {
  test("parseIssueList reads numbers, state, author and labels", () => {
    const json = JSON.stringify([
      {
        number: 12,
        title: "Crash on start",
        state: "OPEN",
        author: { login: "octocat" },
        url: "https://github.com/o/r/issues/12",
        labels: [{ name: "bug" }, { name: "p1" }],
      },
      { number: 13, title: "Docs", state: "CLOSED", author: null, labels: [] },
    ])
    const issues = parseIssueList(json)
    expect(issues).toHaveLength(2)
    expect(issues[0]).toEqual({
      number: 12,
      title: "Crash on start",
      state: "OPEN",
      author: "octocat",
      url: "https://github.com/o/r/issues/12",
      labels: ["bug", "p1"],
    })
    expect(issues[1].author).toBeUndefined()
    expect(issues[1].labels).toEqual([])
  })

  test("parseIssueList returns an empty list for anything unparseable", () => {
    expect(parseIssueList("not json")).toEqual([])
    expect(parseIssueList("{}")).toEqual([])
    expect(parseIssueList("")).toEqual([])
  })

  test("parseIssueDetail reads the body and the comments in order", () => {
    const json = JSON.stringify({
      number: 12,
      title: "Crash on start",
      state: "OPEN",
      author: { login: "octocat" },
      url: "https://github.com/o/r/issues/12",
      body: "It crashes.",
      comments: [
        { author: { login: "alice" }, body: "Reproduced." },
        { author: null, body: "Fixed in main." },
      ],
    })
    const issue = parseIssueDetail(json)
    expect(issue?.number).toBe(12)
    expect(issue?.body).toBe("It crashes.")
    expect(issue?.comments).toEqual([
      { author: "alice", body: "Reproduced." },
      { author: undefined, body: "Fixed in main." },
    ])
  })

  test("parseIssueDetail tolerates missing comments and bad JSON", () => {
    expect(parseIssueDetail(JSON.stringify({ number: 1, title: "t", state: "OPEN" }))?.comments).toEqual([])
    expect(parseIssueDetail("not json")).toBeUndefined()
    expect(parseIssueDetail("[]")).toBeUndefined()
  })

  test("parsePrUrl finds the pull request URL gh prints", () => {
    expect(parsePrUrl("https://github.com/owner/repo/pull/42\n")).toBe("https://github.com/owner/repo/pull/42")
    expect(parsePrUrl("Creating pull request...\nhttps://github.example.com/o/r/pull/7")).toBe(
      "https://github.example.com/o/r/pull/7",
    )
    expect(parsePrUrl("no url here")).toBeUndefined()
  })

  test("formatIssueLine is one readable line per issue", () => {
    expect(
      formatIssueLine({ number: 12, title: "Crash", state: "OPEN", author: "octocat", labels: ["bug"] }),
    ).toBe("#12  Crash  (open, by octocat, bug)")
    expect(formatIssueLine({ number: 13, title: "Docs", state: "", labels: [] })).toBe("#13  Docs")
  })
})

describe("no credential is ever handled", () => {
  test("no argv built here carries a token, and every gh call is the gh binary", () => {
    const argvs = [
      branchArgs("b", false),
      stageArgs(),
      commitArgs("m"),
      pushArgs("b"),
      prCreateArgs({ title: "t", body: "b" }),
      prCommentArgs(1, "c"),
      issueListArgs(),
      issueViewArgs(1),
      issueCommentArgs(1, "c"),
    ]
    for (const argv of argvs) {
      expect(["git", "gh"]).toContain(argv[0])
      for (const part of argv) {
        expect(part).not.toContain("--token")
        expect(part).not.toContain("Authorization")
        expect(part).not.toMatch(/gh[pousr]_/)
      }
    }
  })
})
