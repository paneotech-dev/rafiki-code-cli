// A gateway that drops packets is reported in seconds (rafiki/connect-watch.ts),
// and the watch never cuts a request whose connection opened.
import { describe, expect, test } from "bun:test"
import net from "net"
import * as ConnectWatch from "../../src/rafiki/connect-watch"
import * as RafikiGateway from "../../src/rafiki/gateway-errors"

const URL_ = "https://gateway.example.test/v1/chat/completions"

// A fetch that never answers until its signal aborts, like a dropped SYN.
function hangingFetch() {
  const seen: { signal?: AbortSignal }[] = []
  const fn = (_input: any, init?: any) => {
    seen.push({ signal: init?.signal })
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })
  }
  return { fn, seen }
}

describe("connect watch", () => {
  test("a silent gateway fails the request with a connection error after the wait", async () => {
    const hanging = hangingFetch()
    const probes: [string, number, number][] = []
    const fetch = ConnectWatch.wrap(hanging.fn, {
      env: {},
      answered: () => false,
      probe: async (host, port, ms) => {
        probes.push([host, port, ms])
        return "silent"
      },
    })
    const error = await fetch(URL_, {}).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe("ETIMEDOUT")
    expect(error.message).toBe("Unable to connect: gateway.example.test did not answer within 10 s")
    expect(probes).toEqual([["gateway.example.test", 443, ConnectWatch.DEFAULT_WAIT_MS]])
    // The hanging request was aborted, so nothing is left running.
    expect(hanging.seen[0]!.signal!.aborted).toBe(true)
  })

  test("the AI SDK wording of that error is classified as an unreachable gateway", () => {
    const error = ConnectWatch.silentError("gateway.rafikiai.io", 10_000)
    const failure = RafikiGateway.classify({ message: `Cannot connect to API: ${error.message}` })
    expect(failure?.exitCode).toBe(4)
    expect(failure?.message).toContain("Cannot reach the model gateway")
    expect(failure?.message).toContain("did not answer within 10 s")
  })

  test("an open connection never cuts a slow answer", async () => {
    let answer!: (r: Response) => void
    const fetch = ConnectWatch.wrap(() => new Promise<Response>((resolve) => (answer = resolve)), {
      env: {},
      answered: () => false,
      probe: async () => "open",
    })
    const pending = fetch(URL_, {})
    await new Promise((r) => setTimeout(r, 20))
    answer(new Response("ok"))
    expect(await (await pending).text()).toBe("ok")
  })

  test("a refused connection is left to the request's own error", async () => {
    const refused = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
      code: "ConnectionRefused",
    })
    const fetch = ConnectWatch.wrap(() => Promise.reject(refused), {
      env: {},
      answered: () => false,
      probe: async () => "error",
    })
    expect(await fetch(URL_, {}).catch((e) => e)).toBe(refused)
  })

  test("off once the gateway has answered, behind a proxy, and with a wait of 0", async () => {
    let probed = 0
    const probe: ConnectWatch.Probe = async () => {
      probed++
      return "silent"
    }
    const ok = async () => new Response("ok")
    expect(await (await ConnectWatch.wrap(ok, { env: {}, answered: () => true, probe })(URL_, {})).text()).toBe("ok")
    expect(
      await (
        await ConnectWatch.wrap(ok, { env: { HTTPS_PROXY: "http://proxy:3128" }, answered: () => false, probe })(
          URL_,
          {},
        )
      ).text(),
    ).toBe("ok")
    expect(
      await (
        await ConnectWatch.wrap(ok, { env: { [ConnectWatch.WAIT_ENV]: "0" }, answered: () => false, probe })(URL_, {})
      ).text(),
    ).toBe("ok")
    expect(probed).toBe(0)
  })

  test("the caller's own abort still reaches the request", async () => {
    const hanging = hangingFetch()
    const fetch = ConnectWatch.wrap(hanging.fn, {
      env: {},
      answered: () => false,
      probe: () => new Promise(() => {}),
    })
    const caller = new AbortController()
    const pending = fetch(URL_, { signal: caller.signal }).catch((e) => e)
    caller.abort()
    expect(((await pending) as Error).name).toBe("AbortError")
  })

  test("the wait is read from RAFIKICODE_CONNECT_WAIT in seconds", () => {
    expect(ConnectWatch.waitMs({})).toBe(10_000)
    expect(ConnectWatch.waitMs({ [ConnectWatch.WAIT_ENV]: "3" })).toBe(3_000)
    expect(ConnectWatch.waitMs({ [ConnectWatch.WAIT_ENV]: "nonsense" })).toBe(10_000)
    expect(ConnectWatch.waitMs({ [ConnectWatch.WAIT_ENV]: "99999" })).toBe(300_000)
  })

  test("the TCP probe tells an open port from a refused one", async () => {
    const server = net.createServer((s) => s.end())
    const port = await new Promise<number>((r) =>
      server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port)),
    )
    expect(await ConnectWatch.tcpProbe("127.0.0.1", port, 2_000)).toBe("open")
    await new Promise<void>((r) => server.close(() => r()))
    expect(await ConnectWatch.tcpProbe("127.0.0.1", port, 2_000)).toBe("error")
  })
})
