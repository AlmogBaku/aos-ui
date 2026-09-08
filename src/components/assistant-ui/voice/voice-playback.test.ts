import { describe, expect, it, vi } from "vitest"
import { VoicePlayback } from "./voice-playback"

class AudioElement extends EventTarget {
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

function setup(
  synthesize = vi.fn(async () => new Blob(["audio"], { type: "audio/wav" }))
) {
  const audio = new AudioElement()
  const revokeObjectURL = vi.fn()
  const createObjectURL = vi.fn(() => "blob:voice")
  const onState = vi.fn()
  const playback = new VoicePlayback({
    text: "The answer",
    synthesize,
    onState,
    audio: audio as unknown as HTMLAudioElement,
    createObjectURL,
    revokeObjectURL,
  })
  return {
    playback,
    audio,
    synthesize,
    createObjectURL,
    revokeObjectURL,
    onState,
  }
}

describe("complete-audio playback", () => {
  it("never plays when a subscriber cancels during the loaded transition", async () => {
    const h = setup()
    h.onState.mockImplementation((state) => {
      if (!state.loading) h.playback.cancel()
    })
    await vi.waitFor(() => expect(h.playback.status.type).toBe("ended"))
    expect(h.audio.play).not.toHaveBeenCalled()
    expect(h.revokeObjectURL).toHaveBeenCalledOnce()
  })
  it("applies the selected speed when pending synthesis finishes", async () => {
    let resolve!: (blob: Blob) => void
    const h = setup(
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
    )
    await Promise.resolve()
    h.playback.cycleRate()
    resolve(new Blob(["audio"]))
    await vi.waitFor(() => expect(h.audio.play).toHaveBeenCalledOnce())
    expect(h.playback.state.rate).toBe(1.25)
    expect(h.audio.playbackRate).toBe(1.25)
    h.playback.cancel()
  })
  it("pauses, resumes and changes speed on the same audio without regenerating", async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.playback.state.playing).toBe(true))
    h.audio.currentTime = 5
    h.audio.dispatchEvent(new Event("timeupdate"))
    expect(h.playback.state).toMatchObject({
      elapsed: 5,
      duration: 24,
      rate: 1,
    })
    h.playback.pause()
    expect(h.playback.state.playing).toBe(false)
    expect(h.playback.status.type).toBe("running")
    await h.playback.toggle()
    expect(h.audio.currentTime).toBe(5)
    expect(h.synthesize).toHaveBeenCalledOnce()
    for (const rate of [1.25, 1.5, 2, 1]) {
      h.playback.cycleRate()
      expect(h.audio.playbackRate).toBe(rate)
    }
    h.playback.cancel()
    expect(h.revokeObjectURL).toHaveBeenCalledWith("blob:voice")
    expect(h.audio.src).toBe("")
  })

  it("keeps blocked autoplay available for an explicit Play", async () => {
    const h = setup()
    h.audio.play.mockRejectedValueOnce(
      new DOMException("blocked", "NotAllowedError")
    )
    await vi.waitFor(() => expect(h.playback.state.blocked).toBe(true))
    expect(h.playback.status.type).toBe("running")
    expect(h.playback.state.playing).toBe(false)
    await h.playback.toggle()
    expect(h.playback.state.playing).toBe(true)
    expect(h.playback.state.blocked).toBe(false)
    expect(h.synthesize).toHaveBeenCalledOnce()
    h.playback.cancel()
  })

  it("finishes the owning utterance and releases its URL on natural completion", async () => {
    const h = setup()
    const change = vi.fn()
    h.playback.subscribe(change)
    await vi.waitFor(() => expect(h.audio.play).toHaveBeenCalledOnce())
    h.audio.dispatchEvent(new Event("ended"))
    expect(h.playback.status).toEqual({ type: "ended", reason: "finished" })
    expect(change).toHaveBeenCalled()
    expect(h.revokeObjectURL).toHaveBeenCalledOnce()
    h.playback.cancel()
    expect(h.revokeObjectURL).toHaveBeenCalledOnce()
  })

  it("never plays synthesis that finishes after cancellation", async () => {
    let resolve!: (blob: Blob) => void
    const h = setup(
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
    )
    await Promise.resolve()
    h.playback.cancel()
    resolve(new Blob(["stale"]))
    await Promise.resolve()
    expect(h.audio.play).not.toHaveBeenCalled()
    expect(h.createObjectURL).not.toHaveBeenCalled()
  })

  it("hiding during synthesis keeps the result paused", async () => {
    let resolve!: (blob: Blob) => void
    const h = setup(
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
    )
    await Promise.resolve()
    h.playback.pause()
    resolve(new Blob(["audio"]))
    await vi.waitFor(() => expect(h.playback.status.type).toBe("running"))
    expect(h.audio.play).not.toHaveBeenCalled()
    await h.playback.toggle()
    expect(h.audio.play).toHaveBeenCalledOnce()
    h.playback.cancel()
  })
})
