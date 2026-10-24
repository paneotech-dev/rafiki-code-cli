// The size of one tool result as the model receives it.
//
// A result over CAP_BYTES (32 KB, about 8,000 tokens) or MAX_LINES lines is
// not sent whole: the full text is written to a file in the session's folder
// under the tool output directory (tool/truncation-dir.ts), and the model gets
// the head and the tail of it, the line and byte count of the whole, the lines
// that were left out and the path, so it can read the rest by range (Read with
// offset and limit) or search it (Grep). Without the cap a single test run or
// a large search could put 50 KB into every later request of the session.
//
// tool_output.max_bytes and tool_output.max_lines in the config move the cap.
// The text sent for a capped result is built only from the result and the
// file name, so it never changes once sent and stays in the provider's cache.
//
// Used by tool/truncate.ts (every tool without its own limit, MCP and plugin
// tools) and tool/shell.ts (which streams long output to the file itself).
// The read tool has its own page size, the same CAP_BYTES.

export const CAP_BYTES = 32 * 1024
export const MAX_LINES = 2000

// One end of a text: whole lines while they fit, or, when even the first line
// does not, the bytes of that line that fit (cut on a character boundary).
export interface End {
  text: string
  lines: number
  bytes: number
  // True when the end is part of a line (a single line longer than the budget).
  partial: boolean
}

function charStart(buf: Buffer, at: number) {
  let index = at
  while (index < buf.length && index > 0 && (buf[index] & 0xc0) === 0x80) index++
  return index
}

function charEnd(buf: Buffer, at: number) {
  let index = at
  while (index > 0 && index < buf.length && (buf[index] & 0xc0) === 0x80) index--
  return index
}

// The first lines of text within maxLines and maxBytes.
export function head(text: string, maxLines: number, maxBytes: number): End {
  const lines = text.split("\n")
  const out: string[] = []
  let bytes = 0
  for (let i = 0; i < lines.length && out.length < maxLines; i++) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) break
    out.push(lines[i])
    bytes += size
  }
  if (out.length > 0 || maxLines <= 0 || maxBytes <= 0) return { text: out.join("\n"), lines: out.length, bytes, partial: false }
  const buf = Buffer.from(lines[0] ?? "", "utf-8")
  const cut = buf.subarray(0, charEnd(buf, Math.min(maxBytes, buf.length)))
  return { text: cut.toString("utf-8"), lines: 1, bytes: cut.length, partial: true }
}

// The last lines of text within maxLines and maxBytes.
export function tail(text: string, maxLines: number, maxBytes: number): End {
  const lines = text.split("\n")
  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) break
    out.unshift(lines[i])
    bytes += size
  }
  if (out.length > 0 || maxLines <= 0 || maxBytes <= 0) return { text: out.join("\n"), lines: out.length, bytes, partial: false }
  const buf = Buffer.from(lines[lines.length - 1] ?? "", "utf-8")
  const cut = buf.subarray(charStart(buf, Math.max(0, buf.length - maxBytes)))
  return { text: cut.toString("utf-8"), lines: 1, bytes: cut.length, partial: true }
}

// Lines of a text; a final newline ends the last line, it does not start another.
export function lineCount(text: string) {
  if (text === "") return 0
  let count = text.endsWith("\n") ? 0 : 1
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count++
  return count
}

export function fits(text: string, maxLines: number, maxBytes: number) {
  return lineCount(text) <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes
}

// Thousands separated by commas whatever the locale, so the bytes are the same everywhere.
export function count(value: number) {
  return String(Math.max(0, Math.floor(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

export interface Cut {
  head: End
  tail: End
  // The whole text.
  lines: number
  bytes: number
  // What is not shown.
  omittedLines: number
  omittedBytes: number
  // The first and last line numbers (1 based) not shown in full.
  from: number
  to: number
  // True when the byte budget, not the line budget, decided what is shown.
  byBytes: boolean
}

// Head and tail of a text over the limits, each with half of the budget. The
// tail is taken from what follows the head, so the two never overlap. With
// whole, the head comes from another text and the totals are given (shell
// output, of which only the start and the end are kept in memory).
export function cut(
  text: string,
  limits: { maxLines: number; maxBytes: number },
  whole?: { head: string; lines: number; bytes: number },
): Cut {
  const lines = whole?.lines ?? lineCount(text)
  const bytes = whole?.bytes ?? Buffer.byteLength(text, "utf-8")
  // The final newline is not shown as an empty last line.
  if (text.endsWith("\n")) text = text.slice(0, -1)
  const headLines = Math.ceil(limits.maxLines / 2)
  const tailLines = Math.max(0, limits.maxLines - headLines)
  const headBytes = Math.ceil(limits.maxBytes / 2)
  const tailBytes = Math.max(0, limits.maxBytes - headBytes)
  const first = head(whole?.head ?? text, headLines, headBytes)
  let rest = text
  if (!whole) {
    const buf = Buffer.from(text, "utf-8")
    // After a whole line the separator goes too; after part of a line the rest of it stays.
    const skip = first.partial || first.lines === 0 ? first.bytes : first.bytes + 1
    rest = buf.subarray(Math.min(skip, buf.length)).toString("utf-8")
  }
  const last = rest === "" ? { text: "", lines: 0, bytes: 0, partial: false } : tail(rest, tailLines, tailBytes)
  const fullHead = first.partial ? 0 : first.lines
  const fullTail = last.partial ? 0 : last.lines
  const omittedLines = Math.max(0, lines - fullHead - fullTail)
  const separators = (fullHead > 0 ? 1 : 0) + (fullTail > 0 ? 1 : 0)
  const omittedBytes = Math.max(0, bytes - first.bytes - last.bytes - separators)
  const byBytes = fullHead + fullTail < Math.min(limits.maxLines, lines)
  return { head: first, tail: last, lines, bytes, omittedLines, omittedBytes, from: fullHead + 1, to: lines - fullTail, byBytes }
}

// The text in place of the left out part: how much is left out, how large the
// whole is, where it is, and how to read the rest.
export function notice(input: { cut: Cut; file: string; delegate: boolean }) {
  const { cut, file } = input
  const removed = cut.byBytes ? `${count(cut.omittedBytes)} bytes` : `${count(cut.omittedLines)} lines`
  const shown =
    cut.lines === 1
      ? `The output is one line of ${count(cut.bytes)} bytes; its start and end are shown.`
      : `The output has ${count(cut.lines)} lines (${count(cut.bytes)} bytes); lines ${count(cut.from)} to ${count(cut.to)} are not shown in full.`
  const how = input.delegate
    ? "Use the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context."
    : "Use Grep to search the full content or Read with offset/limit to view specific sections."
  return [
    `...${removed} truncated...`,
    "",
    `The tool call succeeded but the output was truncated. ${shown}`,
    `Full output saved to: ${file}`,
    how,
  ].join("\n")
}

// The result as the model receives it: head, notice, tail.
export function compose(input: { cut: Cut; file: string; delegate: boolean }) {
  return [input.cut.head.text, notice(input), input.cut.tail.text].filter((part) => part !== "").join("\n\n")
}
