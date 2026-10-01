# GitHub Action: review every pull request

This recipe adds one workflow file to your repository. On each pull request it runs `rafikicode` headless (with no person at a terminal), asks it to review the diff on `rafiki-fast`, and posts the review as a pull request comment. The spend goes to a Rafiki AI key stored as a repository secret, so every review is visible and capped in the Rafiki AI console.

Two ways to get there:

- **One file to copy**: [examples/rafikicode-pr-review.yml](./examples/rafikicode-pr-review.yml), described on this page. Everything the job does is readable in that file.
- **The packaged action** in this repository, with more inputs (custom prompt, tier, comment header, review file only). See [Pull request review](./review-recipe.md#in-ci-with-the-github-action).

Both do the same work and need the same secret and variables.

## Setup

1. **Create a key.** In the Rafiki AI console at [console.rafikiai.io/keys](https://console.rafikiai.io/keys), create a key and tick the Rafiki Code option. Name it after the repository and give it a monthly budget you are happy to spend on reviews. A key never spends more than its budget or than the credits in your Rafiki AI account.
2. **Store it as a secret.** In the repository, open Settings, Secrets and variables, Actions, and add the secret `RAFIKICODE_API_KEY` with the key as its value.
3. **Pin a release.** On the same page, under Variables, add:

   | variable | value |
   |---|---|
   | `RAFIKICODE_VERSION` | a release number, for example `0.1.4` |
   | `RAFIKICODE_SHA256` | the line for `rafikicode-linux-x64.tar.gz` from that release's `SHA256SUMS` file |

   Get the line with:

   ```bash
   curl -fsSL https://github.com/paneotech-dev/rafiki-code-cli/releases/download/v0.1.4/SHA256SUMS | grep ' rafikicode-linux-x64.tar.gz$'
   ```

   The job downloads exactly that archive and stops if its hash differs, so a changed release file can never run in your pipeline. Update both variables together when you move to a new release.
4. **Add the workflow.** Copy [examples/rafikicode-pr-review.yml](./examples/rafikicode-pr-review.yml) to `.github/workflows/rafikicode-pr-review.yml` in your repository and commit it.

The next pull request from a branch of the repository gets a comment headed "Rafiki Code review".

## What the job does

| step | what happens |
|---|---|
| Check out the base branch | the target branch, not the pull request's code, with `persist-credentials: false` so the job token is not written into `.git/config` |
| Install rafikicode | downloads the pinned archive from the GitHub release, checks the hash, unpacks it into the runner's temporary folder |
| Check the key and the gateway | `rafikicode doctor`: stops the job before any model call if the key is missing, revoked or out of budget, or if the gateway cannot be reached |
| Read the pull request diff | `gh pr diff`, cut at 4000 lines (`MAX_DIFF_LINES`) so one very large pull request cannot use up the budget |
| Review the change | `rafikicode run` on `rafiki-fast` with a review prompt; the diff is read from standard input and appended to the prompt |
| Post the review | `gh pr comment` with the review, or a one line explanation when the review could not run; the check turns red in that case |

The core of the job is one command, which you can also run on your own machine to see what a review looks like before enabling the workflow:

```bash
git diff main...my-branch | \
  OPENCODE_PERMISSION='{"edit":"deny","bash":"deny","webfetch":"deny"}' \
  rafikicode run --model rafiki/rafiki-fast "Review this diff: summary, bugs and risks with file and line, suggestions."
```

## Settings you may want to change

All in the workflow file:

| setting | where | default |
|---|---|---|
| tier | `MODEL` under the job's `env` | `rafiki/rafiki-fast`; `rafiki/rafiki-pro` costs four times as much and suits large or subtle changes |
| diff limit | `MAX_DIFF_LINES` under the job's `env` | `4000` |
| review instructions | the `prompt=` line of the review step | summary, bugs and risks, suggestions |
| when it runs | `on.pull_request.types` | opened, new commits, reopened, marked ready; draft pull requests are skipped |
| runner | `runs-on` | `ubuntu-latest`; on an ARM runner use `rafikicode-linux-arm64.tar.gz` and its hash |

## Exit codes and what the comment says

The review step uses the exit codes of `rafikicode run` (see [Headless and CI](./headless-and-ci.md#exit-codes)):

| code | meaning | comment posted |
|---|---|---|
| 0 | review done | the review |
| 2 | key refused (revoked, expired, or not allowed on the tier) | "the Rafiki AI key was refused" |
| 3 | key budget or account credits spent, nothing charged | "the key's budget or the account's credits are spent" |
| 4 | gateway unreachable | "the Rafiki AI gateway could not be reached" |
| other | the run failed | "did not complete", see the workflow log |

The check is red for every code except 0. Merges are blocked only if you make this check required in your branch protection rules.

## Security

- **Forks.** GitHub does not give secrets to workflows started by pull requests from forks, so the job skips them. Review those with the local command above.
- **Do not use `pull_request_target`** with a checkout of the pull request head: that combination runs code from the pull request with the repository's write token and secrets.
- **The reviewer only reads.** `OPENCODE_PERMISSION` denies file edits, shell commands, web fetches and reads inside `.git`. The checkout is not trusted, so project plugins, custom tools and local MCP servers from the repository are not loaded (see [workspace trust](security/workspace-trust.md)).
- **Prompt injection.** Text inside a pull request can try to steer the review. Treat the comment as one reviewer's opinion, not as an approval.
- **The key stays secret.** GitHub masks secrets in logs, and `rafikicode doctor` prints the key's name and spend, never its value.

## Cost

A review sends the diff plus the prompt once and reads the answer. In our test (below) an 18 line diff took two model steps on `rafiki-fast` (the reviewer also opened the changed file) and about 12,000 tokens in all, of which about 10,500 were the agent's standing instructions read back from the gateway's prompt cache. Those instructions are the same for every review, so the part that grows with the pull request is the diff itself. Watch the key's page in the Rafiki AI console for the first weeks and set the budget from what you see. When the budget runs out, reviews stop with a comment saying so.

## What was tested

With release 0.1.1, on Linux:

- The workflow file passes `actionlint` 1.7.7.
- Its shell steps were run in order outside GitHub, with the GitHub CLI replaced by a stand in that served the diff of a scratch repository and captured the comment: the archive hash check passed, the diff was read, `rafikicode run` on `rafiki-fast` returned a review that found both deliberate bugs with file and line, and the comment was written with the heading and footer.
- The core command above, run as written with `--format json` added, returned a review with both bugs.
- `rafikicode doctor` stopped the job as designed with a test key that was not created in the Rafiki AI console (`FAIL console ... does not know this key`). A key created at console.rafikiai.io/keys with the Rafiki Code option passes that line. That one case has since become a warning rather than a failure: a key the gateway accepts but the Rafiki AI console does not know gives `WARN  console ... does not know this key (401)`, `doctor` exits 0 and the job carries on, because such runs do work and are metered at the gateway. A missing, revoked or expired key, a spent budget and an unreachable gateway still fail, and still stop the job before any model call.

These checks ran outside GitHub: the run on GitHub's hosted runners, a real comment, the fork skip and the error comments for codes 2, 3 and 4 follow from the workflow file and GitHub's documented behaviour.
