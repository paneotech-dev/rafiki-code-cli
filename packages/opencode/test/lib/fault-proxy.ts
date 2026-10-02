// A local HTTP proxy that cuts connections on purpose, for tests of what the
// program does when the network drops in the middle of a model request.
//
// It forwards every request to a target server on this machine and, when the
// plan says so, stops forwarding the response at a chosen point and destroys
// the client socket, which the client sees as a connection reset. It records
// the path, headers and JSON body of every request it receives, including the
// ones it refuses, so a test can assert what was sent again and under which
// headers.
//
// It listens on 127.0.0.1 on a free port between 4100 and 4199.
import http from "node:http"
import type { AddressInfo } from "node:net"

export type Cut =
  // Close the connection before any response, as a network that is down does.
  | { type: "refuse" }
  // Forward this many bytes of the response body, then cut.
  | { type: "bytes"; bytes: number }
  // Forward this many complete server sent events, wait, then cut. The wait
  // lets the client act on what it received (run a tool) before the cut.
  | { type: "events"; events: number; hold?: number }

export type Recorded = {
  // Position among the requests the plan was asked about (0 based).
  index: number
  path: string
  headers: Record<string, string>
  body: Record<string, unknown>
  raw: string
  cut?: Cut
  // Response body bytes that reached the client.
  forwarded: number
  // True when the whole response was forwarded.
  complete: boolean
}

export type Plan = (request: Recorded) => Cut | undefined

export type FaultProxy = {
  readonly url: string
  readonly requests: Recorded[]
  plan(next: Plan | undefined): void
  reset(): void
  close(): Promise<void>
}

const PORT_FIRST = 4100
const PORT_LAST = 4199
// Long enough for the bytes written before a cut to reach the client before
// the socket is destroyed; a reset can otherwise discard them.
const FLUSH_MS = 25

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function listen(server: http.Server): Promise<number> {
  const first = PORT_FIRST + Math.floor(Math.random() * (PORT_LAST - PORT_FIRST + 1))
  const attempt = (offset: number): Promise<number> =>
    new Promise((resolve, reject) => {
      if (offset > PORT_LAST - PORT_FIRST) return reject(new Error("no free port between 4100 and 4199"))
      const port = PORT_FIRST + ((first - PORT_FIRST + offset) % (PORT_LAST - PORT_FIRST + 1))
      const failed = (error: NodeJS.ErrnoException) => {
        server.off("listening", ready)
        if (error.code === "EADDRINUSE" || error.code === "EACCES") return resolve(attempt(offset + 1))
        reject(error)
      }
      const ready = () => {
        server.off("error", failed)
        resolve((server.address() as AddressInfo).port)
      }
      server.once("error", failed)
      server.once("listening", ready)
      server.listen(port, "127.0.0.1")
    })
  return attempt(0)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function parse(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw)
    return value && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

// The offset just past the nth blank line terminated event, or -1 when the
// buffer holds fewer than n events.
function endOfEvent(buffer: Buffer, n: number) {
  let seen = 0
  let from = 0
  while (seen < n) {
    const at = buffer.indexOf("\n\n", from)
    if (at === -1) return -1
    seen++
    from = at + 2
  }
  return from
}

export async function createFaultProxy(target: string, options?: { ignore?: (request: Recorded) => boolean }): Promise<FaultProxy> {
  const requests: Recorded[] = []
  const sockets = new Set<import("node:net").Socket>()
  let plan: Plan | undefined
  let counted = 0

  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req).catch(() => "")
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[name] = value
      else if (Array.isArray(value)) headers[name] = value.join(", ")
    }
    const record: Recorded = {
      index: -1,
      path: req.url ?? "/",
      headers,
      body: parse(raw),
      raw,
      forwarded: 0,
      complete: false,
    }
    const ignored = options?.ignore?.(record) ?? false
    if (!ignored) {
      record.index = counted++
      record.cut = plan?.(record)
      requests.push(record)
    }

    const cut = record.cut
    if (cut?.type === "refuse") {
      req.socket.destroy()
      return
    }

    const abort = new AbortController()
    const drop = async (hold = 0) => {
      await sleep(FLUSH_MS + hold)
      abort.abort()
      res.destroy()
      req.socket.destroy()
    }

    try {
      const forward: Record<string, string> = { ...headers }
      delete forward["host"]
      delete forward["content-length"]
      delete forward["connection"]
      const upstream = await fetch(new URL(record.path, target), {
        method: req.method,
        headers: forward,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : raw,
        signal: abort.signal,
      })
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-cache",
      })
      res.flushHeaders()
      if (!upstream.body) {
        record.complete = true
        res.end()
        return
      }

      let seen = Buffer.alloc(0)
      for await (const piece of upstream.body) {
        const chunk = Buffer.from(piece)
        if (!cut) {
          res.write(chunk)
          record.forwarded += chunk.length
          continue
        }
        seen = Buffer.concat([seen, chunk])
        const limit = cut.type === "bytes" ? (seen.length >= cut.bytes ? cut.bytes : -1) : endOfEvent(seen, cut.events)
        if (limit === -1) {
          res.write(chunk)
          record.forwarded += chunk.length
          continue
        }
        const allowed = limit - record.forwarded
        if (allowed > 0) {
          res.write(chunk.subarray(0, allowed))
          record.forwarded += allowed
        }
        await drop(cut.type === "events" ? cut.hold : 0)
        return
      }
      if (cut) {
        // The response was shorter than the cut point: cut at its end, before
        // the terminating chunk, so the request still fails as planned.
        await drop(cut.type === "events" ? cut.hold : 0)
        return
      }
      record.complete = true
      res.end()
    } catch {
      res.destroy()
      req.socket.destroy()
    }
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })

  const port = await listen(server)

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    plan(next) {
      plan = next
    },
    reset() {
      requests.length = 0
      counted = 0
      plan = undefined
    },
    close() {
      for (const socket of sockets) socket.destroy()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

// A small deterministic generator, so a failing random run can be repeated
// from the seed it printed.
export function seeded(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
