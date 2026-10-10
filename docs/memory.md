# Project memory

Rafiki Code keeps a short memory for each project, so a new session starts with what earlier sessions learned: what the project is, what was decided and why, where the work stands, and the commands and gotchas worth knowing. It is four plain Markdown files in the project, which you can read, edit and commit like any other file.

## The files

The memory lives in `.rafiki/memory/` at the root of the project (the repository root in a git repository, the current folder otherwise):

| file | what it holds |
|---|---|
| `project.md` | what the project is and its stack |
| `decisions.md` | dated decisions, each with its reason |
| `progress.md` | what is done, what is in progress, what is next |
| `notes.md` | gotchas and commands that work |

Each file is a heading followed by a list, one entry per item:

```markdown
# Decisions

- 2026-10-10: Use SQLite for storage, because the app runs on one machine.
- 2026-10-11: Keep the public API in English; the interface is translated.
```

The folder is created the first time something is recorded. Nothing is ever written outside the project folder: if `.rafiki` or `.rafiki/memory` is a symbolic link, or one of the files is, the memory is not read and not written.

## How the agent uses it

At the start of a session the agent reads the four files, after the project instructions (`AGENTS.md`) and the repository context. They are read once per session and sent with the same bytes on every request of it, so they never break the prompt cache; what the agent records during a session is read by the next session, or by the same session after its conversation is compacted.

The agent keeps the memory current with one tool, `memory_update`, which changes one section with one small operation:

| operation | what it does |
|---|---|
| `append` | adds an entry. A decision without a date gets today's date |
| `replace` | with a `match`, replaces the one entry that contains it; without, rewrites the whole section |
| `remove` | removes the one entry that contains the given text |

It records something before it gives its final answer, when the task settled something worth keeping, and after a compaction, for the decisions and progress the summary holds. The file tools (edit, write, patch) refuse to change files in `.rafiki/memory/`, so every change goes through `memory_update` and stays small and easy to review. Subagents do not write the memory.

Every write is checked before anything is saved:

- The text must not look like a secret. The same scan as `/github` runs on it (private keys, GitHub, GitLab, Slack, Stripe, AWS, Google and npm tokens, `sk-` keys), and a match is refused. The agent is told to name the environment variable or file that holds a secret instead.
- One entry is at most 1,500 bytes.
- The whole memory stays under its size cap, 8 KB by default. A write that would pass it is refused with a request to make room first (replace a section with a shorter version, or remove what is finished or no longer true). A write that makes the memory smaller always goes through.

If the files grow past the cap by hand, a session reads a fitted part of them: each file gets an equal share, `decisions.md` keeps its newest entries and the others their beginning, and a note says how much was left out.

## See and edit it: `/memory`

In the terminal interface, `/memory` (or `Memory` in the command list) lists the four files with their size. Pick one to open it in your editor (`VISUAL` or `EDITOR`); without one, its content is shown with its path so you can edit it elsewhere. A file you save there goes through the same secret scan. `About the memory` shows the folder, the size against the cap, and how to turn it off.

You can also edit the files with any editor; the next session reads what you wrote.

## Git

In a git repository the memory is suggested for commit, never committed for you: the agent does not commit `.rafiki/memory/` by itself, and tells you once, when it creates the folder, that you can commit it with the project. Commit it when the team should share it, or add `.rafiki/memory/` to `.gitignore` to keep it on your machine.

## Turn it off or change the cap

```json
{
  "memory": { "enabled": false }
}
```

in `rafikicode.json` turns it off for the project (or in your user configuration, for every project). `RAFIKICODE_MEMORY=0` turns it off for one run, and `RAFIKICODE_MEMORY=1` turns it on; the environment variable wins over the configuration. When it is off, nothing is read, the agent has no `memory_update` tool, and the files stay as they are.

`"memory": { "max_bytes": 16384 }` changes the cap, from 1,024 to 32,768 bytes. A larger memory costs more on every request of every session, so keep it short.

With `RAFIKICODE_DISABLE_PROJECT_CONFIG=1` nothing is read from the working tree, the memory included.
