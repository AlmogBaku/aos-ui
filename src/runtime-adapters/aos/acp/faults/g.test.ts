import { describe, expect, it, onTestFinished, vi } from "vitest"

import {
  AGENT,
  chunk,
  harness,
  open,
  prompt,
  SESSION,
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

describe("browser replay faults", () => {
  it("replays a Session whose cursor left the journal once from the start, and streams the rest of its turn", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    // The provider stores the turn as it streams, which the replay reads.
    const history = storedLiveTurn()
    const { test, pipe, connection } = await connectBrowser({
      maxSubscriberEvents: 2,
      history,
    })
    // What the tab holds of the Session: a replay drops what it resends.
    let updates: object[] = []
    let replays = 0
    const live = Promise.withResolvers<void>()
    connection.subscribe(SESSION, {
      agentId: AGENT,
      replay: () => {
        replays += 1
        updates = []
      },
      update: (update) => {
        updates.push(update)
        if (JSON.stringify(update).includes("Live")) live.resolve()
      },
    })
    await connection.joined(SESSION)
    await streamLive(test)
    await live.promise

    // The tab stops reading while the turn outgrows the journal, then its
    // socket closes abnormally.
    const clock = useFakeClock()
    replays = 0
    pipe.sockets[0]!.halfOpen()
    chunk(test.sources[0], "Aside", "assistant-2")
    history.push({
      id: "assistant-2",
      role: "assistant",
      content: [{ type: "text", text: "Aside" }],
      createdAt: new Date().toISOString(),
    })
    pipe.sockets[0]!.drop()
    await clock.advance(1_000)
    chunk(test.sources[0], "More", "assistant-2")
    test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded })
    await clock.advance(1_000)

    expect(withoutStates(updates.flatMap(shown))).toEqual([
      "history user-1",
      "history assistant-0",
      "history assistant-2",
      "chunk More",
    ])
    expect(JSON.stringify(updates)).toContain("end_turn")
    expect(JSON.stringify(updates)).not.toContain("AOS_RESET_REQUIRED")
    expect(replays).toBe(1)
  })
})
