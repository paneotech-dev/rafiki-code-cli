// The context figure the terminal interface shows for the last request of a
// session (sidebar, prompt row, subagent footer). Pure, no I/O.
//
// The figures come from the usage block the gateway returned for the last
// request (the last step of the last answer), recorded split: plain input,
// cache reads and cache writes (the three parts of what was sent, each
// counted once), output and reasoning (what came back). "Sent" is what that
// request carried into the model's window: plain input, cache reads and cache
// writes added up. The cached part is inside it, shown beside it, never added
// again. The percentage is of the window of the model recorded on the answer,
// which is the tier that answered. Nothing is summed across the session.
export interface Tokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface Usage {
  // Tokens the last request sent: plain input, cache reads and cache writes.
  sent: number
  // Of those, input read from the cache.
  cached: number
  // Of those, input written to the cache.
  written: number
  // Tokens the answer to it returned: output and reasoning.
  received: number
  // The window measured against, when known.
  window?: number
  // Share of the window the request sent: "2%", "<1%", or undefined without a window.
  percent?: string
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0)

export function usage(tokens: Partial<Tokens> | undefined, window: number | undefined): Usage {
  const read = count(tokens?.cache?.read)
  const written = count(tokens?.cache?.write)
  const sent = count(tokens?.input) + read + written
  const received = count(tokens?.output) + count(tokens?.reasoning)
  const size = count(window) || undefined
  return {
    sent,
    cached: read,
    written,
    received,
    ...(size ? { window: size, percent: percent(sent, size) } : {}),
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
