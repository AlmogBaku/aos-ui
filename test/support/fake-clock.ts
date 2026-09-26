import { onTestFinished, vi } from "vitest"

/**
 * Fakes the timers, `Date` and `performance` for the rest of the calling test.
 * Microtasks stay real, so `advance(ms)` fires every timer due within `ms` in
 * order and lets the promise continuations of each firing run before the next,
 * which is how a retry scheduled by a failed read still fires in the same
 * advance. Wait on the clock, never on `vi.waitFor`.
 */
export function useFakeClock() {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "performance",
    ],
  })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  return {
    async advance(ms: number) {
      await vi.advanceTimersByTimeAsync(ms)
    },
  }
}
