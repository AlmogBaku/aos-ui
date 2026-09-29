import { vi } from "vitest"

/** The slice of an audio element read-aloud drives, with spied transport. */
export class FakeAudio extends EventTarget {
  src = ""
  currentTime = 0
  duration = 24
  playbackRate = 1
  paused = true
  play = vi.fn(async () => {
    this.paused = false
    this.dispatchEvent(new Event("play"))
  })
  pause = vi.fn(() => {
    this.paused = true
    this.dispatchEvent(new Event("pause"))
  })
  load = vi.fn()
  removeAttribute = vi.fn(() => {
    this.src = ""
  })
}
