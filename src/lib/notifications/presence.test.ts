import { afterEach, describe, expect, it, vi } from "vitest"

import { PRESENCE_HEARTBEAT_MS, PRESENCE_IDLE_MS } from "@aos/protocol/push"
import { createHeartbeat, createIdleTracker } from "./presence"

afterEach(() => {
  vi.useRealTimers()
})

describe("an unattended foreground tab", () => {
  it("goes idle only after the whole idle window, and returns on input", () => {
    vi.useFakeTimers()
    const target = new EventTarget()
    const tracker = createIdleTracker({ target })
    const seen: boolean[] = []
    tracker.onChange((idle) => seen.push(idle))

    vi.advanceTimersByTime(PRESENCE_IDLE_MS - 1)
    expect(tracker.idle()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(tracker.idle()).toBe(true)
    expect(seen).toEqual([true])

    target.dispatchEvent(new Event("keydown"))
    expect(tracker.idle()).toBe(false)
    expect(seen).toEqual([true, false])
    tracker.stop()
  })

  it.each(["pointerdown", "pointermove", "wheel", "touchstart"])(
    "stays present while %s keeps arriving",
    (event) => {
      vi.useFakeTimers()
      const target = new EventTarget()
      const tracker = createIdleTracker({ target })

      for (let elapsed = 0; elapsed < PRESENCE_IDLE_MS * 2; elapsed += 30_000) {
        target.dispatchEvent(new Event(event))
        vi.advanceTimersByTime(30_000)
      }

      expect(tracker.idle()).toBe(false)
      tracker.stop()
    }
  )

  it("throttles a continuously moving pointer to one report a second", () => {
    vi.useFakeTimers()
    const target = new EventTarget()
    const tracker = createIdleTracker({ target })

    target.dispatchEvent(new Event("pointermove"))
    vi.advanceTimersByTime(500)
    // Inside the throttle window, so the idle window still runs from the first.
    target.dispatchEvent(new Event("pointermove"))
    vi.advanceTimersByTime(PRESENCE_IDLE_MS - 500)

    expect(tracker.idle()).toBe(true)
    tracker.stop()
  })

  it("stops tracking, listening, and reporting", () => {
    vi.useFakeTimers()
    const target = new EventTarget()
    const tracker = createIdleTracker({ target })
    const seen: boolean[] = []
    tracker.onChange((idle) => seen.push(idle))

    tracker.stop()
    vi.advanceTimersByTime(PRESENCE_IDLE_MS * 2)
    target.dispatchEvent(new Event("keydown"))

    expect(tracker.idle()).toBe(false)
    expect(seen).toEqual([])
  })

  it("forgets an observer that unsubscribes", () => {
    vi.useFakeTimers()
    const tracker = createIdleTracker({ target: new EventTarget() })
    const listener = vi.fn()
    tracker.onChange(listener)()

    vi.advanceTimersByTime(PRESENCE_IDLE_MS)

    expect(tracker.idle()).toBe(true)
    expect(listener).not.toHaveBeenCalled()
    tracker.stop()
  })
})

describe("the presence heartbeat", () => {
  it("reports on its cadence only while the tab is in the foreground", () => {
    vi.useFakeTimers()
    let foreground = true
    const tick = vi.fn()
    const heartbeat = createHeartbeat({ active: () => foreground, tick })

    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS)
    expect(tick).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS)
    expect(tick).toHaveBeenCalledTimes(2)

    foreground = false
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3)
    expect(tick).toHaveBeenCalledTimes(2)

    foreground = true
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS)
    expect(tick).toHaveBeenCalledTimes(3)

    heartbeat.stop()
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 2)
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it("keeps beating after a failed report", () => {
    vi.useFakeTimers()
    const tick = vi.fn(() => {
      throw new Error("report failed")
    })
    const heartbeat = createHeartbeat({ active: () => true, tick })

    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 2)

    expect(tick).toHaveBeenCalledTimes(2)
    heartbeat.stop()
  })
})
