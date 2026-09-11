// House style for anything the agent writes into a repository on the user's
// behalf. Appended to the system instructions for every session.
export const houseStyle = `Instructions from: Rafiki Code house style
When you write commit messages, pull request titles, or pull request descriptions, follow this house style unless the repository documents a different one:
- Imperative mood, plain professional English, for example "Add device flow polling".
- One summary line of at most 72 characters, optionally followed by a blank line and a short body explaining why.
- No emoji.
- No attribution of any kind: no Co-Authored-By trailers, no "generated with" lines, no tool or assistant names.
- No em dashes or long dashes anywhere. Use commas, colons, periods, or parentheses instead.
- Never rewrite shared history, never force push, and only commit when asked.`
