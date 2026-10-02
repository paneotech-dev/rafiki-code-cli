# Plan: the upstream name in text a user can read

Branch `feature/brand-cleanup`, based on `feature/cli-small-fixes` at
`29cbfec49f`. Written before any code was edited. It follows item 3 of
[small-fixes.md](./small-fixes.md), which landed the test that finds the
upstream name in user visible strings and recorded what was already there on a
`known` list. This branch goes through that list, entry by entry.

## The rule for each entry

- Text of this product that a user reads (a page, a message, a consent
  screen, a description in a published document): fixed, in the words of the
  brand module.
- A value another program depends on (a header an upstream provider expects,
  the address of an upstream service, a wire value, a config key, an
  environment variable, a package name, a file path): left as it is and moved
  to the `allowed` list with one line that says why.
- Text that only a provider or a command this build never offers can show:
  left as it is, on the `allowed` list, with the reason and the test that
  proves the provider or the command is not offered. Rewording it would touch
  an upstream file for a string nobody can reach.
- Not sure: left as it is, kept on the `known` list, and asked as a question
  in the results below.

No config key, environment variable, directory, package name or wire
identifier is renamed.

## 1. The known list

What is expected for each entry; the results section records what was done.

| entry | expected |
|---|---|
| `packages/core/src/oauth/page.ts` | fix: the browser page after a provider or MCP sign in names the product from the brand module, and the drawn upstream wordmark becomes the product name as text |
| `packages/opencode/src/mcp/oauth-provider.ts` | fix: the client name and address an MCP server shows on its consent screen come from the brand module |
| `packages/opencode/src/server/routes/instance/httpapi/` | fix where it is read: the descriptions, summaries and title of the OpenAPI document the local server publishes at `/doc` are rewritten in one place, the way descriptions of the config schema already are; the source strings stay, so fifteen upstream files are not edited |
| `packages/core/src/v1/config/config.ts` | allow: `packages/opencode/script/schema.ts` already rewrites these descriptions in the published schema; a test is added that the committed schema files carry no upstream name |
| `packages/opencode/src/cli/cmd/github.handler.ts` | check that the upstream GitHub agent is not a command of this build; if so, allow |
| `packages/opencode/src/cli/cmd/providers.ts`, `plugin/digitalocean.ts`, `plugin/snowflake-cortex.ts`, `provider/provider.ts`, `session/retry.ts` | headers and addresses are wire values; the prompts and errors belong to providers this build does not offer; allow with those reasons |
| `packages/opencode/src/cli/cmd/account.ts`, `server/shared/ui.ts` | addresses of upstream services; left, and raised as questions if the code path can be reached |

## 2. The SDK

`packages/sdk/js/src` joins the directories the test reads. Error text the
terminal interface can show is fixed; a line the SDK waits for on the output
of a server process is a wire value and is left.

## 3. `install/test-matrix-probe.sh` always prints `tty: no`

The check for standard output runs inside a command substitution, where
standard output is a pipe. The two checks move out of the substitution. The
output before and after is recorded below.

## 4. The one lint error

`bun lint` reports an octal escape in
`packages/session-ui/src/v2/components/prompt-input/index.tsx`. The file is
compared with the base and with upstream; it is fixed only if the line is
ours.

## Upstream files

Every upstream file edited is listed in the results, with the number of lines
changed. New code goes to the brand module and to the test.

## Checks at the end

1. `bun turbo typecheck --concurrency=3`, `node docs/check.mjs`.
2. In `packages/opencode`: `test/brand`, `test/cli/help`; the `packages/tui`
   suite; the test of the OAuth page in `packages/core`.
3. The full `packages/opencode` suite once. Two failures are known and occur
   only as root.

## Results

Run at `49dcbbb93b` on 2 October 2026.

### The list, entry by entry

82 occurrences were read: the 78 on the `known` list and 4 found in
`packages/sdk/js/src`.

Fixed in the source, 12 occurrences:

| file | what changed |
|---|---|
| `packages/core/src/oauth/page.ts` (8) | the title, the messages and the footnote of the browser page take the product name from the brand module, in the page and in the script that finishes a sign in inside the browser; the drawn upstream wordmark is replaced by the product name as text |
| `packages/opencode/src/mcp/oauth-provider.ts` (2) | `client_name` and `client_uri` of the OAuth registration are the product name and its homepage. A server that is already signed in keeps the client id it was given, so nothing registers again |
| `packages/sdk/js/src/error-interceptor.ts` (1), `packages/sdk/js/src/v2/client.ts` (1) | an empty answer and an answer in HTML are reported as coming from "the server" |

Allowed with a reason, 66 occurrences:

| entry | reason |
|---|---|
| `packages/opencode/src/server/routes/instance/httpapi/` (37) | fixed where it is read: `Brand.document()` rewrites the title, every description and every summary of the OpenAPI document the server publishes at `/doc`. 28 lines of that document changed and nothing else; paths, operation ids, tags and schemas are the same. The source strings stay as upstream writes them |
| `packages/core/src/v1/config/config.ts` (3) | `packages/opencode/script/schema.ts` already rewrites these descriptions in the published schema; the test now reads `schema/config.json` and `schema/tui.json` |
| `packages/opencode/src/cli/cmd/github.handler.ts` (10) | the upstream GitHub agent with its workflow file, action, app and API. Its command is not registered: `rafikicode github install --help` prints the general help |
| `packages/opencode/src/provider/provider.ts` (9) | seven are the referer, title and billing headers upstream providers expect; two are errors of providers this build does not offer |
| `packages/opencode/src/cli/cmd/providers.ts` (2), `plugin/digitalocean.ts` (1), `plugin/snowflake-cortex.ts` (1) | sign in prompts of upstream providers, behind a command this build replaces with a notice |
| `packages/opencode/src/session/retry.ts` (3) | the upstream subscription offer, built only from the upstream service's own error bodies |

