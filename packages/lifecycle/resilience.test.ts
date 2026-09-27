import { BrokenCircuitError, BulkheadRejectedError } from "cockatiel"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { backoffDelay, boundedQueue, breaker } from "./resilience"

const pending = () => new Promise<never>(() => {})

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Record each call's rejection by name without awaiting it. */
function tracker(bounded: ReturnType<typeof boundedQueue>) {
  const rejected = new Map<string, unknown>()
  const track = (name: string, fn: () => Promise<unknown>) =>
    void bounded.execute(fn).catch((err: unknown) => rejected.set(name, err))
  return { rejected, track }
}

it("rejects a call past the running limit and the queue at once", async () => {
  const { rejected, track } = tracker(
    boundedQueue({ limit: 1, queue: 1, waitMs: 1_000 })
  )
  track("first", pending)
  track("second", pending)
  track("third", pending)

  await vi.advanceTimersByTimeAsync(0)
  expect([...rejected]).toEqual([["third", expect.any(BulkheadRejectedError)]])
})

it("rejects a call still waiting at waitMs but never a running one", async () => {
  const { rejected, track } = tracker(
    boundedQueue({ limit: 1, queue: 2, waitMs: 1_000 })
  )
  track("first", () => new Promise((resolve) => setTimeout(resolve, 500)))
  track("second", pending)
  track("third", pending)

  await vi.advanceTimersByTimeAsync(999)
  expect([...rejected]).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  expect([...rejected]).toEqual([
    ["third", expect.objectContaining({ name: "TimeoutError" })],
  ])
})

it("opens after consecutive failures and half-opens after halfOpenAfterMs", async () => {
  const circuit = breaker({ failures: 2, halfOpenAfterMs: 1_000 })
  const fail = () => Promise.reject(new Error("synthetic failure"))
  await expect(circuit.execute(fail)).rejects.toThrow("synthetic failure")
  await expect(circuit.execute(fail)).rejects.toThrow("synthetic failure")

  await vi.advanceTimersByTimeAsync(999)
  await expect(circuit.execute(() => "trial")).rejects.toBeInstanceOf(
    BrokenCircuitError
  )
  await vi.advanceTimersByTimeAsync(1)
  await expect(circuit.execute(() => "trial")).resolves.toBe("trial")
})

it("draws full-jitter delays up to min(capMs, baseMs * 2^attempt)", () => {
  const schedule = { baseMs: 100, capMs: 1_000 }
  const attempts = [0, 1, 2, 3, 4, 5]
  vi.spyOn(Math, "random").mockReturnValue(0)
  expect(attempts.map((a) => backoffDelay(a, schedule))).toEqual([
    0, 0, 0, 0, 0, 0,
  ])
  vi.spyOn(Math, "random").mockReturnValue(0.999)
  expect(attempts.map((a) => backoffDelay(a, schedule))).toEqual([
    99, 199, 399, 799, 999, 999,
  ])
})
