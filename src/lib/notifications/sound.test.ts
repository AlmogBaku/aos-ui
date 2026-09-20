import { describe, expect, it, vi } from "vitest"

import { createActivitySoundPort } from "./sound"

const fakeAudio = () => ({
  currentTime: 1,
  play: vi.fn(async () => {}),
  pause: vi.fn(),
})

describe("the urgent sound cue", () => {
  it("stays silent until the page has seen a gesture", () => {
    const audio = fakeAudio()
    const sound = createActivitySoundPort(audio)
    sound.play()
    expect(audio.play).not.toHaveBeenCalled()
    window.dispatchEvent(new Event("pointerdown"))
    sound.play()
    expect(audio.play).toHaveBeenCalledTimes(1)
    expect(audio.currentTime).toBe(0)
  })

  it("plays from the start after a keyboard gesture and stops on demand", () => {
    const audio = fakeAudio()
    const sound = createActivitySoundPort(audio)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }))
    sound.play()
    sound.stop()
    expect(audio.play).toHaveBeenCalledTimes(1)
    expect(audio.pause).toHaveBeenCalledTimes(1)
  })

  it("swallows a refused playback and a failing element", () => {
    const audio = {
      currentTime: 0,
      play: vi.fn(() => Promise.reject(Error("gesture required"))),
      pause: vi.fn(() => {
        throw Error("detached")
      }),
    }
    const sound = createActivitySoundPort(audio)
    window.dispatchEvent(new Event("pointerdown"))
    expect(() => sound.play()).not.toThrow()
    expect(() => sound.stop()).not.toThrow()
    expect(audio.play).toHaveBeenCalledTimes(1)
  })
})
