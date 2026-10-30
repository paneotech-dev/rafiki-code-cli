// The compaction summary as a replay of the turn (session/compaction.ts): the summary request is the turn's own
// request with the summary instruction last, so the provider reads its start from the prompt cache. A replay that
// fails (the model asks for a tool, which a summary may not call) is written again from the transcript; its error
// is kept on its message and not shown, since the session goes on. The messages of replays in progress are kept
// here so the processor knows which errors to keep quiet.
const replays = new Set<string>()

export function begin(messageID: string) {
  replays.add(messageID)
}

export function end(messageID: string) {
  replays.delete(messageID)
}

export function active(messageID: string) {
  return replays.has(messageID)
}
