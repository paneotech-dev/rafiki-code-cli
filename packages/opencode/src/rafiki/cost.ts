// The one line rafikicode run prints after a task: tier path, estimated
// spend, what caching saved, credits left. The figures and the wording come
// from the brand layer (core/brand/cost.ts); this file reads the session's
// messages through the client the command already holds.
import * as Account from "@opencode-ai/core/brand/account"
import * as Cost from "@opencode-ai/core/brand/cost"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { UI } from "@/cli/ui"

// Subagents of subagents are followed this deep.
const DEPTH = 3

async function messagesOf(client: OpencodeClient, sessionID: string) {
  const result = await client.session.messages({ sessionID })
  return (result.data ?? []).map((item) => item.info)
}

// Every model call of a task: the session's own and those of the subagent
// sessions started under it.
export async function collect(client: OpencodeClient, sessionID: string): Promise<Cost.Call[]> {
  const out = Cost.callsOf(await messagesOf(client, sessionID), true)
  const walk = async (parent: string, depth: number): Promise<void> => {
    if (depth > DEPTH) return
    const children = (await client.session.children({ sessionID: parent })).data ?? []
    for (const child of children) {
      out.push(...Cost.callsOf(await messagesOf(client, child.id), false))
      await walk(child.id, depth + 1)
    }
  }
  await walk(sessionID, 1)
  return out
}

// The line for a set of calls. `since` is when this run started: credits left
// are the balance read then, minus what the calls made since are estimated to
// have cost.
export function line(all: readonly Cost.Call[], snapshot: Account.Snapshot, since: number): string | undefined {
  const summary = Cost.summarize(all, snapshot.prices)
  const spentSince = Cost.summarize(
    all.filter((call) => call.time >= since),
    snapshot.prices,
  ).spent
  const left = snapshot.balance === undefined ? undefined : Cost.remaining({ balance: snapshot.balance, spent: 0 }, spentSince)
  return Cost.taskLine({ summary, left })
}

// Started before the first request of a run: reads the balance and the price
// list once, in the background. report() prints the line; it never fails the
// run and prints nothing when the task made no call on a Rafiki tier.
export function tracker(options: { snapshot?: () => Promise<Account.Snapshot>; now?: () => number } = {}) {
  const now = options.now ?? Date.now
  const since = now()
  const snapshot = (options.snapshot ?? Account.snapshot)().catch((): Account.Snapshot => ({ at: since }))
  return {
    async report(client: OpencodeClient, sessionID: string) {
      try {
        const text = line(await collect(client, sessionID), await snapshot, since)
        if (text) UI.println(UI.Style.TEXT_DIM + text + UI.Style.TEXT_NORMAL)
      } catch {
        // The answer was already printed; a missing cost line is not an error.
      }
    },
  }
}
