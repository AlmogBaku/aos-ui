import { describe, expect, it, vi } from "vitest"
import { VoiceMediaController, waitForCommittedTranscript } from "./voice-media"
import { FakeAudio } from "./voice.test-helpers"

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
    const { recorder, track, ...microphone } = fakeMicrophone()
    const media = new VoiceMediaController(microphone)
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

  it("keeps reading aloud when the page becomes hidden", async () => {
    const audio = new FakeAudio()
    const media = new VoiceMediaController({
      createAudio: () => audio as unknown as HTMLAudioElement,
    })
    media.setScope("one")
    media.setAvailability("one", { transcription: "ready", speech: "ready" })
    const adapters = media.createAdapters("one", {
      transcribe: vi.fn(),
      synthesize: async () => new Blob(["audio"]),
      projectText: (text) => text,
    })
    adapters.speech.speak("Keep reading this answer")
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce())

    media.handleHidden()

    expect(audio.pause).not.toHaveBeenCalled()
    expect(audio.paused).toBe(false)
    media.dispose()
  })

  it("plays a silent clip inside the tap on the element a later reply plays on", async () => {
    const created: FakeAudio[] = []
    const media = new VoiceMediaController({
      createAudio: () => {
        const audio = new FakeAudio()
        created.push(audio)
        return audio as unknown as HTMLAudioElement
      },
    })
    media.setScope("one")
    media.setAvailability("one", { transcription: "ready", speech: "ready" })

    media.unlockAudio()

    // Synchronously, before the tap's handler returns.
    expect(created).toHaveLength(1)
    expect(created[0]!.play).toHaveBeenCalledOnce()
    const adapters = media.createAdapters("one", {
      transcribe: vi.fn(),
      synthesize: async () => new Blob(["audio"]),
      projectText: (text) => text,
    })
    adapters.speech.speak("The reply")
    await vi.waitFor(() => expect(created[0]!.play).toHaveBeenCalledTimes(2))
    expect(created).toHaveLength(1)
    expect(created[0]!.paused).toBe(false)
    media.dispose()
  })

  it("keeps the screen on while recording, while a voice turn waits, and until its audio plays", async () => {
    const locks: { released: boolean; release: () => Promise<void> }[] = []
    const held = () => locks.filter((lock) => !lock.released).length
    let finishSynthesis!: (audio: Blob) => void
    const media = new VoiceMediaController({
      ...fakeMicrophone(),
      createAudio: () => new FakeAudio() as unknown as HTMLAudioElement,
      requestWakeLock: async () => {
        const lock = {
          released: false,
          release: async () => {
            lock.released = true
          },
        }
        locks.push(lock)
        return lock
      },
    })
    media.setScope("one")
    media.setAvailability("one", { transcription: "ready", speech: "ready" })
    media.setSafelyIdle(true)
    const adapters = media.createAdapters("one", {
      transcribe: vi.fn(),
      synthesize: () =>
        new Promise((resolve) => {
          finishSynthesis = resolve
        }),
      projectText: (text) => text,
    })

    const session = adapters.dictation.listen()
    await vi.waitFor(() => expect(held()).toBe(1))
    session.cancel()
    await vi.waitFor(() => expect(held()).toBe(0))

    expect(media.submitVoiceTurn(["existing"], vi.fn())).toBe(true)
    await vi.waitFor(() => expect(held()).toBe(1))
    media.resolveAutoRead(media.getSnapshot().autoReadRequest!, "reply")
    media.consumeReadRequest(media.getSnapshot().readRequest!)
    adapters.speech.speak("The reply")
    await Promise.resolve()
    // Handing over from the wait to the synthesis kept the same lock.
    expect(locks).toHaveLength(2)
    expect(held()).toBe(1)
    // The browser drops the lock while the page is hidden.
    locks[1]!.released = true
    media.handleVisible()
    await vi.waitFor(() => expect(held()).toBe(1))

    finishSynthesis(new Blob(["audio"]))
    await vi.waitFor(() =>
      expect(media.getSnapshot().playback?.playing).toBe(true)
    )
    await vi.waitFor(() => expect(held()).toBe(0))
    media.dispose()
  })
})

/** A microphone that records until stopped, with spied tracks. */
function fakeMicrophone() {
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
  return {
    recorder,
    track,
    getUserMedia: async () =>
      ({ getTracks: () => [track] }) as unknown as MediaStream,
    createRecorder: () => recorder as unknown as MediaRecorder,
  }
}
