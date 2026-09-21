/**
 * A clock and a timer queue a test steps through by hand, in the shape the push
 * coalescer and dispatcher take their `now` and `schedule` in. Nothing here runs
 * on its own: `advance` fires every callback due within the step, in due order,
 * so a window's close and a grace's expiry are observed exactly when they land.
 */
export function createTestTimers(start: number) {
  const scheduled = new Map<number, { at: number; callback: () => void }>()
  let handles = 0
  let current = start
  return {
    now: () => current,
    /** How many closes are still waiting; zero means nothing is pending. */
    pending: () => scheduled.size,
    schedule(callback: () => void, delayMs: number) {
      const handle = (handles += 1)
      scheduled.set(handle, { at: current + delayMs, callback })
      return () => {
        scheduled.delete(handle)
      }
    },
    advance(ms: number) {
      const until = current + ms
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort(([, left], [, right]) => left.at - right.at)[0]
        if (!due) break
        scheduled.delete(due[0])
        current = due[1].at
        due[1].callback()
      }
      current = until
    },
  }
}
