import { describe, expect, it, onTestFinished, vi } from "vitest"

import { harness } from "../../../../../packages/proxy/acp/test-harness"
import { useFakeClock } from "../../../../../test/support/fake-clock"

import { createAcpConnection } from "../connection"
import { pipedSockets } from "../test-socket"

/**
 * A browser connection to the harness proxy over piped sockets, not started.
 * The test fakes the clock first, so every deadline runs on it.
 */
async function connectBrowser() {
  const test = await harness()
  const pipe = pipedSockets(test.agentApp)
  const connection = createAcpConnection({
    clientInfo: { name: "aos-ui", version: "1" },
    url: "ws://proxy.test/api/aos/v1/acp",
    socketConstructor: pipe.WebSocket,
  })
  onTestFinished(() => {
    connection.close()
    test.close()
  })
  return { pipe, connection }
}

describe("browser connection faults", () => {
  it.each(["halfOpen", "holdOutbound"] as const)(
    "closes a transport that stalls a request (%s) at its deadline and reconnects",
    async (fault) => {
      const clock = useFakeClock()
      const { pipe, connection } = await connectBrowser()
      connection.start()
      await connection.initialized

      pipe.sockets[0]![fault]()
      const stalled = expect(connection.listAgents()).rejects.toMatchObject({
        name: "TimeoutError",
      })
      await clock.advance(30_000)
      await stalled
      await clock.advance(250)

      expect(pipe.sockets).toHaveLength(2)
      expect(connection.status).toBe("ready")
      await expect(connection.listAgents()).resolves.toBeDefined()
    }
  )

  it("retries a handshake the proxy never answers", async () => {
    const clock = useFakeClock()
    const { pipe, connection } = await connectBrowser()
    pipe.neverAnswerHandshake()
    connection.start()

    await clock.advance(10_000)
    expect(pipe.sockets).toHaveLength(1)
    await clock.advance(250)

    await expect(connection.initialized).resolves.toBeDefined()
    expect(pipe.sockets).toHaveLength(2)
  })

  it.each([0, 0.9999])(
    "waits out a 1013 close in the capacity state for 30 to 60 s (random %s)",
    async (random) => {
      vi.spyOn(Math, "random").mockReturnValue(random)
      const clock = useFakeClock()
      const { pipe, connection } = await connectBrowser()
      connection.start()
      await connection.initialized

      pipe.sockets[0]!.closeFromProxy(1013)
      await clock.advance(29_999)
      expect(connection.status).toBe("capacity")
      expect(pipe.sockets).toHaveLength(1)
      await clock.advance(30_000)

      expect(pipe.sockets).toHaveLength(2)
      expect(connection.status).toBe("ready")
    }
  )

  it("backs off any other close with full jitter up to 5 s until every Session rejoins, then starts over", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const clock = useFakeClock()
    const { pipe, connection } = await connectBrowser()
    connection.start()
    await connection.initialized
    // A Session the proxy does not know fails every rejoin, so each reopen
    // hands its handshake back and the attempts still add up.
    const leave = connection.subscribeSessionUpdates(
      "session-unknown",
      () => {}
    )

    pipe.sockets[0]!.drop()
    const bounds = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]
    for (const [attempt, bound] of bounds.entries()) {
      await clock.advance(bound / 2 - 1)
      expect(pipe.sockets).toHaveLength(attempt + 1)
      await clock.advance(1)
      expect(pipe.sockets).toHaveLength(attempt + 2)
    }
    leave()
    await clock.advance(2_500)
    expect(connection.status).toBe("ready")

    pipe.sockets.at(-1)!.drop()
    await clock.advance(124)
    expect(pipe.sockets).toHaveLength(bounds.length + 2)
    await clock.advance(1)
    expect(pipe.sockets).toHaveLength(bounds.length + 3)
  })

  it("ends the connection for good on a 1008 close", async () => {
    const clock = useFakeClock()
    const { pipe, connection } = await connectBrowser()
    connection.start()
    await connection.initialized

    pipe.sockets[0]!.closeFromProxy(1008)
    await clock.advance(60_000)

    expect(connection.status).toBe("closed")
    expect(pipe.sockets).toHaveLength(1)
  })
})

describe("build id handshake", () => {
  it("reloads once on a build id mismatch and not again once the guard is set", async () => {
    const reload = vi.fn()
    const storageMap = new Map<string, string>()
    const storage = {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storageMap.set(k, v)
      },
    }

    // First tab: browser build id differs from proxy's version — triggers reload.
    // The harness proxy answers info.version = "1" (AOS_EXTENSION_VERSION).
    const test1 = await harness()
    const pipe1 = pipedSockets(test1.agentApp)
    const first = createAcpConnection({
      clientInfo: { name: "test", version: "1" },
      buildId: "browser-build-1", // differs from proxy's "1"
      reload,
      storage,
      socketConstructor: pipe1.WebSocket,
    })
    onTestFinished(() => { first.close(); test1.close() })
    first.start()
    await first.initialized
    expect(reload).toHaveBeenCalledTimes(1)

    // Second connection using the same storage: guard already set, no second reload.
    const reload2 = vi.fn()
    const test2 = await harness()
    const pipe2 = pipedSockets(test2.agentApp)
    const second = createAcpConnection({
      clientInfo: { name: "test", version: "1" },
      buildId: "browser-build-1",
      reload: reload2,
      storage, // same storage: guard key is set
      socketConstructor: pipe2.WebSocket,
    })
    onTestFinished(() => { second.close(); test2.close() })
    second.start()
    await second.initialized
    expect(reload2).not.toHaveBeenCalled()
  })

  it("skips the check when the browser has no build id", async () => {
    const reload = vi.fn()
    const storage = {
      getItem: () => null,
      setItem: vi.fn(),
    }
    const test = await harness()
    const pipe = pipedSockets(test.agentApp)
    const connection = createAcpConnection({
      clientInfo: { name: "test", version: "1" },
      buildId: null, // no browser build id → no check
      reload,
      storage,
      socketConstructor: pipe.WebSocket,
    })
    onTestFinished(() => { connection.close(); test.close() })
    connection.start()
    await connection.initialized
    expect(reload).not.toHaveBeenCalled()
  })
})
