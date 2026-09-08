import type { DictationAdapter } from "@assistant-ui/react"
import type { MicLevelMeterLike } from "./mic-level-meter"

export const MAX_CAPTURE_BYTES = 5 * 1024 * 1024
export const MAX_CAPTURE_SECONDS = 15 * 60
export const CAPTURE_AUDIO_BITS_PER_SECOND = 32_000
export const VOICE_AUDIO_CONSTRAINTS = {
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 16_000 },
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} satisfies MediaTrackConstraints

export type CaptureError =
  | "permission"
  | "microphone"
  | "transcription"
  | "silence"
  | "too-large"
  | "authentication"
  | "unconfigured"
  | "unavailable"

export type CaptureState = {
  phase: "starting" | "recording" | "transcribing" | "idle" | "error"
  seconds: number
  reviewOnly: boolean
  error?: CaptureError
}

export type CaptureResult = { transcript: string; reviewOnly: boolean }

type CaptureOptions = {
  transcribe: (recording: Blob, signal: AbortSignal) => Promise<string>
  onState: (state: CaptureState) => void
  recording?: Blob | undefined
  getUserMedia?: () => Promise<MediaStream>
  createRecorder?: (stream: MediaStream) => MediaRecorder
  meter?: Pick<MicLevelMeterLike, "attach" | "dispose"> | undefined
}

export function createVoiceRecorder(stream: MediaStream) {
  const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
    (type) => MediaRecorder.isTypeSupported(type)
  )
  return new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    audioBitsPerSecond: CAPTURE_AUDIO_BITS_PER_SECOND,
  })
}

/** A single transient capture; Assistant UI consumes its final result once. */
export class VoiceCapture implements DictationAdapter.Session {
  status: DictationAdapter.Status = { type: "starting" }
  state: CaptureState = { phase: "starting", seconds: 0, reviewOnly: false }
  recording?: Blob
  readonly #options: CaptureOptions
  readonly #abort = new AbortController()
  readonly #speech = new Set<(result: DictationAdapter.Result) => void>()
  readonly #start = new Set<() => void>()
  readonly #end = new Set<(result: DictationAdapter.Result) => void>()
  readonly #result: Promise<CaptureResult | undefined>
  #resolve!: (result: CaptureResult | undefined) => void
  #stream?: MediaStream
  #recorder?: MediaRecorder
  #chunks: Blob[] = []
  #bytes = 0
  #limitExceeded = false
  #timer?: ReturnType<typeof setInterval>
  #limit?: ReturnType<typeof setTimeout>
  #finishing = false
  #reviewOnly = false
  #settled = false
  #meterActive: boolean

