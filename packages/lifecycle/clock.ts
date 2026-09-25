/** A monotonic clock and its timers; injected so fake timers can drive it. */
export type Clock = {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

/** `performance.now()` and the global timers, looked up on every call. */
export const defaultClock: Clock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id as Parameters<typeof clearTimeout>[0]),
}
