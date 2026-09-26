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
  shown,
  storedLiveTurn,
  turnStarted,
  withoutStates,
  type HarnessOptions,
} from "../../../../../packages/proxy/acp/test-harness"
import { TurnEventKind } from "../../../../../packages/proxy/core/events"
import { useFakeClock } from "../../../../../test/support/fake-clock"

import { createAcpConnection } from "../connection"
import { pipedSockets } from "../test-socket"

const SIBLING = "session-2"

/** A started browser connection to the harness proxy over piped sockets. */
async function connectBrowser(options: HarnessOptions = {}) {
  const test = await harness(options)
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
  return { test, pipe, connection }
}

/** The harness's own browser prompts, and the turn streams "Live". */
async function streamLive(test: Awaited<ReturnType<typeof harness>>) {
  await test.list()
  await open(test)
  await prompt(test, "Summarize")
  test.sources[0]?.emit(turnStarted())
  chunk(test.sources[0], "Live")
}

describe("browser gone Session faults", () => {
  it("rejoins a Session the proxy reported gone no more, and still rejoins its sibling", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const { test, pipe, connection } = await connectBrowser({
      rows: [sessionRow(), sessionRow({ id: SIBLING })],
    })
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
    await streamLive(test)
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

describe("browser replay faults", () => {
  it("replays a Session whose cursor left the journal once from the start, and streams the rest of its turn", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    // The provider stores the turn as it streams, which the replay reads.
    const { test, pipe, connection } = await connectBrowser({
      maxSubscriberEvents: 2,
      history: storedLiveTurn(),
    })
    // What the tab holds of the Session: a replay drops what it resends.
    let updates: object[] = []
    let replays = 0
    const live = Promise.withResolvers<void>()
    connection.subscribeSessionReplay(SESSION, () => {
      replays += 1
      updates = []
    })
    connection.subscribeSessionUpdates(SESSION, (update) => {
      updates.push(update)
      if (JSON.stringify(update).includes("Live")) live.resolve()
    })
    await connection.resumeSession(SESSION, {
      replayFromStart: true,
      agentId: AGENT,
    })
    await streamLive(test)
    await live.promise

    // The tab stops reading while the turn outgrows the journal, then its
    // socket closes abnormally.
    const clock = useFakeClock()
    replays = 0
    pipe.sockets[0]!.halfOpen()
    chunk(test.sources[0], "Aside", "assistant-2")
    pipe.sockets[0]!.drop()
    await clock.advance(1_000)
    chunk(test.sources[0], "More", "assistant-2")
    test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded })
    await clock.advance(1_000)

    expect(withoutStates(updates.flatMap(shown))).toEqual([
      "history user-1",
      "history assistant-0",
      "chunk More",
    ])
    expect(JSON.stringify(updates)).toContain("end_turn")
    expect(JSON.stringify(updates)).not.toContain("AOS_RESET_REQUIRED")
    expect(replays).toBe(1)
  })
})
