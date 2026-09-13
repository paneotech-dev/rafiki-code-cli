# Pull request review

`rafikicode` reviews a change the same way it does anything else: you hand it a diff and instructions, it answers. This page gives a recipe for reviewing a pull request from your terminal and one for reviewing every pull request in CI with the bundled GitHub Action. Both spend from a Rafiki Console key, so the cost of a review is visible per key in the Console.

## What a review costs

A review sends the diff plus a short instruction to the model once and reads the answer. On `rafiki-fast` a typical change of a few hundred lines costs a fraction of a credit; `rafiki-pro` costs four times as much per token and is worth it for large or subtle changes. Whatever the tier, cap the diff (the recipes below do) so one huge pull request cannot spend a whole key's budget in one run.

## Locally

Requirements: a signed in terminal (`rafikicode login`) or `RAFIKICODE_API_KEY` set, and the GitHub CLI `gh` if you want to fetch a pull request by number.

Review the pull request you are looking at:

```bash
gh pr diff 123 | rafikicode run "Review this diff. List bugs and risky changes first, with file and line, then suggestions. Judge only what the diff shows."
```

Review your own uncommitted work before you push:

```bash
git diff | rafikicode run "Review this diff for bugs and anything that would surprise a reviewer."
```

Review a branch against its base:

```bash
git diff main...HEAD | rafikicode run --model rafiki/rafiki-pro "Review this change as a strict senior engineer."
```

How it works: when standard input is not a terminal, `rafikicode run` appends what it reads there to the message you passed as arguments, so the instruction comes first and the diff after it. `--model` picks the tier for this run only. Add `--format json` to get the events as JSON lines instead of formatted text.

If you want to keep the review, redirect it: `... > review.md`. Post it to the pull request with `gh pr comment 123 --body-file review.md`.

Keep an eye on `rafikicode whoami` for the key's spend, and cap large diffs with `head -n 4000` in the pipe when a pull request is big.

## In CI with the GitHub Action

The repository ships a composite action at `.github/actions/rafikicode-review` and an example workflow at `.github/workflows/rafikicode-review.example.yml`. The example is inert until copied: GitHub only runs files named `*.yml` directly under `.github/workflows`, and the example's name ends in `.example.yml`.

Setup, once per repository:

1. In Rafiki Console, create a server key at [console.rafikiai.io/keys](https://console.rafikiai.io/keys). Name it after the repository, choose the tiers the review may use, and give it a budget you are comfortable spending on reviews per month. A key never spends more than its budget or the wallet holds.
2. Store the key as the repository secret `RAFIKICODE_API_KEY`.
3. Copy `.github/workflows/rafikicode-review.example.yml` to `.github/workflows/rafikicode-review.yml` and commit it. When you use the action from another repository, change `uses:` to the published reference, for example `paneotech-dev/rafiki-code-cli/.github/actions/rafikicode-review@v1`.

What the action does on each pull request:

1. Installs `rafikicode` with the one line installer (pin a release with the `version` input; point `installer-url` at a raw `install/install.sh` URL from a release tag if the runner cannot reach `get.rafikiai.io`).
2. Runs `rafikicode doctor` with the key. A revoked key, an empty budget, or an unreachable gateway stops the job here, before any model call.
3. Reads the diff with `gh pr diff` and cuts it at `max-diff-lines` (default 4000).
4. Runs `rafikicode run` headless on the chosen tier with the review prompt and the diff. The reviewer can read the checkout but is denied file edits, shell commands and web fetches through `OPENCODE_PERMISSION`.
5. Posts the review with `gh pr comment` under the `comment-header` line, with a footer naming the tier. Set `post-comment: false` to keep the review as a file only (the `review-file` output).

Inputs, all optional except `api-key`:

| input | default | meaning |
|---|---|---|
| `api-key` | required | the server key, from a secret |
| `model` | `rafiki/rafiki-fast` | tier for the review |
| `pr-number` | the triggering pull request | which pull request to review |
| `version` | latest release | `rafikicode` release to install |
| `installer-url` | `https://get.rafikiai.io` | installer script location |
| `prompt` | built in review prompt | your own instructions; the diff is appended |
| `max-diff-lines` | `4000` | cut the diff here and say so in the comment |
| `post-comment` | `true` | post to the pull request |
| `comment-header` | `## Rafiki Code review` | first line of the comment |
| `working-directory` | the workspace | where the review runs |
| `check-setup` | `true` | run `rafikicode doctor` first and stop on a failed check |
| `github-token` | `github.token` | token for `gh`; needs `pull-requests: write` |

Outputs: `review-file` (path of the review text) and `exit-code`.

Exit codes of the review step follow the CLI's table in [Headless and CI](./headless-and-ci.md#exit-codes): 0 posted, 1 the run failed, 2 the key was refused, 3 the budget or wallet is spent (nothing was charged), 4 the gateway or Console was unreachable, 5 internal error. On 2, 3 and 4 the action posts a one line comment naming the cause, then fails the job so the pull request shows a red check rather than silence.

Budget note: one key budget covers every pull request that uses it. Watch the key's page in the Console for the first weeks, then set the budget from what you see. When the budget runs out, reviews stop with exit code 3 and a comment saying so; merges are not blocked unless you make the check required.

Security notes:

- Secrets are not available to workflows triggered from forks, so the example workflow skips those pull requests. Review fork contributions with the local recipe.
- Keep the trigger on `pull_request` and check out the base branch, as the example does. Do not switch to `pull_request_target` with a checkout of the pull request head: that would run the workflow with write permissions on code from the pull request.
- The review prompt tells the model to judge the diff only. Text inside a pull request can still try to steer the review; treat the comment as a reviewer's opinion, not as a gate.
- The key never appears in the log. `rafikicode doctor` prints numbers and paths only.

## Writing a better review prompt

The built in prompt asks for a summary, bugs and risks with file and line, suggestions, and questions for the author. Replace it through the `prompt` input, or by passing your own text locally, when your project has specific rules: name the conventions from your `AGENTS.md`, ask for a verdict line at the top, or restrict the review to security or performance. Short and specific beats long and general, and the cheaper tiers follow a clear checklist well.
