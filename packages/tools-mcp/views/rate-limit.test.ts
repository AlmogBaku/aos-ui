import { describe, expect, it } from "vitest"

import { useFakeClock } from "../../../test/support/fake-clock"
import { rateLimited } from "./rate-limit"

describe("rateLimited", () => {
  it("starts at most eight calls in any rolling second, in call order", async () => {
    const clock = useFakeClock()
    const started: number[] = []
    const send = rateLimited(async (value: number) => {
      started.push(value)
      return value * 10
    })

    const answers = Promise.all(
      Array.from({ length: 9 }, (_, value) => send(value))
    )
    await clock.advance(0)
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    await clock.advance(999)
    expect(started).toHaveLength(8)
    await clock.advance(1)

    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    await expect(answers).resolves.toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80])
  })
})
