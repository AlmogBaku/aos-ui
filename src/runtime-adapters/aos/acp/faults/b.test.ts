import { describe, expect, it, onTestFinished, vi } from "vitest"

import {
  AGENT,
  harness,
  SESSION,
  sessionRow,
  type HarnessOptions,
} from "../../../../../packages/proxy/acp/test-harness"
import {
  providerSessionId,
  sessionId,
} from "../../../../../packages/proxy/core/ids"
import { useFakeClock } from "../../../../../test/support/fake-clock"

import { AOS_METHODS } from "@aos/protocol/acp"

import { createAcpConnection } from "../connection"
import { LIVENESS_SILENCE_MS, PART_GRACE_MS } from "../limits"
import { PipedSocket, pipedSockets } from "../test-socket"

const SIBLING = "session-2"
const MALFORMED = "session-3"

/**
 * A browser connection to the harness proxy over piped sockets, not started.
 * The test fakes the clock first, so every deadline runs on it.
 */
async function connectBrowser(options?: HarnessOptions) {
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
  return { pipe, connection, faults: test.faults }
}

type Frame = {
  method?: string
  params?: {
    sessionId?: string
    replayFrom?: { type: string }
    _meta?: { aos?: { clientId?: string } }
  }
}

/**
 * Every frame the browser sends, in order. `fault` sees each as it leaves and
 * may fault its socket instead, so the proxy never receives that frame.
 */
function sentFrames(fault?: (frame: Frame, socket: PipedSocket) => boolean) {
  const frames: Frame[] = []
  const send = PipedSocket.prototype.send
  vi.spyOn(PipedSocket.prototype, "send").mockImplementation(function (
    this: PipedSocket,
    data: string
  ) {
    const frame = JSON.parse(data) as Frame
    frames.push(frame)
    if (!fault?.(frame, this)) send.call(this, data)
  })
  return frames
}

