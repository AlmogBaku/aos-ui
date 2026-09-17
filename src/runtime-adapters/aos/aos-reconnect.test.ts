import { afterEach, describe, expect, it, vi } from "vitest"

import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  reconnectDelay,
  reconnectDelayMs,
} from "./aos-reconnect"

afterEach(() => {
  vi.useRealTimers()
})

describe("bounded reconnect backoff", () => {
  it("redials immediately after a stream that delivered events", () => {
    expect(reconnectDelayMs(0, () => 1)).toBe(0)
  })

  it("grows the jitter window exponentially and caps it", () => {
    const ceilings = Array.from(
      { length: RECONNECT_MAX_ATTEMPTS },
      (_, index) => reconnectDelayMs(index + 1, () => 1)
    )

    expect(ceilings[0]).toBe(RECONNECT_BASE_DELAY_MS)
    expect(ceilings[1]).toBe(RECONNECT_BASE_DELAY_MS * 2)
    for (const [index, ceiling] of ceilings.entries()) {
      expect(ceiling).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS)
      if (index > 0)
        expect(ceiling).toBeGreaterThanOrEqual(ceilings[index - 1]!)
    }
    expect(reconnectDelayMs(30, () => 1)).toBe(RECONNECT_MAX_DELAY_MS)
  })

  it("applies full jitter between zero and the ceiling", () => {
    expect(reconnectDelayMs(3, () => 0)).toBe(0)
    expect(reconnectDelayMs(3, () => 0.5)).toBe(
      (RECONNECT_BASE_DELAY_MS * 4) / 2
    )
  })

  it("resolves the wait as soon as the caller aborts", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let settled = false
    const wait = reconnectDelay(RECONNECT_MAX_DELAY_MS, controller.signal).then(
      () => {
        settled = true
      }
    )

    await vi.advanceTimersByTimeAsync(10)
    expect(settled).toBe(false)
    controller.abort()
    await wait

    expect(settled).toBe(true)
  })
})
