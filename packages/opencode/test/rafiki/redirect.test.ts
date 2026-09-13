// The Console and gateway clients (doctor, me, revoke, refresh, and provider
// requests) send the key as an Authorization header with fetch's default
// redirect handling. They rely on the runtime dropping that header when a
// redirect leaves the origin, as the Fetch standard requires. This pins that
// behaviour, so a runtime upgrade that changes it fails here first.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const seen: { server: string; auth: boolean }[] = []
let landing: ReturnType<typeof Bun.serve>
let redirector: ReturnType<typeof Bun.serve>

beforeAll(() => {
  landing = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen.push({ server: "other origin", auth: req.headers.has("authorization") })
      return new Response("ok")
    },
  })
  redirector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/landing") {
        seen.push({ server: "same origin", auth: req.headers.has("authorization") })
        return new Response("ok")
      }
      const [, kind, status] = url.pathname.split("/")
      const location = kind === "cross" ? `http://127.0.0.1:${landing.port}/landing` : "/landing"
      return new Response(null, { status: Number(status), headers: { location } })
    },
  })
})

afterAll(() => {
  landing.stop(true)
  redirector.stop(true)
})

async function follow(kind: "cross" | "same", status: number) {
  seen.length = 0
  const method = status === 307 || status === 308 ? "POST" : "GET"
  const res = await fetch(`http://127.0.0.1:${redirector.port}/${kind}/${status}`, {
    method,
    headers: { authorization: "Bearer sk-redirect-test-not-a-key" },
    body: method === "POST" ? "{}" : undefined,
  })
  await res.text()
  expect(seen).toHaveLength(1)
  return seen[0]
}

describe("Authorization on redirects", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    test(`a ${status} to another origin arrives without the key`, async () => {
      expect(await follow("cross", status)).toEqual({ server: "other origin", auth: false })
    })
  }

  test("a redirect within the same origin keeps it", async () => {
    expect(await follow("same", 307)).toEqual({ server: "same origin", auth: true })
  })
})