const methodsOf = (frames: Frame[], session: string) =>
  frames.flatMap((frame) =>
    frame.params?.sessionId === session && frame.method ? [frame.method] : []
  )

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
    const { pipe, connection, faults } = await connectBrowser()
    // A Session whose replay stalls never rejoins on that transport, so each
    // reopen still counts toward the backoff.
    faults.hangUntilAborted("history")
    connection.subscribe(SESSION, { agentId: AGENT })
    await clock.advance(0)

    const bounds = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]
    for (const [attempt, bound] of bounds.entries()) {
      // The last reopen's replay goes through.
      if (attempt < bounds.length - 1) faults.hangUntilAborted("history")
      pipe.sockets.at(-1)!.drop()
      await clock.advance(bound / 2 - 1)
      expect(pipe.sockets).toHaveLength(attempt + 1)
      await clock.advance(1)
      expect(pipe.sockets).toHaveLength(attempt + 2)
    }
    await clock.advance(0)
    expect(connection.sessionState(SESSION)).toBe("joined")

    pipe.sockets.at(-1)!.drop()
    await clock.advance(124)
    expect(pipe.sockets).toHaveLength(bounds.length + 1)
    await clock.advance(1)
    expect(pipe.sockets).toHaveLength(bounds.length + 2)
  })

  it("keeps a Session its listener leaves and rejoins within the grace, then parts it", async () => {
    const clock = useFakeClock()
    const { connection } = await connectBrowser()
    const frames = sentFrames()

    // As React StrictMode mounts, unmounts and mounts again.
    const leave = connection.subscribe(SESSION, { agentId: AGENT })
    await connection.joined(SESSION)
    leave()
    await clock.advance(PART_GRACE_MS - 1)
    const leaveAgain = connection.subscribe(SESSION, { agentId: AGENT })
    await clock.advance(PART_GRACE_MS)
    expect(methodsOf(frames, SESSION)).toEqual(["session/resume"])

    leaveAgain()
    await clock.advance(PART_GRACE_MS)
    expect(methodsOf(frames, SESSION)).toEqual([
      "session/resume",
      "session/close",
    ])
  })

  it("replays from the start again a from-start replay its transport dropped", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const clock = useFakeClock()
    const { pipe, connection, faults } = await connectBrowser()
    const frames = sentFrames()
    connection.subscribe(SESSION, { agentId: AGENT })
    await connection.joined(SESSION)

    faults.hangUntilAborted("history")
    const replayed = connection.replay(SESSION)
    await clock.advance(0)
    pipe.sockets[0]!.drop()
    await clock.advance(125)
    await replayed

    const resumes = frames.filter(
      ({ method, params }) =>
        method === "session/resume" && params?.sessionId === SESSION
    )
    expect(resumes.map(({ params }) => params?.replayFrom?.type)).toEqual([
      "start",
      "start",
      "start",
    ])
  })

  it("never resumes a Session its provider has gone from, nor one its transport refuses, while a sibling waits out its failure", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const clock = useFakeClock()
    const { connection, faults } = await connectBrowser({
      rows: [sessionRow(), sessionRow({ id: SIBLING })],
    })
    const frames = sentFrames()
    faults.gone({
      sessionId: sessionId(SESSION),
      providerSessionId: providerSessionId(SESSION),
    })
    faults.failOnce("history")

    connection.subscribe(SESSION, { agentId: AGENT })
    connection.subscribe(SIBLING, { agentId: AGENT })
    // The proxy refuses a malformed resume however often it is sent.
    connection.subscribe(MALFORMED, { agentId: "agent\u0001" })
    await clock.advance(0)
    expect(connection.sessionState(SESSION)).toBe("gone")
    expect(connection.sessionState(SIBLING)).toBe("unavailable")
    expect(connection.sessionState(MALFORMED)).toBe("unavailable")

    await clock.advance(125)
    expect(connection.sessionState(SIBLING)).toBe("joined")
    await clock.advance(5_000)
    expect(methodsOf(frames, SESSION)).toEqual(["session/resume"])
    expect(methodsOf(frames, SIBLING)).toEqual([
      "session/resume",
      "session/resume",
    ])
    expect(methodsOf(frames, MALFORMED)).toEqual(["session/resume"])
    await expect(connection.joined(MALFORMED)).rejects.toMatchObject({
      code: -32602,
    })
  })

  it("sends a write made during a rejoin once the Session has joined, and resends it with its client id", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const clock = useFakeClock()
    const { pipe, connection } = await connectBrowser()
    // The network drops as the first prompt leaves, before the proxy has it.
    let dropped = false
    const frames = sentFrames((frame, socket) => {
      if (dropped || frame.method !== "session/prompt") return false
      dropped = true
      socket.drop()
      return true
    })
    connection.subscribe(SESSION, { agentId: AGENT })
    await connection.joined(SESSION)
    pipe.sockets[0]!.drop()
    await clock.advance(0)

    const prompted = connection.prompt(
      SESSION,
      [{ type: "text", text: "Go" }],
      { clientId: "client-1" }
    )
    await clock.advance(0)
    expect(methodsOf(frames, SESSION)).toEqual(["session/resume"])

    await clock.advance(125)
    await clock.advance(125)
    await expect(prompted).resolves.toBeDefined()
    expect(methodsOf(frames, SESSION)).toEqual([
      "session/resume",
      "session/resume",
      "session/prompt",
      "session/resume",
      "session/prompt",
    ])
    const prompts = frames.filter(({ method }) => method === "session/prompt")
    expect(prompts.map((frame) => frame.params?._meta?.aos?.clientId)).toEqual([
      "client-1",
      "client-1",
    ])
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

  it("sends a liveness probe after 20 s of silence and closes after 10 s without an answer", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const clock = useFakeClock()
    const { pipe, connection } = await connectBrowser()
    const frames = sentFrames()
    connection.start()
    await connection.initialized

    // Block all inbound so the silence timer can expire.
    pipe.sockets[0]!.halfOpen()
    await clock.advance(LIVENESS_SILENCE_MS)

    expect(
      frames.filter((f) => f.method === AOS_METHODS.session.focus)
    ).toHaveLength(1)
    expect(connection.status).toBe("ready") // probe sent, not yet timed out

    // Probe deadline fires → transport closes → reconnect
    await clock.advance(10_000)
    await clock.advance(125) // reconnect backoff at 0.5 random
    expect(pipe.sockets).toHaveLength(2)
    expect(connection.status).toBe("ready")
  })

  it("delays the liveness probe 20 s from the last inbound frame", async () => {
    const clock = useFakeClock()
    const { pipe, connection } = await connectBrowser()
    const frames = sentFrames()
    const probes = () =>
      frames.filter((f) => f.method === AOS_METHODS.session.focus)
    connection.start()
    await connection.initialized

    // An answer 15 s into the window starts it over; then inbound goes quiet.
    await clock.advance(15_000)
    await connection.listAgents()
    pipe.sockets[0]!.halfOpen()
    await clock.advance(LIVENESS_SILENCE_MS - 1)
    expect(probes()).toHaveLength(0)

    await clock.advance(1)
    expect(probes()).toHaveLength(1)
  })

  it("re-reports the focused Session in the liveness probe after reconnect", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const clock = useFakeClock()
    const { pipe, connection } = await connectBrowser()
    const frames = sentFrames()
    connection.start()
    await connection.initialized

    // Report focus: stores lastFocus and sends an explicit probe.
    connection.focus(SESSION, { foreground: true, idle: false })

    // Block the probe so it times out and forces a reconnect.
    pipe.sockets[0]!.halfOpen()
    await clock.advance(10_000) // explicit focus probe deadline
    await clock.advance(125) // reconnect backoff

    expect(pipe.sockets).toHaveLength(2)
    // The first focus frame was the explicit call; the one from recover() follows.
    const focusFrames = frames.filter(
      (f) => f.method === AOS_METHODS.session.focus
    )
    expect(focusFrames.length).toBeGreaterThanOrEqual(2)
    expect(focusFrames.at(-1)?.params).toMatchObject({ sessionId: SESSION })
  })
})
