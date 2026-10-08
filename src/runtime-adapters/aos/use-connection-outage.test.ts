import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AcpConnection, AcpConnectionOutage } from "@harness-gw/sdk"
import {
  RECONNECTED_NOTICE_MS,
  RECONNECTING_NOTICE_GRACE_MS,
  useConnectionOutage,
} from "./use-connection-outage"

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
