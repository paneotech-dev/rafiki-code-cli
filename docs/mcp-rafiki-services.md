# MCP: connecting rafikicode to n8n and Dify

MCP (Model Context Protocol) is the open standard through which a coding agent calls external tools: a server exposes tools, the agent lists them and calls them during a session. `rafikicode` speaks MCP as a client, and both n8n and Dify can expose workflows and apps as MCP servers. This page shows how to point `rafikicode` at them with a Rafiki key, and what to expect.

Read the section "What is confirmed" before copying anything: the configuration format below is verified in this repository, the n8n and Dify sides are examples that follow those products' documentation and must be confirmed against your instances.

## Configuration format

MCP servers live under the `mcp` key of a configuration file: the global `~/.rafikicode/config.json` for servers you want in every project, or the project configuration file at the repository root (its name is given in [Configuration](./configuration.md)) for servers the whole team shares. Two kinds exist:

```json
{
  "mcp": {
    "my-remote": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer {env:MY_TOKEN}" },
      "oauth": false,
      "enabled": true,
      "timeout": 15000
    },
    "my-local": {
      "type": "local",
      "command": ["node", "./tools/mcp-server.js"],
      "environment": { "MY_TOKEN": "{env:MY_TOKEN}" },
      "enabled": true
    }
  }
}
```

Field by field:

| field | kind | meaning |
|---|---|---|
| `type` | both | `remote` (an HTTP endpoint) or `local` (a process started on your machine) |
| `url` | remote | the MCP endpoint |
| `headers` | remote | HTTP headers sent with every request; put the bearer token here |
| `oauth` | remote | `false` to send only the headers; omit it to let the CLI negotiate OAuth with servers that support it |
| `command` | local | the program and its arguments |
| `environment` | local | environment variables for the process |
| `enabled` | both | `false` keeps the entry but does not start it |
| `timeout` | both | request timeout in milliseconds, default 5000; raise it for workflows that take a while |

`{env:NAME}` is replaced with the value of the environment variable when the file is read, and `{file:path}` with the contents of a file, so tokens never sit in the configuration file. Keep the file readable by your user only when it holds anything sensitive.

The CLI also adds entries for you:

```bash
rafikicode mcp add n8n --url https://n8n.example.com/mcp/my-workflow --header "Authorization=Bearer {env:N8N_MCP_TOKEN}"
rafikicode mcp list
```

With a name and `--url`, `mcp add` writes the entry without prompting and prints the file it wrote to; run it with no arguments for the interactive form, which asks whether the server belongs to the current project or to your global configuration. `mcp list` shows whether each server connects. `rafikicode mcp --help` lists the rest (`auth`, `logout`, `debug` for OAuth servers).

## Which key to use

Two different keys are involved, and it helps to keep them apart:

- The Rafiki key (`RAFIKICODE_API_KEY` or the one from `rafikicode login`) authenticates `rafikicode` to the Rafiki gateway for model calls. It is never sent to an MCP server unless you put it in that server's headers yourself.
- An MCP server has its own credential: the bearer token n8n or Dify shows you when you enable their MCP endpoint.

If your n8n or Dify instance is run by Rafiki for you and you want a single credential, configure their MCP endpoint to accept your Rafiki key as the bearer token (both products let you choose the expected token) and reference it as `{env:RAFIKICODE_API_KEY}` in the headers. Otherwise use the token the service generated and keep the two apart. In both cases the value comes from the environment, not from the file.

## n8n

n8n exposes a workflow as an MCP server through its MCP Server Trigger node: add the node to a workflow, connect the tools you want to expose (other nodes, or sub workflows), choose an authentication method (bearer token or header) and activate the workflow. The node shows the endpoint URL, of the form `https://<your-n8n-host>/mcp/<path>`. Names and screens follow the current n8n documentation; confirm them in your version.

Entry for `rafikicode`:

```json
{
  "mcp": {
    "n8n": {
      "type": "remote",
      "url": "https://n8n.example.com/mcp/rafiki-tools",
      "headers": { "Authorization": "Bearer {env:N8N_MCP_TOKEN}" },
      "oauth": false,
      "timeout": 30000
    }
  }
}
```

Export `N8N_MCP_TOKEN` in the shell that runs `rafikicode`, run `rafikicode mcp list`, and the workflow's tools appear in the session. A tool call from the agent runs the workflow and returns what it produces; long workflows need a higher `timeout`.

n8n webhooks (the Webhook node) are not MCP: they are plain HTTP endpoints. To let the agent call one, either wrap it in a workflow behind the MCP Server Trigger as above, or let the agent use the shell tool with `curl` and tell it the URL and the header in `AGENTS.md`; the second option gives the agent no tool description and works best for one or two well named endpoints.

## Dify

Dify can publish an application (an agent, a workflow or a chatflow) as an MCP server from the application's publishing options; it shows a server URL and lets you set the token clients must present. Names and screens follow the current Dify documentation; confirm them in your version.

Entry for `rafikicode`:

```json
{
  "mcp": {
    "dify-support-kb": {
      "type": "remote",
      "url": "https://dify.example.com/mcp/server/<server-id>/mcp",
      "headers": { "Authorization": "Bearer {env:DIFY_MCP_TOKEN}" },
      "oauth": false,
      "timeout": 30000
    }
  }
}
```

A Dify knowledge base that answers questions about your product, exposed this way, becomes a tool the agent can consult while coding ("ask the support knowledge base how refunds work") without leaving the terminal.

## Sharing with a team

Put the entries in the project configuration file and the token names in the project's `AGENTS.md` or README ("export `N8N_MCP_TOKEN` from the team vault before starting"). Everyone then gets the same tools, and nobody commits a token.

## What is confirmed

Confirmed in this repository:

- The `mcp` configuration format above (`remote` with `url`, `headers`, `oauth`, `enabled`, `timeout`; `local` with `command`, `environment`, `enabled`, `timeout`) is the schema the CLI validates.
- `{env:NAME}` and `{file:path}` substitution in configuration files.
- `rafikicode mcp add --url ... --header KEY=VALUE`, `rafikicode mcp list`, and the OAuth subcommands, as shown by `rafikicode mcp --help`.

Examples, not verified against live instances here:

- The n8n MCP Server Trigger endpoint shape and its bearer authentication.
- The Dify MCP server URL shape and token.
- Accepting the Rafiki key as the bearer token on the n8n or Dify side.

When you confirm one of these against your instance, note the exact URL shape and the version in your project's documentation so the next person does not have to rediscover it.
