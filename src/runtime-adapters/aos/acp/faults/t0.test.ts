import { describe, expect, it, vi } from "vitest"

import {
  AGENT,
  harness,
  SESSION,
} from "../../../../../packages/proxy/acp/test-harness"
import { useFakeClock } from "../../../../../test/support/fake-clock"

import { connectBrowser } from "./support"

describe("fault harness", () => {
  it("gives each browser reconnection a proxy connection of its own", async () => {
    const clock = useFakeClock()
    const { test, pipe, connection } = connectBrowser(await harness())
    const join = vi.spyOn(test.channels, "join")
    connection.start()
    connection.subscribe(SESSION, { agentId: AGENT })
    await connection.joined(SESSION)

    pipe.sockets[0]?.drop()
    await clock.advance(250)

    const connectionIds = join.mock.calls.map(
      ([, , { membershipId }]) => membershipId.split(":")[0]
    )
    expect(new Set(connectionIds)).toEqual(new Set(["browser-1", "browser-2"]))
  })
})
