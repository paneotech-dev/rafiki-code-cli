// Sessions that confirmed the switch to Rafiki Max (component/tier-choice.tsx),
// by session id, or "new" before the first message. One process, one
// interface: a module value is enough.
const confirmed = new Set<string>()

export function sessionKey(sessionID: string | undefined) {
  return sessionID ?? "new"
}

export function isConfirmed(key: string) {
  return confirmed.has(key)
}

export function markConfirmed(key: string) {
  confirmed.add(key)
}

// For tests.
export function resetConfirmed() {
  confirmed.clear()
}
