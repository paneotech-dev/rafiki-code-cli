// What "send to Rafiki Code" appends to the prompt: a file reference in the
// form the terminal interface understands, @path or @path#L3-7.

export interface LineSelection {
  // Zero based, as VS Code reports them.
  startLine: number
  endLine: number
  endCharacter: number
  isEmpty: boolean
}

export function lineRange(selection: LineSelection | undefined) {
  if (!selection || selection.isEmpty) {
    return undefined
  }
  const start = selection.startLine + 1
  // A selection that ends at the start of a line (a whole line selected with
  // the keyboard) does not include that line.
  const lastLine = selection.endCharacter === 0 && selection.endLine > selection.startLine ? selection.endLine - 1 : selection.endLine
  const end = lastLine + 1
  return start === end ? `#L${start}` : `#L${start}-${end}`
}

export function fileReference(filePath: string, selection?: LineSelection) {
  const normalized = filePath.replace(/\\/g, "/")
  return `@${normalized}${lineRange(selection) ?? ""}`
}

// The text appended when a terminal is opened for the active file.
export function openingPrompt(reference: string) {
  return `In ${reference}`
}
