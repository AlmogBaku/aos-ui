import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  AcpConnection,
  AcpConnectionOutage,
  AcpSessionState,
} from "@harness-gw/sdk"
import {
  RECONNECTED_NOTICE_MS,
  RECONNECTING_NOTICE_GRACE_MS,
  useConnectionOutage,
  useSessionNotice,
} from "./use-connection-outage"

/** The selected Session's notice over the states its subscription reports. */
function renderSessionNotice(state: AcpSessionState | undefined) {
  const view = renderHook(({ state }) => useSessionNotice("session-1", state), {
    initialProps: { state },
  })
  return {
    result: view.result,
    report: (next: AcpSessionState) => view.rerender({ state: next }),
  }
}

function fakeConnection() {
  const listeners = new Set<() => void>()
  const connection = {
    outage: undefined as AcpConnectionOutage | undefined,
    status: "ready",
    subscribeOutage(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const setOutage = (outage: AcpConnectionOutage | undefined) =>
    act(() => {
      connection.outage = outage
      for (const listener of listeners) listener()
    })
  return { connection: connection as unknown as AcpConnection, setOutage }
}

describe("useConnectionOutage", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("says reconnected for a moment once a shown outage clears", () => {
    const { connection, setOutage } = fakeConnection()
    const { result } = renderHook(() => useConnectionOutage(connection))

    setOutage("reconnecting")
    act(() => vi.advanceTimersByTime(RECONNECTING_NOTICE_GRACE_MS))
    expect(result.current).toBe("reconnecting")
    setOutage(undefined)
    expect(result.current).toBe("reconnected")
    act(() => vi.advanceTimersByTime(RECONNECTED_NOTICE_MS))
    expect(result.current).toBeUndefined()
  })

  it("stays silent through a reconnect shorter than its grace", () => {
    const { connection, setOutage } = fakeConnection()
    const { result } = renderHook(() => useConnectionOutage(connection))

    setOutage("reconnecting")
    act(() => vi.advanceTimersByTime(RECONNECTING_NOTICE_GRACE_MS - 1))
    setOutage(undefined)
    expect(result.current).toBeUndefined()
  })
})

describe("useSessionNotice", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("says a joined Session is reconnecting once its rejoin outlasts the grace, until it is joined", () => {
    const { result, report } = renderSessionNotice("joined")

    report("joining")
    act(() => vi.advanceTimersByTime(RECONNECTING_NOTICE_GRACE_MS - 1))
    expect(result.current).toBeUndefined()
    // A refused rejoin waiting out its backoff is still a rejoin.
    report("unavailable")
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe("reconnecting")
    report("joined")
    expect(result.current).toBeUndefined()
  })

  it("stays silent through a rejoin shorter than the grace", () => {
    const { result, report } = renderSessionNotice("joined")

    report("joining")
    act(() => vi.advanceTimersByTime(RECONNECTING_NOTICE_GRACE_MS - 1))
    report("joined")
    act(() => vi.advanceTimersByTime(RECONNECTING_NOTICE_GRACE_MS))
    expect(result.current).toBeUndefined()
  })

  it("never shows for a first open, however long its join takes", () => {
    const { result, report } = renderSessionNotice(undefined)

    report("joining")
    act(() => vi.advanceTimersByTime(RECONNECTING_NOTICE_GRACE_MS))
    report("unavailable")
    act(() => vi.advanceTimersByTime(RECONNECTING_NOTICE_GRACE_MS))
    expect(result.current).toBeUndefined()
  })
})
