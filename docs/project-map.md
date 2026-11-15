# Project map

The project map gives the agent a code graph of your project: which function calls which, what a file imports, where a class is defined, and how one name reaches another. The agent asks the map through tools when it needs to, for example before a wide search for "what calls `parse_config`". Nothing is added to the prompt, so the map costs tokens only when a tool is called.

The map is built by [graphify](https://github.com/Graphify-Labs/graphify) (Apache 2.0), a separate program you install yourself. It is off by default.

## Install graphify

graphify needs Python 3.10 or later. Install it with its MCP extra, using one of:

```bash
uv tool install "graphifyy[mcp]"
pipx install "graphifyy[mcp]"
python3 -m pip install --user "graphifyy[mcp]"
```

On Windows, in PowerShell:

```powershell
py -m pip install --user "graphifyy[mcp]"
```

The package name is `graphifyy` (two y). Rafiki AI Code never installs it for you: when the map is on and graphify is missing, `/map` shows the one command for your system.

Rafiki AI Code finds graphify on your `PATH` (`graphify` and `graphify-mcp`, as `uv tool` and `pipx` install them), or else through Python (`python3 -m graphify`, and on Windows the `py` launcher, then `python`).

## Turn it on

For one run:

```bash
RAFIKICODE_MAP=1 rafikicode
```

```powershell
$env:RAFIKICODE_MAP = "1"; rafikicode
```

For good, in `rafikicode.json`:

```json
{
  "map": { "graphify": true }
}
```

`RAFIKICODE_MAP=0` turns it off for a run and wins over the setting.

When the map is on, each session gives the agent four tools. A map from an earlier session is used at once and refreshed in the background (only changed files are read again). In a project with no map yet, the session waits for the first build, for up to 90 seconds; in a large project run `/map` once, which has no time limit.

| Tool | What it answers |
|---|---|
| `graphify_query_graph` | the functions, classes and files related to a question or name, with their calls, imports and `file:line` |
| `graphify_get_neighbors` | every direct link of one name: who calls it, what it calls, where it is defined |
| `graphify_get_node` | the details of one name |
| `graphify_shortest_path` | how one name reaches another, hop by hop |

## The /map command

In the terminal interface:

- `/map` builds or refreshes the map now, shows progress, then the number of code files, names and links and the time it took, and gives the agent the tools for this session. It also turns the map on for the session when it was off. Run it again after large changes.
- `/map off` takes the tools away for the rest of the session.

## Privacy and your files

- graphify runs in code only mode: it reads source files with tree-sitter on your machine. Documents, PDFs and images are skipped.
- Every model backend of graphify is turned off (`GRAPHIFY_BACKEND=none`), its query log is off, and the provider keys in your environment are blanked for its processes. No file content is sent anywhere.
- The map is saved in the cache folder of Rafiki AI Code (`~/.cache/rafikicode/project-map/<id>/` on Linux), one folder per project. Nothing is written into your project. If a graphify version ever leaves a `graphify-out/` folder there, it is added to `.git/info/exclude` (never to `.gitignore`).
- Only the four code graph tools are offered. graphify's pull request tools, which call GitHub, are left out.

## When to use it

The map helps most in a large or unfamiliar codebase, where finding callers and definitions takes many searches. In a small project plain search is as fast. A `graphify` server you added yourself under `mcp` in your configuration is left as it is, and the map does not add a second one.

## Remove it

Turn it off (`RAFIKICODE_MAP=0` or remove `map.graphify`), then delete the cache folder `project-map` named above. Uninstall graphify with the tool you used, for example `uv tool uninstall graphifyy`.
