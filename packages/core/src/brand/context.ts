// The context figure the terminal interface shows for the last answer of a
// session (sidebar, prompt row, subagent footer). Pure, no I/O.
//
// The tokens of an answer are recorded split: plain input, cache reads and
// cache writes (the three parts of what was sent, each counted once), output
// and reasoning. What the conversation takes in the model's window after that
// answer is all five added up. The cached part is what of the input was read
// from the provider's cache; it is inside the total, shown beside it, never
// added to it again. The percentage is of the window of the model recorded on
// the answer, which is the tier that answered.
export interface Tokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface Usage {
  // Tokens the conversation takes in the window after the answer.
  tokens: number
  // Of those, input read from the cache.
  cached: number
  // The window measured against, when known.
  window?: number
  // "2%", "<1%", or undefined without a window.
  percent?: string
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0)

export function usage(tokens: Partial<Tokens> | undefined, window: number | undefined): Usage {
  const read = count(tokens?.cache?.read)
  const total =
    count(tokens?.input) + count(tokens?.output) + count(tokens?.reasoning) + read + count(tokens?.cache?.write)
  const size = count(window) || undefined
  return {
    tokens: total,
    cached: read,
    ...(size ? { window: size, percent: percent(total, size) } : {}),
  }
}

// A share of the window as people read it: a whole number of per cent, "<1%"
// for a share that is not zero but under one per cent (a 1M window makes that
// common, and "0%" would say the context is empty), never above what it is.
export function percent(tokens: number, window: number): string {
  if (tokens <= 0) return "0%"
  const share = (tokens / window) * 100
  if (share < 1) return "<1%"
  return `${Math.floor(share)}%`
}

// 1,000,000 as "1M", 200,000 as "200K", for the window beside the percentage.
export function windowText(window: number): string {
  if (window >= 1_000_000 && window % 100_000 === 0) return `${window / 1_000_000}M`
  if (window >= 1_000 && window % 1_000 === 0) return `${window / 1_000}K`
  return window.toLocaleString("en-US")
}
