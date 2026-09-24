import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ExecutionEvent } from "../core/events"
import type { RuntimeInstance } from "../core/runtime"
import { createSessionRows, READ_GUARD_MS } from "../core/session-rows"
import {
  createReadState,
  FOCUS_DEBOUNCE_MS,
  REACK_FLOOR_MS,
} from "./read-state"

const AGENT = "researcher"
const SESSION = "session-1"

function harness(
  options: {
    unread?: boolean
    tracked?: boolean
    mutate?: () => Promise<void>
  } = {}
) {
  const updateSession = vi.fn(options.mutate ?? (async () => undefined))
  const runtimeInfo = vi.fn(async () => ({
    runtime: { id: "hermes", name: "Hermes" },
    status: "ready",
    capabilities: {
      sessionReadState:
        options.tracked === false
          ? { status: "unavailable", reason: "Older Hermes" }
          : { status: "available" },
    },
  }))
  // The proxy runtime surface is wide; read state reaches for these three, and
  // never for the coordinator this connection shares.
  const runtimeInstance = {
    id: "hermes-primary",
    runtime: {
      runtimeInfo,
      resolveSessionId: (_agentId: string, publicId: string) =>
        `stored-${publicId}`,
      updateSession,
    },
  } as unknown as RuntimeInstance
  const sessionRows = createSessionRows()
  sessionRows.rememberList([
    {
      id: SESSION,
      agentId: AGENT,
      title: "Weekly digest",
      archived: false,
      updatedAt: "2026-09-19T10:00:00.000Z",
      status: "idle",
      unread: options.unread ?? false,
    },
  ])
  const onUnreadChanged = vi.fn()
  const readState = createReadState({
    runtimeInstance,
    sessionRows,
    onUnreadChanged,
  })
  return { updateSession, onUnreadChanged, readState, runtimeInfo, sessionRows }
}

/** Runs the debounce and the write's own promise chain to completion. */
async function settle(elapsedMs: number) {
  await vi.advanceTimersByTimeAsync(elapsedMs)
  for (let hop = 0; hop < 10; hop += 1) await Promise.resolve()
}

function lifecycle(
  kind: "turn-started" | "turn-finished" | "turn-failed",
  sessionId = SESSION
): ExecutionEvent {
  return {
    agentId: AGENT,
    sessionId,
    turnId: "run-1",
    occurredAt: "2026-09-19T10:00:00.000Z",
    kind,
  }
}

function attention(sessionId = SESSION): ExecutionEvent {
  return {
    agentId: AGENT,
    sessionId,
    turnId: "run-1",
    occurredAt: "2026-09-19T10:00:00.000Z",
    kind: "attention-requested",
    request: { requestId: "question-1", kind: "elicitation" },
  }
}

