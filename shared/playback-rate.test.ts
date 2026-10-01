import { describe, expect, it } from "vitest"

import { nextPlaybackRate } from "./playback-rate"

describe("nextPlaybackRate", () => {
  it.each([
    [1, 1.25],
    [1.25, 1.5],
    [1.5, 2],
    [2, 1],
    [1.1, 1.25],
    [0.5, 1],
    [3, 1],
  ])("steps %s× to %s×", (current, next) => {
    expect(nextPlaybackRate(current)).toBe(next)
  })
})
