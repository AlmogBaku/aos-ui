import { describe, expect, it, vi } from "vitest"

import {
  AGENT,
  chunk,
  harness,
  SESSION,
  turnStarted,
} from "../../../../../packages/proxy/acp/test-harness"
import { useFakeClock } from "../../../../../test/support/fake-clock"

import {
  CAPACITY_BACKOFF,
  HANDSHAKE_DEADLINE_MS,
  LIVENESS_SILENCE_MS,
  RECONNECT_BACKOFF,
  REQUEST_DEADLINE_MS,
  STABLE_AFTER_MS,
} from "../limits"
import type { AcpConnectionStatus, AcpSessionState } from "../types"
import {
  connectBrowser,
  methodsOf,
  sentFrames,
  watchTranscript,
} from "./support"

type Pipe = ReturnType<typeof connectBrowser>["pipe"]

/** What the browser holds once its turn has streamed its first chunk. */
const HELD = ["assistant: replay:message-1", "user: Go", "assistant: Live"]
/** The same, with the chunk the turn streamed while the browser was cut off. */
const WHOLE = [
  "assistant: replay:message-1",
  "user: Go",
  "assistant: Live reply",
]

const { baseMs } = RECONNECT_BACKOFF

type Row = {
  fault: string
  /** Faults the browser's live socket as its turn streams. */
  inject(pipe: Pipe): void
  /** Until then the browser opens no socket and shows this status. */
  holds?: { ms: number; status: AcpConnectionStatus }
  /** By then it has recovered, or stopped for good, whatever the jitter. */
  bound: number
  status: AcpConnectionStatus
  /** Undefined once the connection has ended and holds no Session. */
  session: AcpSessionState | undefined
  /** The Session's resumes the fault costs, over every later transport. */
  resumes: number
  transcript: string[]
}

/** One row per fault a browser's socket meets; each is injected mid-turn. */
const ROWS: Row[] = [
  {
    fault: "the network drops",
    inject: (pipe) => pipe.sockets[0]!.drop(),
    bound: baseMs,
    status: "ready",
    session: "joined",
    resumes: 1,
    transcript: WHOLE,
  },
  {
    fault: "the link goes half-open",
    inject: (pipe) => pipe.sockets[0]!.halfOpen(),
    holds: {
      ms: LIVENESS_SILENCE_MS + REQUEST_DEADLINE_MS.probe,
      status: "ready",
    },
    bound: LIVENESS_SILENCE_MS + REQUEST_DEADLINE_MS.probe + baseMs,
    status: "ready",
    session: "joined",
    resumes: 1,
    transcript: WHOLE,
  },
  {
    fault: "the reopened socket's handshake is never answered",
    inject: (pipe) => {
      pipe.neverAnswerHandshake()
      pipe.sockets[0]!.drop()
    },
    // The unanswered socket's backoff, its deadline, then the next backoff.
    bound: baseMs + HANDSHAKE_DEADLINE_MS + 2 * baseMs,
    status: "ready",
    session: "joined",
    resumes: 1,
    transcript: WHOLE,
  },
  {
    fault: "the proxy closes at capacity (1013)",
    inject: (pipe) => pipe.sockets[0]!.closeFromProxy(1013),
    holds: { ms: CAPACITY_BACKOFF.minMs, status: "capacity" },
    bound: CAPACITY_BACKOFF.maxMs,
    status: "ready",
    session: "joined",
    resumes: 1,
    transcript: WHOLE,
  },
  {
    fault: "the proxy closes on a policy violation (1008)",
    inject: (pipe) => pipe.sockets[0]!.closeFromProxy(1008),
    bound: 0,
    status: "closed",
    session: undefined,
    resumes: 0,
    transcript: HELD,
  },
]

describe.each([0, 0.9999])("browser fault table (jitter %s)", (jitter) => {
  it.each(ROWS)("settles within its bound when $fault", async (row) => {
    vi.spyOn(Math, "random").mockReturnValue(jitter)
    const clock = useFakeClock()
    const { test, pipe, connection } = connectBrowser(await harness())
    const frames = sentFrames()
    const transcript = watchTranscript(connection, {
      agentId: AGENT,
      sessionId: SESSION,
    })
    await connection.joined(SESSION)
    const prompted = connection.prompt(
      SESSION,
      [{ type: "text", text: "Go" }],
      { clientId: "client-1" }
    )
    await clock.advance(0)
    await prompted
    test.sources[0]!.emit(turnStarted())
    chunk(test.sources[0], "Live")
    await clock.advance(0)
    expect(transcript()).toEqual(HELD)
    const resumes = () =>
      methodsOf(frames, SESSION).filter((method) => method === "session/resume")
        .length
    const resumed = resumes()

    row.inject(pipe)
    chunk(test.sources[0], " reply")
    let elapsed = 0
    if (row.holds) {
      elapsed = row.holds.ms - 1
      await clock.advance(elapsed)
      expect(pipe.sockets).toHaveLength(1)
      expect(connection.status).toBe(row.holds.status)
    }
    await clock.advance(row.bound - elapsed)

    expect(connection.status).toBe(row.status)
    expect(connection.sessionState(SESSION)).toBe(row.session)
    expect(transcript()).toEqual(row.transcript)
    // Settled: nothing is retried, and what recovered stays up.
    const sockets = pipe.sockets.length
    await clock.advance(STABLE_AFTER_MS)
    expect(pipe.sockets).toHaveLength(sockets)
    expect(resumes() - resumed).toBe(row.resumes)
    expect(connection.status).toBe(row.status)
  })
})
