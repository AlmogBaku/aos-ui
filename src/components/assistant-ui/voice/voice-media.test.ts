import { describe, expect, it, vi } from "vitest"
import { VoiceMediaController, waitForCommittedTranscript } from "./voice-media"

describe("voice ownership", () => {
  it("queues only an exact current reply and consumes it once", () => {
    const media = new VoiceMediaController()
    media.setScope("one")
    media.setAvailability("one", { transcription: "ready", speech: "ready" })
    media.requestReadAloud("other", "wrong")
    expect(media.getSnapshot().readRequest).toBeUndefined()
    media.requestReadAloud("one", "exact-answer")
    const request = media.getSnapshot().readRequest!
    expect(request).toEqual({ scopeId: "one", messageId: "exact-answer" })
    expect(media.consumeReadRequest(request)).toBe(true)
    expect(media.consumeReadRequest(request)).toBe(false)
    media.requestReadAloud("one", "another")
    media.disarm()
    expect(media.getSnapshot().readRequest).toBeUndefined()
    media.requestReadAloud("one", "hidden")
    const pendingSend = media.captureSignal
    media.handleHidden()
    expect(pendingSend.aborted).toBe(true)
    expect(media.getSnapshot().readRequest).toBeUndefined()
    media.dispose()
  })

  it("disarms a pending runtime-agnostic PTT read", () => {
    const media = new VoiceMediaController()
    media.setScope("one")
    media.setAvailability("one", {
      transcription: "ready",
      speech: "ready",
    })
    media.setSafelyIdle(true)

    expect(media.submitVoiceTurn(["existing"], vi.fn())).toBe(true)
    expect(media.getSnapshot().autoReadRequest).toEqual({
      scopeId: "one",
      baselineMessageIds: ["existing"],
    })

    media.disarm()

    expect(media.getSnapshot().autoReadRequest).toBeUndefined()
    media.dispose()
  })
  it("keeps availability independent and never requests a microphone to switch modes", () => {
    const mic = vi.fn()
    const media = new VoiceMediaController({ getUserMedia: mic })
    media.setScope("one")
    media.setAvailability("one", {
      transcription: "ready",
      speech: "unconfigured",
    })
    media.setMode("voice-turn")
    expect(media.getSnapshot()).toMatchObject({
      mode: "voice-turn",
      availability: { transcription: "ready", speech: "unconfigured" },
    })
    expect(mic).not.toHaveBeenCalled()
    media.setScope("two")
    media.setAvailability("one", { transcription: "ready", speech: "ready" })
    expect(media.getSnapshot().availability.transcription).toBe("loading")
    media.dispose()
  })

  it("invalidates pending capture on scope changes and disarms automatic reading", async () => {
    const stop = vi.fn()
    let resolve!: (stream: MediaStream) => void
    const media = new VoiceMediaController({
      getUserMedia: () =>
        new Promise((done) => {
          resolve = done
        }),
    })
    media.setScope("one")
    media.setAvailability("one", { transcription: "ready", speech: "ready" })
    const disarm = vi.fn()
    media.subscribeDisarm(disarm)
    const adapters = media.createAdapters("one", {
      transcribe: vi.fn(),
      synthesize: vi.fn(),
      projectText: (text) => text,
    })
    const session = adapters.dictation.listen()
    await Promise.resolve()
    media.setScope("two")
    resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream)
    await Promise.resolve()
    expect(stop).toHaveBeenCalledOnce()
    expect(session.status).toEqual({ type: "ended", reason: "cancelled" })
    expect(disarm).toHaveBeenCalled()
    expect(media.getSnapshot().capture).toBeUndefined()
    media.dispose()
  })

  it("waits for the committed composer text and completed dictation", async () => {
    const listeners = new Set<() => void>()
    let state: { text: string; dictation?: object } = {
      text: "",
      dictation: {},
    }
    const abort = new AbortController()
    const done = vi.fn()
    const result = waitForCommittedTranscript(
      {
        getState: () => state,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      },
      "Final",
      abort.signal
    ).then(done)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    state = { text: "Final", dictation: {} }
    listeners.forEach((listener) => listener())
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    state = { text: "Final" }
    listeners.forEach((listener) => listener())
    await result
    expect(done).toHaveBeenCalledWith(true)
    expect(listeners.size).toBe(0)
  })

  it("aborts waiting for stale composer text", async () => {
    const abort = new AbortController()
    const unsubscribe = vi.fn()
    const result = waitForCommittedTranscript(
      { getState: () => ({ text: "" }), subscribe: () => unsubscribe },
      "Final",
      abort.signal
    )
    abort.abort()
    expect(await result).toBe(false)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it("keeps recording when the page becomes hidden until the user stops", async () => {
    const recorder = new (class extends EventTarget {
      state: RecordingState = "inactive"
      mimeType = "audio/webm"
      start = vi.fn(() => {
        this.state = "recording"
      })
      stop = vi.fn(() => {
        this.state = "inactive"
      })
    })()
    const track = {
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    const media = new VoiceMediaController({
      getUserMedia: async () =>
        ({ getTracks: () => [track] }) as unknown as MediaStream,
      createRecorder: () => recorder as unknown as MediaRecorder,
    })
    media.setScope("one")
    media.setAvailability("one", {
      transcription: "ready",
      speech: "ready",
    })
    const adapters = media.createAdapters("one", {
      transcribe: vi.fn(),
      synthesize: vi.fn(),
      projectText: (text) => text,
    })
    const session = adapters.dictation.listen()
    await vi.waitFor(() => expect(recorder.start).toHaveBeenCalledOnce())
    const signal = media.captureSignal
    media.handleHidden()
    expect(signal.aborted).toBe(false)
    expect(recorder.stop).not.toHaveBeenCalled()
    expect(media.getSnapshot().capture?.phase).toBe("recording")
    session.cancel()
    expect(track.stop).toHaveBeenCalledOnce()
  })
})
