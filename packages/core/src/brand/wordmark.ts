// Block letter wordmark for rafikicode, drawn with the glyph alphabet the
// upstream logo renderer understands: "_" is a shadowed space, "^" a shadowed
// upper half block, "~" a shadow only upper half block, "," a shadow only
// lower half block. Row 0 carries ascenders and dots, rows 1 to 3 the x-height.
// The left word renders muted, the right word renders bold.
const letters: Record<string, string[]> = {
  r: ["    ", "█▀▀▀", "█___", "▀   "],
  a: ["    ", "▀▀▀█", "█^^█", "▀▀▀▀"],
  f: [" ▄▀▀", "█___", "█^^^", "▀   "],
  i: ["▀", "█", "█", "▀"],
  k: ["▄   ", "█_▄▀", "█▀█_", "▀  ▀"],
  c: ["    ", "█▀▀▀", "█___", "▀▀▀▀"],
  o: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
  d: ["   ▄", "█▀▀█", "█__█", "▀▀▀▀"],
  e: ["    ", "█▀▀█", "█^^^", "▀▀▀▀"],
}

function word(text: string) {
  return [0, 1, 2, 3].map((row) => Array.from(text, (char) => letters[char][row]).join(" "))
}

export const logo = {
  left: word("rafiki"),
  right: word("code"),
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"

// Plain text rows for output without color support: shadow marks collapse to
// the character they decorate.
export const plain = logo.left.map((line, index) =>
  `${line} ${logo.right[index]}`.replaceAll("_", " ").replaceAll("^", "▀").replaceAll("~", "▀").replaceAll(",", "▄"),
)
