import { afterEach, describe, expect, it, vi } from "vitest"

import {
  CAPTURE_AUDIO_BITS_PER_SECOND,
  createVoiceRecorder,
  VoiceCapture,
  VOICE_AUDIO_CONSTRAINTS,
  MAX_CAPTURE_BYTES,
} from "./voice-capture"

class Recorder extends EventTarget {
  state: RecordingState = "inactive"
  mimeType = "audio/webm;codecs=opus"
  start = vi.fn(() => {
    this.state = "recording"
  })
  stop = vi.fn(() => {
    this.state = "inactive"
    queueMicrotask(() => this.dispatchEvent(new Event("stop")))
  })
  chunk(blob = new Blob(["audio"], { type: this.mimeType })) {
    this.dispatchEvent(
      Object.assign(new Event("dataavailable"), { data: blob })
    )
  }
}

function setup(
  transcribe = vi.fn<(recording: Blob, signal: AbortSignal) => Promise<string>>(
    async () => "Hello"
  )
) {
  const recorder = new Recorder()
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  const stream = { getTracks: () => [track] }
  const getUserMedia = vi.fn(async () => stream as unknown as MediaStream)
  const onState = vi.fn()
  const capture = new VoiceCapture({
    transcribe,
    getUserMedia,
    createRecorder: () => recorder as unknown as MediaRecorder,
    onState,
  })
  return { capture, recorder, track, transcribe, getUserMedia, onState }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("native voice capture", () => {
  it("requests a speech-efficient bitrate that fits the 15-minute ceiling", () => {
    const constructor = vi.fn()
    class BrowserRecorder extends EventTarget {
      static isTypeSupported(type: string) {
        return type === "audio/webm;codecs=opus"
      }
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super()
        constructor(stream, options)
      }
    }
    vi.stubGlobal("MediaRecorder", BrowserRecorder)
    const stream = {} as MediaStream
    createVoiceRecorder(stream)
    expect(constructor).toHaveBeenCalledWith(stream, {
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: CAPTURE_AUDIO_BITS_PER_SECOND,
    })
  })
  it("requests mono speech processing from the browser microphone", () => {
    expect(VOICE_AUDIO_CONSTRAINTS).toEqual({
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 16_000 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    })
  })
  it("does not allocate timers after a recording-state subscriber cancels", async () => {
    vi.useFakeTimers()
    const h = setup()
    h.onState.mockImplementation((state) => {
      if (state.phase === "recording") h.capture.cancel()
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(h.capture.status).toEqual({ type: "ended", reason: "cancelled" })
    expect(vi.getTimerCount()).toBe(0)
    expect(h.transcribe).not.toHaveBeenCalled()
  })
  it("commits one final transcript before ending and uses the actual MIME", async () => {
    const h = setup()
    const events: string[] = []
    h.capture.onSpeech((result) =>
      events.push(`text:${result.transcript}:${result.isFinal}`)
    )
    h.capture.onSpeechEnd(() => events.push("end"))
    await vi.waitFor(() => expect(h.recorder.start).toHaveBeenCalled())
    h.recorder.chunk()
    const first = h.capture.finish()
    const second = h.capture.finish()
    expect(await first).toEqual({ transcript: "Hello", reviewOnly: false })
    await second
    expect(events).toEqual(["text:Hello:true", "end"])
    expect(h.transcribe).toHaveBeenCalledTimes(1)
    expect(h.transcribe.mock.calls[0]?.[0]).toMatchObject({
      type: "audio/webm;codecs=opus",
    })
    expect(h.track.stop).toHaveBeenCalledTimes(1)
  })

  it("meters the identical recorded stream and leaves track ownership to capture", async () => {
    const recorder = new Recorder()
    const track = {
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    const stream = { getTracks: () => [track] } as unknown as MediaStream
    const meter = { attach: vi.fn(), dispose: vi.fn() }
    const capture = new VoiceCapture({
      getUserMedia: async () => stream,
      createRecorder: (received: MediaStream) => {
        expect(received).toBe(stream)
        return recorder as unknown as MediaRecorder
      },
      transcribe: async () => "Hello",
      onState: vi.fn(),
      meter,
    } as unknown as ConstructorParameters<typeof VoiceCapture>[0])
    await vi.waitFor(() => expect(recorder.start).toHaveBeenCalled())
    expect(meter.attach).toHaveBeenCalledWith(stream)
    capture.cancel()
    expect(meter.dispose).toHaveBeenCalledOnce()
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it("keeps recording when microphone visualization cannot attach", async () => {
    const recorder = new Recorder()
    const meter = {
      attach: vi.fn(() => {
        throw new Error("visualization unavailable")
      }),
      dispose: vi.fn(),
    }
    const capture = new VoiceCapture({
      getUserMedia: async () =>
        ({
          getTracks: () => [
            {
              stop: vi.fn(),
              addEventListener: vi.fn(),
              removeEventListener: vi.fn(),
            },
          ],
        }) as unknown as MediaStream,
      createRecorder: () => recorder as unknown as MediaRecorder,
      transcribe: async () => "Hello",
      onState: vi.fn(),
      meter,
    } as unknown as ConstructorParameters<typeof VoiceCapture>[0])
    await vi.waitFor(() => expect(recorder.start).toHaveBeenCalled())
    expect(capture.state.phase).toBe("recording")
    expect(meter.dispose).toHaveBeenCalledOnce()
    capture.cancel()
    expect(meter.dispose).toHaveBeenCalledOnce()
  })

  it("awaits delayed finalization and discards a result arriving after cancellation", async () => {
    let resolve!: (text: string) => void
    const transcribe = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done
        })
    )
    const h = setup(transcribe)
    const speech = vi.fn()
    h.capture.onSpeech(speech)
    await vi.waitFor(() => expect(h.recorder.start).toHaveBeenCalled())
    h.recorder.chunk()
    const done = h.capture.finish()
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled())
    expect(h.capture.state.phase).toBe("transcribing")
    h.capture.cancel()
    resolve("stale secret")
    expect(await done).toBeUndefined()
    expect(speech).not.toHaveBeenCalled()
    expect(h.capture.status).toEqual({ type: "ended", reason: "cancelled" })
  })

  it("releases a late permission grant without starting a recorder", async () => {
    let resolve!: (stream: MediaStream) => void
    const stop = vi.fn()
    const createRecorder = vi.fn()
    const capture = new VoiceCapture({
      getUserMedia: () =>
        new Promise((done) => {
          resolve = done
        }),
      createRecorder,
      transcribe: vi.fn(),
      onState: vi.fn(),
    })
    await Promise.resolve()
    capture.cancel()
    resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream)
    await Promise.resolve()
    expect(stop).toHaveBeenCalledOnce()
    expect(createRecorder).not.toHaveBeenCalled()
  })

  it("stops at 15 minutes into review, never a voice Send", async () => {
    vi.useFakeTimers()
    const h = setup()
    await vi.advanceTimersByTimeAsync(1)
    h.recorder.chunk()
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    expect(await h.capture.finish()).toEqual({
      transcript: "Hello",
      reviewOnly: true,
    })
    expect(h.recorder.stop).toHaveBeenCalledOnce()
  })

  it("does not upload oversized recordings or commit silence", async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.recorder.start).toHaveBeenCalled())
    h.recorder.chunk(new Blob([new Uint8Array(MAX_CAPTURE_BYTES + 1)]))
    expect(await h.capture.finish()).toBeUndefined()
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(h.capture.state.error).toBe("too-large")
    const silent = setup(vi.fn(async () => "  "))
    const speech = vi.fn()
    silent.capture.onSpeech(speech)
    await vi.waitFor(() => expect(silent.recorder.start).toHaveBeenCalled())
    silent.recorder.chunk()
    expect(await silent.capture.finish()).toBeUndefined()
    expect(speech).not.toHaveBeenCalled()
    expect(silent.capture.state.error).toBe("silence")
  })

  it("keeps the last safe chunks for review when a later chunk crosses 5 MiB", async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.recorder.start).toHaveBeenCalled())
    h.recorder.chunk(new Blob([new Uint8Array(MAX_CAPTURE_BYTES - 10)]))
    h.recorder.chunk(new Blob([new Uint8Array(20)]))
    h.recorder.chunk(new Blob([new Uint8Array(5)]))
    expect(await h.capture.finish()).toEqual({
      transcript: "Hello",
      reviewOnly: true,
    })
    expect(h.transcribe.mock.calls[0]?.[0].size).toBe(MAX_CAPTURE_BYTES - 10)
  })

  it("retains failed audio for explicit retry without requesting the microphone again", async () => {
    const failed = setup(
      vi.fn(async () => {
        throw new Error("provider payload must not be shown")
      })
    )
    await vi.waitFor(() => expect(failed.recorder.start).toHaveBeenCalled())
    failed.recorder.chunk()
    await failed.capture.finish()
    expect(failed.capture.state.error).toBe("transcription")
    expect(failed.capture.recording?.size).toBeGreaterThan(0)
    const getUserMedia = vi.fn()
    const retry = new VoiceCapture({
      recording: failed.capture.recording,
      getUserMedia,
      createRecorder: vi.fn(),
      transcribe: async () => "Retried",
      onState: vi.fn(),
    })
    const speech = vi.fn()
    retry.onSpeech(speech)
    expect(await retry.finish()).toEqual({
      transcript: "Retried",
      reviewOnly: true,
    })
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(speech).toHaveBeenCalledOnce()
  })

  it("reports permission denial without exposing the browser error", async () => {
    const capture = new VoiceCapture({
      getUserMedia: async () => {
        throw new DOMException("private device", "NotAllowedError")
      },
      createRecorder: vi.fn(),
      transcribe: vi.fn(),
      onState: vi.fn(),
    })
    await vi.waitFor(() => expect(capture.state.error).toBe("permission"))
    expect(capture.status).toEqual({ type: "ended", reason: "error" })
  })
})