describe("createReadState", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("arms the watermark once per exposure even when the row reads read", async () => {
    const { updateSession, onUnreadChanged, readState } = harness()

    readState.focus(AGENT, SESSION)
    expect(updateSession).not.toHaveBeenCalled()

    await settle(FOCUS_DEBOUNCE_MS)
    expect(updateSession).toHaveBeenCalledWith(AGENT, `stored-${SESSION}`, {
      unread: false,
    })
    expect(onUnreadChanged).toHaveBeenCalledWith(AGENT, SESSION, false)

    await settle(REACK_FLOOR_MS * 2)
    expect(updateSession).toHaveBeenCalledTimes(1)

    readState.focus(AGENT, SESSION)
    await settle(FOCUS_DEBOUNCE_MS)
    expect(updateSession).toHaveBeenCalledTimes(2)
  })

  it("defers a re-lit exposure's re-ack to the floor and ignores other Sessions", async () => {
    const { updateSession, readState } = harness({ unread: true })
    readState.focus(AGENT, SESSION)
    await settle(FOCUS_DEBOUNCE_MS)

    readState.onExecution(lifecycle("turn-finished"))
    await settle(FOCUS_DEBOUNCE_MS)
    expect(updateSession).toHaveBeenCalledTimes(1)

    // The floor spaces the writes out; it does not drop the one it held back.
    await settle(REACK_FLOOR_MS - FOCUS_DEBOUNCE_MS)
    expect(updateSession).toHaveBeenCalledTimes(2)

    await settle(REACK_FLOOR_MS)
    readState.onExecution(attention())
    await settle(FOCUS_DEBOUNCE_MS)
    expect(updateSession).toHaveBeenCalledTimes(3)

    await settle(REACK_FLOOR_MS)
    readState.onExecution(lifecycle("turn-started"))
    readState.onExecution(lifecycle("turn-failed", "session-2"))
    readState.onExecution(attention("session-2"))
    await settle(REACK_FLOOR_MS)
    expect(updateSession).toHaveBeenCalledTimes(3)
  })

  it("drops a floored re-ack once the Session leaves focus", async () => {
    const { updateSession, readState } = harness()
    readState.focus(AGENT, SESSION)
    await settle(FOCUS_DEBOUNCE_MS)
    readState.onExecution(lifecycle("turn-finished"))
    await settle(FOCUS_DEBOUNCE_MS)

    readState.blur()
    await settle(REACK_FLOOR_MS)
    expect(updateSession).toHaveBeenCalledTimes(1)
  })

  it("forwards no unread the provider reports while an ack is on its way", async () => {
    const { updateSession, readState, sessionRows } = harness()
    const published: (boolean | undefined)[] = []
    sessionRows.subscribe((row) => published.push(row.unread))
    const relight = () =>
      sessionRows.rememberList([
        {
          id: SESSION,
          agentId: AGENT,
          title: "Weekly digest",
          archived: false,
          updatedAt: "2026-09-19T10:05:00.000Z",
          status: "idle",
          unread: true,
        },
      ])

    readState.focus(AGENT, SESSION)
    relight()
    expect(sessionRows.get(AGENT, SESSION)?.unread).toBe(false)
    await settle(FOCUS_DEBOUNCE_MS)
    expect(updateSession).toHaveBeenCalledTimes(1)

    // A re-ack the floor holds back still holds the row read until it lands.
    await settle(READ_GUARD_MS)
    readState.onExecution(lifecycle("turn-finished"))
    await settle(FOCUS_DEBOUNCE_MS)
    relight()
    await settle(REACK_FLOOR_MS)
    expect(published).not.toContain(true)
    expect(sessionRows.get(AGENT, SESSION)?.unread).toBe(false)
  })

  it("restarts the debounce on a new exposure and cancels it on blur or close", async () => {
    const first = harness()

    first.readState.focus(AGENT, SESSION)
    await settle(FOCUS_DEBOUNCE_MS - 100)
    first.readState.focus(AGENT, "session-2")
    await settle(FOCUS_DEBOUNCE_MS - 100)
    expect(first.updateSession).not.toHaveBeenCalled()

    await settle(100)
    expect(first.updateSession).toHaveBeenCalledTimes(1)
    expect(first.updateSession).toHaveBeenCalledWith(
      AGENT,
      "stored-session-2",
      { unread: false }
    )

    first.readState.focus(AGENT, SESSION)
    first.readState.blur()
    await settle(FOCUS_DEBOUNCE_MS)
    expect(first.updateSession).toHaveBeenCalledTimes(1)

    const second = harness()
    second.readState.focus(AGENT, SESSION)
    second.readState.close()
    await settle(FOCUS_DEBOUNCE_MS)
    expect(second.updateSession).not.toHaveBeenCalled()
  })

  it("keeps the optimistic row when the provider rejects the write", async () => {
    const { updateSession, onUnreadChanged, readState, sessionRows } = harness({
      unread: true,
      mutate: async () => {
        throw new Error("Session not found")
      },
    })

    await expect(readState.markRead(AGENT, SESSION)).resolves.toBeUndefined()

    expect(updateSession).toHaveBeenCalledTimes(1)
    expect(onUnreadChanged).toHaveBeenCalledWith(AGENT, SESSION, false)
    expect(sessionRows.get(AGENT, SESSION)?.unread).toBe(false)
  })

  it("acknowledges a Session the provider re-lights under the operator's eyes without flashing it", async () => {
    const { updateSession, readState, sessionRows } = harness()
    const published: (boolean | undefined)[] = []
    sessionRows.subscribe((row) => published.push(row.unread))
    const relight = (sessionId: string) => {
      sessionRows.rememberList([
        {
          id: sessionId,
          agentId: AGENT,
          title: "Weekly digest",
          archived: false,
          updatedAt: "2026-09-19T10:05:00.000Z",
          status: "idle",
          unread: true,
        },
      ])
    }

    readState.focus(AGENT, SESSION)
    await settle(FOCUS_DEBOUNCE_MS)
    expect(updateSession).toHaveBeenCalledTimes(1)

    // Past the write guard and with no ack on its way, the focused row still
    // reads read while the provider gets its acknowledgement.
    await settle(READ_GUARD_MS)
    relight(SESSION)
    expect(sessionRows.get(AGENT, SESSION)?.unread).toBe(false)

    await settle(FOCUS_DEBOUNCE_MS)
    expect(updateSession).toHaveBeenCalledTimes(2)
    expect(published).not.toContain(true)

    await settle(READ_GUARD_MS)
    relight("session-2")
    await settle(FOCUS_DEBOUNCE_MS)
    expect(updateSession).toHaveBeenCalledTimes(2)
    expect(sessionRows.get(AGENT, "session-2")?.unread).toBe(true)

    // Out of focus, the provider's unread is the operator's again.
    readState.blur()
    relight(SESSION)
    await settle(FOCUS_DEBOUNCE_MS)
    expect(updateSession).toHaveBeenCalledTimes(2)
    expect(sessionRows.get(AGENT, SESSION)?.unread).toBe(true)
  })

  it("writes nothing when the runtime does not track read state", async () => {
    const { updateSession, readState, runtimeInfo } = harness({
      tracked: false,
      unread: true,
    })

    readState.focus(AGENT, SESSION)
    await settle(FOCUS_DEBOUNCE_MS)
    readState.focus(AGENT, SESSION)
    await settle(FOCUS_DEBOUNCE_MS)

    expect(updateSession).not.toHaveBeenCalled()
    expect(runtimeInfo).toHaveBeenCalledTimes(1)
  })
})