Left as they are, with a question, 4 occurrences (the `known` list of the
test, which now has four entries):

1. `packages/opencode/src/cli/cmd/account.ts`: `rafikicode console login`
   is a hidden command that is still registered, and with no address it signs
   in to the upstream account service. Is the command to stay in this build?
2. `packages/opencode/src/server/shared/ui.ts`: when the binary carries no
   web interface (a run from source, a build made with
   `--skip-embed-web-ui`, or `OPENCODE_DISABLE_EMBEDDED_WEB_UI`), the server
   fetches the upstream web application from the upstream address. Should it
   refuse instead?
3. `packages/sdk/js/src/server.ts` and `packages/sdk/js/src/v2/server.ts`:
   the server helper of the SDK starts the upstream binary by name and waits
   for the line that binary prints. `rafikicode serve` prints its own name on
   that line, so the helper cannot start this product. Is the helper to
   support it? That is a change of behaviour, not of wording.

Three more things were seen and not changed:

- The tag `opencode HttpApi` groups a few operations in the OpenAPI document.
  A tag is a grouping name a generated client can depend on, so it stays.
- `packages/sdk/openapi.json` and the comments of the generated SDK files
  still carry the upstream descriptions. They are produced by the SDK build,
  which was not run here; the next run rewrites them.
- `packages/cli/src/commands/commands.ts` and two descriptions in
  `packages/protocol/src/groups/session.ts` name the upstream product. The
  two descriptions are covered by the rewrite of the OpenAPI document. The
  first is outside the directories the test reads, and whether that package
  is shipped was not checked.

The test was proved by mutation: an upstream command put into a file of the
SDK, the upstream name put back into the page, and the rewrite of the
document removed each made it fail and name the place; all three were
reverted.

### The probe

Line 49 of `install/test-matrix-probe.sh`, run on a terminal and then with its
output piped:

```text
before, on a terminal:   tty:     no (stdin: yes)
before, piped:           tty:     no (stdin: no)
after, on a terminal:    tty:     yes (stdin: yes)
after, piped:            tty:     no (stdin: no)
```

### The lint error

Not fixed. `packages/session-ui/src/v2/components/prompt-input/index.tsx` is
byte for byte the file of upstream's `dev` branch (the same blob,
`ff4ff0f1d4`), on the base as well, and the line came with upstream's rewrite
of that component. The text `\200B` sits in a JSX attribute, where a backslash
is not an escape: it reaches the stylesheet as written and is the CSS escape
for a zero width space, which is what the class needs. Writing it another way
would change a line of a file this fork does not otherwise touch, for a
package the CLI does not ship. It is for upstream to silence or reword.

### Upstream files touched

| file | lines |
|---|---|
| `packages/core/src/oauth/page.ts` | 11 added, 26 removed |
| `packages/opencode/src/mcp/oauth-provider.ts` | 3 added, 2 removed |
| `packages/opencode/src/server/routes/instance/httpapi/public.ts` | 2 added, 1 removed |
| `packages/sdk/js/src/error-interceptor.ts` | 1 changed |
| `packages/sdk/js/src/v2/client.ts` | 1 changed |

`install/test-matrix-probe.sh`, `packages/core/src/brand/brand.ts` and the
test are this fork's own files.

### Checks

- Typecheck with `--concurrency=3`: 30 of 30 tasks, none cached.
- `node docs/check.mjs`: passed, 28 files.
- `packages/opencode`, `test/brand`: 163 pass, 0 fail across 14 files.
- `packages/opencode`, `test/cli/help`: 1 pass, 45 snapshots, none updated.
  This branch changes no help text. The suite needs a short `TMPDIR`: with a
  long one the default of `--cwd` wraps onto a second line before the path is
  normalised, and one snapshot differs for that reason alone.
- `packages/tui`: 204 pass, 1 skip, 0 fail across 46 files.
- `packages/core`, `test/oauth-page.test.ts`: 1 pass.
- Full `packages/opencode` suite, run twice. The second run: 4261 pass,
  22 skip, 1 todo, 2 fail across 305 files; the two failures are the known
  ones that occur only as root, "continues loading tui config when legacy
  source cannot be stripped" and "tool.write, throws error when OS denies
  write access". The first run, on a busier machine, had two more failures,
  in `test/rafiki/integration-set.test.ts` (the cut connection) and
  `test/cli/acp/spec-compliance.test.ts` (a cancelled turn), files this
  branch does not touch; both files passed three times when rerun alone.
- `bun lint`: one error, the one described above, and no new one.

Not verified: how the sign in page looks in a browser (its text is tested,
its layout was not opened), an OAuth registration against a real MCP server,
and `install/test-matrix.sh` as a whole after the change to the probe (the
changed lines were run on a terminal and through a pipe).
