import { describe, expect, it, onTestFinished, vi } from "vitest"

import { AOS_METHODS } from "../../../../../packages/protocol/acp"
import {
  AGENT,
  chunk,
  harness,
  open,
  prompt,
  SESSION,
  sessionRow,
  turnStarted,
} from "../../../../../packages/proxy/acp/test-harness"
import { useFakeClock } from "../../../../../test/support/fake-clock"

import { createAcpConnection } from "../connection"
import { pipedSockets } from "../test-socket"

const SIBLING = "session-2"

describe("browser gone Session faults", () => {
  it("rejoins a Session the proxy reported gone no more, and still rejoins its sibling", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const test = await harness({
      rows: [sessionRow(), sessionRow({ id: SIBLING })],
    })
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
    connection.start()
    await connection.initialized
    const notices: unknown[] = []
    connection.subscribeNotification(AOS_METHODS.notify.error, (params) =>
      notices.push(params)
    )
    // The tab follows a turn on SESSION, so its rejoin carries a cursor.
    const live = Promise.withResolvers<void>()
    for (const sessionId of [SESSION, SIBLING]) {
      connection.subscribeSessionUpdates(sessionId, (update) => {
        if (JSON.stringify(update).includes("Live")) live.resolve()
      })
      await connection.resumeSession(sessionId, {
        replayFromStart: true,
        agentId: AGENT,
      })
    }
    await test.list()
    await open(test)
    await prompt(test, "Summarize")
    test.sources[0]?.emit(turnStarted())
    chunk(test.sources[0], "Live")
    await live.promise

    const clock = useFakeClock()
    test.faults.gone(test.scope)
    pipe.sockets[0]!.drop()
    await clock.advance(1_000)
    expect(notices).toEqual([
      { sessionId: SESSION, code: "not_found", message: "not_found" },
    ])

    pipe.sockets[1]!.drop()
    await clock.advance(10_000)
    expect(connection.status).toBe("ready")
    expect(pipe.sockets).toHaveLength(3)
  })
})
