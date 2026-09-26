import { describe, expect, it, onTestFinished } from "vitest"

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
})
