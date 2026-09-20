import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ExecutionEvent } from "../core/events"
import type { RuntimeInstance } from "../core/runtime"
import { createSessionRows, READ_GUARD_MS } from "../core/session-rows"
import {
  createReadState,
  FOCUS_DEBOUNCE_MS,
  REACK_FLOOR_MS,
} from "./read-state"
import type { Lane } from "./types"

const AGENT = "researcher"
const SESSION = "session-1"

function harness(
  options: {
    lane?: Lane
    unread?: boolean
    tracked?: boolean
    mutate?: () => Promise<void>
  } = {}
) {
  const mutateSession = vi.fn(options.mutate ?? (async () => undefined))
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
      mutateSession,
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
    lane: options.lane ?? "operator",
    onUnreadChanged,
  })
  return { mutateSession, onUnreadChanged, readState, runtimeInfo, sessionRows }
}

/** Runs the debounce and the write's own promise chain to completion. */
async function settle(elapsedMs: number) {
  await vi.advanceTimersByTimeAsync(elapsedMs)
  for (let hop = 0; hop < 10; hop += 1) await Promise.resolve()
}

function lifecycle(
  type: "run-started" | "run-finished" | "run-failed",
  sessionId = SESSION
): ExecutionEvent {
  return {
    agentId: AGENT,
    sessionId,
    runId: "run-1",
    occurredAt: "2026-09-19T10:00:00.000Z",
    type,
  }
}

function attention(sessionId = SESSION): ExecutionEvent {
  return {
    agentId: AGENT,
    sessionId,
    runId: "run-1",
    occurredAt: "2026-09-19T10:00:00.000Z",
    type: "attention-requested",
    request: { id: "question-1", reason: "question" },
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
    const { mutateSession, onUnreadChanged, readState } = harness()

    readState.focus(AGENT, SESSION)
    expect(mutateSession).not.toHaveBeenCalled()

    await settle(FOCUS_DEBOUNCE_MS)
    expect(mutateSession).toHaveBeenCalledWith(
      AGENT,
      `stored-${SESSION}`,
      "PATCH",
      { unread: false }
    )
    expect(onUnreadChanged).toHaveBeenCalledWith(AGENT, SESSION, false)

    await settle(REACK_FLOOR_MS * 2)
    expect(mutateSession).toHaveBeenCalledTimes(1)

    readState.focus(AGENT, SESSION)
    await settle(FOCUS_DEBOUNCE_MS)
    expect(mutateSession).toHaveBeenCalledTimes(2)
  })

  it("re-acks a re-lit exposure behind the floor and ignores other Sessions", async () => {
    const { mutateSession, readState } = harness({ unread: true })
    readState.focus(AGENT, SESSION)
    await settle(FOCUS_DEBOUNCE_MS)

    readState.onExecution(lifecycle("run-finished"))
    await settle(FOCUS_DEBOUNCE_MS)
    expect(mutateSession).toHaveBeenCalledTimes(1)

    await settle(REACK_FLOOR_MS)
    readState.onExecution(attention())
    await settle(FOCUS_DEBOUNCE_MS)
    expect(mutateSession).toHaveBeenCalledTimes(2)

    await settle(REACK_FLOOR_MS)
    readState.onExecution(lifecycle("run-started"))
    readState.onExecution(lifecycle("run-failed", "session-2"))
    readState.onExecution(attention("session-2"))
    await settle(FOCUS_DEBOUNCE_MS)
    expect(mutateSession).toHaveBeenCalledTimes(2)
  })

  it("restarts the debounce on a new exposure and cancels it on blur or close", async () => {
    const first = harness()

    first.readState.focus(AGENT, SESSION)
    await settle(FOCUS_DEBOUNCE_MS - 100)
    first.readState.focus(AGENT, "session-2")
    await settle(FOCUS_DEBOUNCE_MS - 100)
    expect(first.mutateSession).not.toHaveBeenCalled()

    await settle(100)
    expect(first.mutateSession).toHaveBeenCalledTimes(1)
    expect(first.mutateSession).toHaveBeenCalledWith(
      AGENT,
      "stored-session-2",
      "PATCH",
      { unread: false }
    )

    first.readState.focus(AGENT, SESSION)
    first.readState.blur()
    await settle(FOCUS_DEBOUNCE_MS)
    expect(first.mutateSession).toHaveBeenCalledTimes(1)

    const second = harness()
    second.readState.focus(AGENT, SESSION)
    second.readState.close()
    await settle(FOCUS_DEBOUNCE_MS)
    expect(second.mutateSession).not.toHaveBeenCalled()
  })

  it("keeps the optimistic row when the provider rejects the write", async () => {
    const { mutateSession, onUnreadChanged, readState, sessionRows } = harness({
      unread: true,
      mutate: async () => {
        throw new Error("Session not found")
      },
    })

    await expect(readState.markRead(AGENT, SESSION)).resolves.toBeUndefined()

    expect(mutateSession).toHaveBeenCalledTimes(1)
    expect(onUnreadChanged).toHaveBeenCalledWith(AGENT, SESSION, false)
    expect(sessionRows.get(AGENT, SESSION)?.unread).toBe(false)
  })

  it("acknowledges a Session the provider re-lights under the operator's eyes", async () => {
    const { mutateSession, readState, sessionRows } = harness()
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
    expect(mutateSession).toHaveBeenCalledTimes(1)

    // Past the write guard, so the list read is believed rather than coerced.
    await settle(READ_GUARD_MS)
    relight(SESSION)
    expect(sessionRows.get(AGENT, SESSION)?.unread).toBe(true)

    await settle(FOCUS_DEBOUNCE_MS)
    expect(mutateSession).toHaveBeenCalledTimes(2)
    expect(sessionRows.get(AGENT, SESSION)?.unread).toBe(false)

    await settle(READ_GUARD_MS)
    relight("session-2")
    await settle(FOCUS_DEBOUNCE_MS)
    expect(mutateSession).toHaveBeenCalledTimes(2)
  })

  it("writes nothing when the runtime does not track read state", async () => {
    const { mutateSession, readState, runtimeInfo } = harness({
      tracked: false,
      unread: true,
    })

    readState.focus(AGENT, SESSION)
    await settle(FOCUS_DEBOUNCE_MS)
    readState.focus(AGENT, SESSION)
    await settle(FOCUS_DEBOUNCE_MS)

    expect(mutateSession).not.toHaveBeenCalled()
    expect(runtimeInfo).toHaveBeenCalledTimes(1)
  })

  it("never moves the watermark for a guest", async () => {
    const { mutateSession, onUnreadChanged, readState, sessionRows } = harness({
      lane: "guest",
      unread: true,
    })

    readState.focus(AGENT, SESSION)
    await settle(FOCUS_DEBOUNCE_MS)
    readState.onExecution(lifecycle("run-finished"))
    await settle(FOCUS_DEBOUNCE_MS)
    await readState.markRead(AGENT, SESSION)

    expect(mutateSession).not.toHaveBeenCalled()
    expect(onUnreadChanged).not.toHaveBeenCalled()
    expect(sessionRows.get(AGENT, SESSION)?.unread).toBe(true)
  })
})