  constructor(options: CaptureOptions) {
    this.#options = options
    this.recording = options.recording
    this.#reviewOnly = Boolean(options.recording)
    this.#meterActive = Boolean(options.meter)
    this.#result = new Promise((resolve) => {
      this.#resolve = resolve
    })
    // The runtime registers listeners immediately after listen() returns.
    queueMicrotask(() => void this.#begin())
  }

  onSpeech = (callback: (result: DictationAdapter.Result) => void) => {
    this.#speech.add(callback)
    return () => {
      this.#speech.delete(callback)
    }
  }
  onSpeechStart = (callback: () => void) => {
    this.#start.add(callback)
    return () => {
      this.#start.delete(callback)
    }
  }
  onSpeechEnd = (callback: (result: DictationAdapter.Result) => void) => {
    this.#end.add(callback)
    return () => {
      this.#end.delete(callback)
    }
  }

  stop = async () => {
    await this.finish()
  }

  finish = (reviewOnly = false): Promise<CaptureResult | undefined> => {
    this.#reviewOnly ||= reviewOnly
    if (this.#settled || this.#finishing) return this.#result
    this.#finishing = true
    if (this.#recorder) this.#stopRecorder()
    // Permission can still be pending. #begin observes #finishing.
    else if (this.recording) void this.#transcribe()
    return this.#result
  }

  cancel = () => {
    if (this.#settled) {
      this.recording = undefined
      return
    }
    this.#abort.abort()
    this.recording = undefined
    this.#chunks = []
    this.#complete("cancelled")
    if (this.#recorder?.state !== "inactive") this.#recorder?.stop()
    this.#release()
  }

  async #begin() {
    if (this.#settled || (this.#finishing && this.recording)) return
    if (this.recording) {
      this.status = { type: "running" }
      for (const callback of this.#start) callback()
      void this.finish(true)
      return
    }
    try {
      const stream = await (this.#options.getUserMedia?.() ??
        navigator.mediaDevices.getUserMedia({
          audio: VOICE_AUDIO_CONSTRAINTS,
        }))
      if (this.#settled) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      this.#stream = stream
      try {
        this.#options.meter?.attach(stream)
      } catch {
        this.#disposeMeter()
      }
      const recorder = (this.#options.createRecorder ?? createVoiceRecorder)(
        stream
      )
      this.#recorder = recorder
      recorder.addEventListener("dataavailable", this.#onData)
      recorder.addEventListener("stop", this.#onStop)
      recorder.addEventListener("error", this.#onError)
      for (const track of stream.getTracks())
        track.addEventListener("ended", this.#onTrackEnd)
      recorder.start(250)
      this.status = { type: "running" }
      this.#update({ phase: "recording" })
      if (this.#settled) return
      for (const callback of this.#start) callback()
      if (this.#settled) return
      if (this.#finishing) {
        this.#stopRecorder()
        return
      }
      const started = Date.now()
      this.#timer = setInterval(() => {
        this.#update({
          seconds: Math.min(
            MAX_CAPTURE_SECONDS,
            Math.floor((Date.now() - started) / 1000)
          ),
        })
      }, 1000)
      this.#limit = setTimeout(() => {
        void this.finish(true)
      }, MAX_CAPTURE_SECONDS * 1000)
    } catch (error) {
      if (this.#settled) return
      this.#fail(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "permission"
          : "microphone"
      )
    }
  }

  #onData = (event: BlobEvent) => {
    if (this.#settled || event.data.size === 0) return
    if (this.#limitExceeded) return
    if (this.#bytes + event.data.size > MAX_CAPTURE_BYTES) {
      this.#limitExceeded = true
      void this.finish(true)
      return
    }
    this.#chunks.push(event.data)
    this.#bytes += event.data.size
    if (this.#bytes >= MAX_CAPTURE_BYTES) void this.finish(true)
  }
  #onStop = () => {
    if (this.#settled) return
    if (!this.#finishing) this.#reviewOnly = true
    this.#finishing = true
    if (this.#limitExceeded && this.#bytes === 0) {
      this.#chunks = []
      this.#release()
      this.#fail("too-large")
      return
    }
    this.recording = new Blob(this.#chunks, {
      type: this.#recorder?.mimeType || this.#chunks[0]?.type,
    })
    this.#chunks = []
    this.#release()
    void this.#transcribe()
  }
  #onError = () => {
    if (!this.#settled) this.#fail("microphone")
  }
  #onTrackEnd = () => {
    void this.finish(true)
  }

  #stopRecorder() {
    this.#update({ phase: "transcribing" })
    this.#clearTimers()
    if (this.#recorder?.state !== "inactive") this.#recorder?.stop()
  }

  async #transcribe() {
    if (this.#settled) return
    if (!this.recording?.size) {
      this.#fail("silence")
      return
    }
    if (this.recording.size > MAX_CAPTURE_BYTES) {
      this.recording = undefined
      this.#fail("too-large")
      return
    }
    this.#update({ phase: "transcribing" })
    if (this.#settled) return
    try {
      const transcript = (
        await this.#options.transcribe(this.recording, this.#abort.signal)
      ).trim()
      if (this.#settled) return
      if (!transcript) {
        this.#fail("silence")
        return
      }
      const result = { transcript, isFinal: true }
      // Commit before onSpeechEnd / ended status makes AUI unsubscribe.
      for (const callback of this.#speech) callback(result)
      this.recording = undefined
      this.#complete("stopped", { transcript, reviewOnly: this.#reviewOnly })
    } catch (error) {
      if (this.#settled) return
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined
      this.#fail(
        code === "authentication" ||
          code === "unconfigured" ||
          code === "unavailable"
          ? code
          : "transcription"
      )
    }
  }

  #fail(error: CaptureError) {
    this.#update({ phase: "error", error })
    this.#complete("error")
    if (this.#recorder?.state !== "inactive") this.#recorder?.stop()
    this.#release()
  }
  #complete(reason: "stopped" | "cancelled" | "error", result?: CaptureResult) {
    if (this.#settled) return
    this.#settled = true
    this.status = { type: "ended", reason }
    if (reason !== "error") this.#update({ phase: "idle" })
    for (const callback of this.#end)
      callback({ transcript: result?.transcript ?? "", isFinal: true })
    this.#resolve(result)
    this.#speech.clear()
    this.#start.clear()
    this.#end.clear()
  }
  #update(patch: Partial<CaptureState>) {
    this.state = { ...this.state, ...patch, reviewOnly: this.#reviewOnly }
    this.#options.onState(this.state)
  }
  #clearTimers() {
    clearInterval(this.#timer)
    clearTimeout(this.#limit)
  }
  #release() {
    this.#clearTimers()
    this.#disposeMeter()
    if (this.#recorder) {
      this.#recorder.removeEventListener("dataavailable", this.#onData)
      this.#recorder.removeEventListener("stop", this.#onStop)
      this.#recorder.removeEventListener("error", this.#onError)
    }
    this.#stream?.getTracks().forEach((track) => {
      track.removeEventListener("ended", this.#onTrackEnd)
      track.stop()
    })
    this.#stream = undefined
  }
  #disposeMeter() {
    if (!this.#meterActive) return
    this.#meterActive = false
    this.#options.meter?.dispose()
  }
}
