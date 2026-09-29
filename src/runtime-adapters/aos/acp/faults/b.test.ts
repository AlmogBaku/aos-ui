import { describe, expect, it, vi } from "vitest"

import {
  AGENT,
  harness,
  SESSION,
  sessionRow,
} from "../../../../../packages/proxy/acp/test-harness"
import {
  providerSessionId,
  sessionId,
} from "../../../../../packages/proxy/core/ids"
import { useFakeClock } from "../../../../../test/support/fake-clock"

import { AOS_METHODS } from "@aos/protocol/acp"

import { LIVENESS_SILENCE_MS, PART_GRACE_MS } from "../limits"
import { connectBrowser, methodsOf, sentFrames } from "./support"

const SIBLING = "session-2"
const UNPLACED = "session-3"

describe("browser connection faults", () => {
  it("closes a transport that holds a request back at its deadline and reconnects", async () => {
    const clock = useFakeClock()
    const { pipe, connection } = connectBrowser(await harness())
    connection.start()
    await connection.initialized

    pipe.sockets[0]!.holdOutbound()
    const stalled = expect(connection.listAgents()).rejects.toMatchObject({
      name: "TimeoutError",
    })
    await clock.advance(30_000)
    await stalled
    await clock.advance(250)

    expect(pipe.sockets).toHaveLength(2)
    expect(connection.status).toBe("ready")
    await expect(connection.listAgents()).resolves.toBeDefined()
  })

  it("backs off any other close with full jitter up to 5 s until every Session rejoins, then starts over", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const clock = useFakeClock()
    const { test, pipe, connection } = connectBrowser(await harness())
    // A Session whose replay stalls never rejoins on that transport, so each
    // reopen still counts toward the backoff.
    test.faults.hangUntilAborted("history")
    connection.subscribe(SESSION, { agentId: AGENT })
    await clock.advance(0)

    const bounds = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]
    for (const [attempt, bound] of bounds.entries()) {
      // The last reopen's replay goes through.
      if (attempt < bounds.length - 1) test.faults.hangUntilAborted("history")
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
    const { connection } = connectBrowser(await harness())
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
      AOS_METHODS.session.part,
    ])
  })

  it("replays from the start again a from-start replay its transport dropped", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const clock = useFakeClock()
    const { test, pipe, connection } = connectBrowser(await harness())
    const frames = sentFrames()
    connection.subscribe(SESSION, { agentId: AGENT })
    await connection.joined(SESSION)

    test.faults.hangUntilAborted("history")
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

  it("never resumes a Session its provider has gone from, nor one whose Agent has no folder, while a sibling waits out its failure", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const clock = useFakeClock()
    const { test, connection } = connectBrowser(
      await harness({ rows: [sessionRow(), sessionRow({ id: SIBLING })] })
    )
    const frames = sentFrames()
    test.faults.gone({
      sessionId: sessionId(SESSION),
      providerSessionId: providerSessionId(SESSION),
    })
    test.faults.failOnce("history")

    connection.subscribe(SESSION, { agentId: AGENT })
    connection.subscribe(SIBLING, { agentId: AGENT })
    // No folder is listed for its Agent, and a resume never goes without one.
    connection.subscribe(UNPLACED, { agentId: "agent-unlisted" })
    await clock.advance(0)
    expect(connection.sessionState(SESSION)).toBe("gone")
    expect(connection.sessionState(SIBLING)).toBe("unavailable")
    expect(connection.sessionState(UNPLACED)).toBe("unavailable")

    await clock.advance(125)
    expect(connection.sessionState(SIBLING)).toBe("joined")
    await clock.advance(5_000)
    expect(methodsOf(frames, SESSION)).toEqual(["session/resume"])
    expect(methodsOf(frames, SIBLING)).toEqual([
      "session/resume",
      "session/resume",
    ])
    expect(methodsOf(frames, UNPLACED)).toEqual([])
  })

  it("clears the outage once a failed rejoin leaves the Session unavailable", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const clock = useFakeClock()
    const { test, pipe, connection } = connectBrowser(await harness())
    connection.subscribe(SESSION, { agentId: AGENT })
    await connection.joined(SESSION)

    pipe.sockets[0]!.drop()
    await clock.advance(0)
    expect(connection.outage).toBe("reconnecting")
    // A replay owed while away makes the rejoin read the provider's history.
    void connection.replay(SESSION).catch(() => {})
    test.faults.failOnce("history")
    await clock.advance(125)

    expect(connection.sessionState(SESSION)).toBe("unavailable")
    expect(connection.status).toBe("ready")
    expect(connection.outage).toBeUndefined()
  })

  it("clears the outage when a policy close ends a recovering connection", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const clock = useFakeClock()
    const { test, pipe, connection } = connectBrowser(await harness())
    connection.subscribe(SESSION, { agentId: AGENT })
    await connection.joined(SESSION)

    pipe.sockets[0]!.drop()
    void connection.replay(SESSION).catch(() => {})
    test.faults.hangUntilAborted("history")
    await clock.advance(125)
    expect(connection.outage).toBe("reconnecting")

    pipe.sockets[1]!.closeFromProxy(1008)
    await clock.advance(0)
    expect(connection.status).toBe("closed")
    expect(connection.outage).toBeUndefined()
  })

  it("clears the outage once the Session still rejoining parts", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const clock = useFakeClock()
    const { test, pipe, connection } = connectBrowser(await harness())
    const leave = connection.subscribe(SESSION, { agentId: AGENT })
    await connection.joined(SESSION)

    pipe.sockets[0]!.drop()
    void connection.replay(SESSION).catch(() => {})
    test.faults.hangUntilAborted("history")
    await clock.advance(125)
    expect(connection.status).toBe("ready")
    expect(connection.outage).toBe("reconnecting")

    leave()
    await clock.advance(PART_GRACE_MS)
    expect(connection.outage).toBeUndefined()
  })

  it("sends a write made during a rejoin once the Session has joined, and resends it with its client id", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const clock = useFakeClock()
    const { pipe, connection } = connectBrowser(await harness())
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

  it("delays the liveness probe 20 s from the last inbound frame", async () => {
    const clock = useFakeClock()
    const { pipe, connection } = connectBrowser(await harness())
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
    const { pipe, connection } = connectBrowser(await harness())
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
    expect(focusFrames).toHaveLength(2)
    expect(focusFrames.at(-1)?.params).toMatchObject({ sessionId: SESSION })
  })
})
