# Plan: five small defects on the integration line

Branch `feature/cli-small-fixes`, based on `review/cli-integration-2026-10-02`
at `32fad9d169`. Written before any code was edited. One commit per defect,
each verified on this line before it is changed; a defect that is not present
here is reported with the evidence and left alone.

## 1. A terminal that reports 0 columns by 0 rows is refused

Found by the install matrix (see [install-channels.md](./install-channels.md)):
`docker run -t` with no terminal on the client side gives the container a
terminal whose size is 0 by 0, and since 0.1.8 `Startup.terminal()` in
`packages/opencode/src/rafiki/startup.ts` answers "cannot start its full
screen interface in a terminal this size". The same happens under some CI
systems and on a terminal that has just been attached and has no size yet.

A size of 0 on a real terminal means the size is not known. The render
library already draws at 80 by 24 when it is given 0, per dimension, so the
check only has to stop refusing:

- `packages/opencode/src/rafiki/startup.ts`: a dimension reported as 0 or not
  reported is taken as the default (80 columns, 24 rows) before the minimum
  is applied. A terminal that reports a real size below the minimum is still
  refused with the same words, and standard output that is not a terminal is
  still refused with the same words and exit code 7.
- `packages/opencode/test/rafiki/startup.test.ts`: the pure cases (0 by 0,
  one dimension 0, a real small size), and one case that starts the real
  entry point on a terminal opened at 0 by 0 and checks the interface is
  drawn. The existing case for a pipe keeps proving the refusal and its code.
- `install/test-matrix-probe.sh`: the `stty rows 40 cols 120` line was added
  only to get past this refusal. It is removed if the matrix cell that used
  to fail passes without it; otherwise it stays and the reason is recorded.

If the 0 by 0 case turns out to need a change inside the terminal interface
or the render library, this item stops at the diagnosis and the options.

No upstream file is touched.

## 2. An upstream command name in a provider error

`packages/opencode/src/provider/error.ts` tells the user to run
`opencode auth login <your provider URL>` when a gateway or a proxy answers
401 with an HTML page. The command does not exist under that name here. The
line takes the product's command name from the brand module, in the words the
rest of the CLI uses for a missing or expired sign in, and loses its long
dash; the neighbouring 403 line loses its long dash as well. The rest of the
file is read for the same class of text.

Upstream file touched: `packages/opencode/src/provider/error.ts`.
Test: `packages/opencode/test/provider/` or the brand suite, on the message
for an HTML 401.

## 3. No test catches an upstream name in user visible strings

`packages/opencode/test/brand/message-wording.test.ts` reads the string
literals of a fixed list of files. Nothing reads the rest of
`packages/tui/src`, nor the sources of the CLI itself, so a sync can bring in
a string that names the upstream product or one of its commands and every
suite stays green.

- New `packages/opencode/test/brand/upstream-names.test.ts`: every string
  literal, template literal and JSX text under `packages/tui/src`,
  `packages/opencode/src` and `packages/core/src` is checked for the upstream
  name used as a product (capitalised in a sentence, or its website) or as a
  command (the lower case name followed by a subcommand). Identifiers,
  comments, import paths, package names, environment variable names, file
  and directory names that are still read for compatibility are not matches.
- A short allowlist in the test, each entry a file, the text and the reason
  (licence and attribution, text of an upstream provider this build never
  offers, a wire value another program reads).
- The test is proved by mutation: a leak is put back, the test must fail and
  name the line, and the mutation is reverted. A unit case in the test keeps
  proving the scanner on a sample file.

Occurrences that are real leaks and are not on the list of this branch are
named in the summary and allowlisted with that reason, so that the test can
land without widening this branch.

No upstream file is touched.

## 4. The pre-push hook runs the typecheck unbounded

`.husky/pre-push` ends with `bun typecheck`, which starts one compiler per
package at once and has been killed for memory on a 16 GB machine. It becomes
the same typecheck with `--concurrency` taken from `TYPECHECK_CONCURRENCY`,
default 3. The same thirty tasks run; only how many at a time changes.

Upstream file touched: `.husky/pre-push`.
Check: the hook script run by hand in this worktree.

## 5. Docs and help against what `upgrade` does

`upgrade --method` offers `curl`, `npm`, `pnpm`, `bun`, `brew` and `winget`.
Every page under `docs/`, `README.md`, the help snapshots and the translated
`README.*.md` files are read for a statement about update methods that does
not match, and the text is corrected. The translated files are upstream's and
still give the upstream install commands: their install section is replaced
by one line pointing at `docs/install.md`. Nothing is translated.

Upstream files touched: the `README.*.md` files, listed in the commit.

## Checks at the end

1. `bun turbo typecheck --concurrency=3`, `bun lint`, `node docs/check.mjs`.
2. In `packages/opencode`: `test/brand`, `test/rafiki`, `test/cli/help`,
   `test/installation`; the `packages/tui` suite.
3. `install/test-install.sh`, `test-install-shells.sh`, `test-install-url.sh`,
   `test-matrix.sh`, `test-release-gate.sh`.
4. The full `packages/opencode` suite once. Two failures are known and occur
   only as root.
5. A linux-x64 build, started in a container with `-t` and no terminal on the
   client side.

## Results

Run at `be7894f454` on 2 October 2026.

- Typecheck with `--concurrency=3 --force`: 30 of 30 tasks, none cached.
- `node docs/check.mjs`: passed, 27 files.
- Full `packages/opencode` suite: 4256 pass, 22 skip, 2 fail across 305 files.
  The two failures are the known ones that occur only as root: "continues
  loading tui config when legacy source cannot be stripped" and "tool.write,
  throws error when OS denies write access".
- `test/rafiki` in an earlier partial run under load had one failure in the
  cut connection test from the base line; it passed three times when rerun
  alone and passed in the full run above.
- Installer suites: `test-install.sh` 54, `test-install-shells.sh` 10,
  `test-install-url.sh` 54, `test-release-gate.sh` 16, all passed.
  `test-matrix.sh` was not run as a whole; two of its cells were run by hand
  against a linux-x64 build and all six facets passed on a 0 by 0 terminal.
- `bun lint`: one error, in `packages/session-ui`, a file this branch does not
  touch.

Not done here: the existing upstream names recorded in the brand test's known
list, and the rest of the translated README files.
