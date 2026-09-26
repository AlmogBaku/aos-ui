import { expect, vi } from "vitest"

import type { LogCapture } from "./log-capture"

/**
 * The subset of the test harness the leak oracle reads: log capture,
 * coordinator gauges, channel membership count, and observer count. The
 * proxy harness satisfies this directly; a browser-side row passes its
 * `connectBrowser(await harness()).test`.
 */
type LeakTarget = {
  logs: LogCapture
  coordinator: {
    gauges(): { executions: number; uncertain: number }
  }
  channels: { memberships(): number }
  observers(): number
}

/**
 * Asserts that no resource was leaked after a fault and its cleanup:
 *
 * - **Paired transitions** – every connection owner that left its initial
 *   `handshaking` state also reached its terminal `closed` state.
 * - **No pending timers** – `vi.getTimerCount()` equals `timerBaseline`
 *   (zero when all connections and the harness are closed; pass a non-zero
 *   value when the test keeps a long-running timer alive by design, e.g., an
 *   open liveness timer).
 * - **Coordinator gauges** – no live executions, no uncertain turns.
 * - **Channel memberships** – no live memberships.
 * - **Observers** – no activity or invalidation listeners.
 *
 * Call after every connection and the harness have been closed, or after
 * advancing the clock past all backoff bounds and calling `test.close()`.
 */
export function assertLeakFree(test: LeakTarget, timerBaseline = 0): void {
  // Every connection that departed its initial handshaking state must have
  // reached the terminal closed state. Connections never re-enter handshaking,
  // so departure count equals instance count.
  const cxn = test.logs.transitions({ owner: "connection" })
  const connectionsOpened = cxn.filter(([from]) => from === "handshaking").length
  const connectionsClosed = cxn.filter(([, to]) => to === "closed").length
  expect(connectionsOpened, "connections: opened === closed").toBe(
    connectionsClosed
  )

  // No pending fake timers: a leaked `after` delay or a forgotten clearTimeout
  // shows up here.
  expect(vi.getTimerCount(), "pending fake timers").toBe(timerBaseline)

  // Coordinator gauges: every execution and uncertain turn has settled.
  const { executions, uncertain } = test.coordinator.gauges()
  expect(executions, "live executions").toBe(0)
  expect(uncertain, "uncertain turns").toBe(0)

  // All memberships left their channels.
  expect(test.channels.memberships(), "live channel memberships").toBe(0)

  // All activity and invalidation listeners were released.
  expect(test.observers(), "live observers").toBe(0)
}
