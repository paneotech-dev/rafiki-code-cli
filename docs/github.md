# GitHub from the command line

`rafikicode gh` creates branches, commits, pushes, opens pull requests, and reads and comments on issues.

It stores no GitHub credential. Every command shells out to the `git` and `gh` binaries already on your machine and uses the GitHub account `gh` is logged in to. Nothing is written to `~/.rafikicode`, so there is no GitHub token here to leak, expire or rotate. Revoking access is done in one place, with `gh auth logout`.

## Setup

1. Install the GitHub CLI from [cli.github.com](https://cli.github.com).
2. Log it in once:

   ```bash
   gh auth login
   ```

3. Check what `rafikicode` sees:

   ```bash
   rafikicode gh status
   ```

   It prints the repository, the branch, and the GitHub account `gh` is logged in as. If `gh` is missing or logged out, every other `gh` subcommand stops with the same message and names the command that fixes it.

## Commands

Run them from inside a git repository. Each one reports what it did, or stops with the first line of output from `git` or `gh`.

| command | what it does |
|---|---|
| `rafikicode gh status` | the repository, the branch, and whether `gh` is logged in |
| `rafikicode gh branch <name>` | switches to `<name>`, creating it when it does not exist yet |
| `rafikicode gh commit -m "<message>"` | stages every change and commits |
| `rafikicode gh push` | pushes the current branch and sets its upstream |
| `rafikicode gh pr create --title "<title>" --body "<body>"` | opens a pull request for the current branch |
| `rafikicode gh pr comment <number> --body "<text>"` | comments on a pull request |
| `rafikicode gh issue list` | lists issues, one per line |
| `rafikicode gh issue view <number>` | prints an issue and its comments |
| `rafikicode gh issue comment <number> --body "<text>"` | comments on an issue |

A worked sequence:

```bash
rafikicode gh branch fix/login-redirect
rafikicode gh commit -m "fix: send the login redirect to the requested page"
rafikicode gh push
rafikicode gh pr create --title "Fix the login redirect" --body "Closes #42"
```

## Options worth knowing

- `gh commit --no-stage` commits only what you have already staged, instead of staging the whole work tree.
- `gh push --remote <name>` pushes somewhere other than `origin`.
- `gh push --force-with-lease` overwrites the remote branch only if nobody else has pushed to it since you last fetched. There is no plain `--force`.
- `gh pr create --base <branch>` picks the branch to merge into, and `--draft` opens the pull request as a draft.
- `gh issue list --state open|closed|all` and `--limit <n>` narrow the list.

## Reading the messages

| message | what to do |
|---|---|
| `The GitHub CLI (gh) was not found on your PATH.` | install `gh`, then run `gh auth login` |
| `The GitHub CLI (gh) is installed but not logged in.` | run `gh auth login` |
| `Could not find a git repository here.` | run the command from inside a git repository |
| `Nothing to commit: the work tree is clean.` | there is nothing staged or changed to commit |
| `HEAD is detached. Switch to a branch before pushing.` | run `rafikicode gh branch <name>` first |

Titles, bodies and commit messages are passed to `git` and `gh` as single arguments without a shell, so quotes, newlines and shell punctuation in them are text and never run as commands.

## Related

- [Pull request review](./review-recipe.md) reviews a diff and can post the review as a comment.
- [GitHub Action: review every pull request](./github-action.md) runs `rafikicode` on each pull request in CI.
