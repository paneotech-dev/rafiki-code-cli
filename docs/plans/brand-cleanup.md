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
