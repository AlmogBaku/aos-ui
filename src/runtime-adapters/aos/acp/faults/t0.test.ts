import { describe, expect, it, vi } from "vitest"

import {
  AGENT,
  harness,
  SESSION,
} from "../../../../../packages/proxy/acp/test-harness"
import { useFakeClock } from "../../../../../test/support/fake-clock"

import { createAcpConnection } from "../connection"
import { pipedSockets } from "../test-socket"

describe("fault harness", () => {
  it("gives each browser reconnection a proxy connection of its own", async () => {
    const clock = useFakeClock()
    const test = await harness()
    const join = vi.spyOn(test.channels, "join")
    const pipe = pipedSockets(test.agentApp)
    const connection = createAcpConnection({
      clientInfo: { name: "aos-ui", version: "1" },
      url: "ws://proxy.test/api/aos/v1/acp",
      socketConstructor: pipe.WebSocket,
    })
    connection.start()
    connection.subscribe(SESSION, { agentId: AGENT })
    await connection.joined(SESSION)

    pipe.sockets[0]?.drop()
    await clock.advance(250)

    const connectionIds = join.mock.calls.map(
      ([, , { membershipId }]) => membershipId.split(":")[0]
    )
    expect(new Set(connectionIds)).toEqual(new Set(["browser-1", "browser-2"]))
    connection.close()
    test.close()
  })
})
