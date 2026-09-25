import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { Deadline } from "./deadline"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

it("aborts its signal at the deadline", async () => {
  const deadline = new Deadline(1_000)
  const settled = expect(
    deadline.run(() => new Promise(() => {}))
  ).rejects.toMatchObject({ name: "TimeoutError" })

  vi.advanceTimersByTime(999)
  expect(deadline.signal.aborted).toBe(false)
  vi.advanceTimersByTime(1)
  expect(deadline.signal.aborted).toBe(true)
  await settled
})

it("leaves no timer behind once the work settles", async () => {
  const deadline = new Deadline(1_000)

  await expect(deadline.run(async () => "read")).resolves.toBe("read")
  expect(vi.getTimerCount()).toBe(0)
})
