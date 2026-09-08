const BAR_COUNT = 14
const EMPTY_LEVELS = Object.freeze(
  Array.from({ length: BAR_COUNT }, () => 0)
) as readonly number[]

type AudioSourceLike = {
  connect(destination: AnalyserLike): unknown
  disconnect(): void
}

type AnalyserLike = {
  fftSize: number
  getFloatTimeDomainData(data: Float32Array<ArrayBuffer>): void
  disconnect(): void
}

type AudioContextLike = {
  state: string
  createMediaStreamSource(stream: MediaStream): AudioSourceLike
  createAnalyser(): AnalyserLike
  resume(): Promise<void>
  close(): Promise<void>
}

export type MicLevelMeterLike = {
  attach(stream: MediaStream): void
  dispose(): void
  getSnapshot(): readonly number[]
  subscribe(listener: () => void): () => void
}

type Options = {
  createContext?: () => AudioContextLike
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (handle: number) => void
  reducedMotion?: boolean
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value))
}

/** Convert current time-domain PCM into a noise-gated 0..1 loudness value. */
export function normalizedRms(samples: Float32Array): number {
  if (!samples.length) return 0
  let mean = 0
  for (const sample of samples) {
    if (!Number.isFinite(sample)) return 0
    mean += sample
  }
  mean /= samples.length
  let squareSum = 0
  for (const sample of samples) squareSum += (sample - mean) ** 2
  const rms = Math.sqrt(squareSum / samples.length)
  if (rms <= 0.001) return 0
  const decibels = 20 * Math.log10(rms)
  return Math.pow(clamp((decibels + 55) / 45), 0.75)
}

/** A transient, read-only activity store for the stream owned by VoiceCapture. */
export class MicLevelMeter implements MicLevelMeterLike {
  readonly #context: AudioContextLike
  readonly #requestFrame: (callback: FrameRequestCallback) => number
  readonly #cancelFrame: (handle: number) => void
  readonly #publishInterval: number
  readonly #listeners = new Set<() => void>()
  #snapshot = EMPTY_LEVELS
  #source?: AudioSourceLike
  #analyser?: AnalyserLike
  #samples?: Float32Array<ArrayBuffer>
  #frame?: number
  #lastFrame?: number
  #lastPublish = Number.NEGATIVE_INFINITY
  #envelope = 0
  #disposed = false
  #resumeRequested = false

  constructor(options: Options = {}) {
    this.#context =
      options.createContext?.() ??
      (new AudioContext() as unknown as AudioContextLike)
    this.#requestFrame =
      options.requestFrame ?? ((callback) => requestAnimationFrame(callback))
    this.#cancelFrame =
      options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle))
    const reduced =
      options.reducedMotion ??
      (typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches)
    this.#publishInterval = reduced ? 250 : 50
    this.#resumeContext()
  }

  getSnapshot = () => this.#snapshot

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  attach(stream: MediaStream) {
    if (this.#disposed || this.#source) return
    const analyser = this.#context.createAnalyser()
    analyser.fftSize = 1024
    const source = this.#context.createMediaStreamSource(stream)
    source.connect(analyser)
    this.#analyser = analyser
    this.#source = source
    this.#samples = new Float32Array(analyser.fftSize)
    this.#resumeContext()
    this.#frame = this.#requestFrame(this.#sample)
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#frame !== undefined) this.#cancelFrame(this.#frame)
    this.#frame = undefined
    try {
      this.#source?.disconnect()
    } catch {
      /* Already disconnected by the browser. */
    }
    try {
      this.#analyser?.disconnect()
    } catch {
      /* Already disconnected by the browser. */
    }
    void this.#context.close().catch(() => {})
    this.#listeners.clear()
    this.#source = undefined
    this.#analyser = undefined
    this.#samples = undefined
  }

  #sample = (timestamp: number) => {
    if (this.#disposed || !this.#analyser || !this.#samples) return
    this.#analyser.getFloatTimeDomainData(this.#samples)
    const target = normalizedRms(this.#samples)
    const elapsed = Math.max(
      1,
      Math.min(
        250,
        this.#lastFrame === undefined ? 50 : timestamp - this.#lastFrame
      )
    )
    const timeConstant = target > this.#envelope ? 20 : 80
    const blend = 1 - Math.exp(-elapsed / timeConstant)
    this.#envelope = clamp(this.#envelope + (target - this.#envelope) * blend)
    this.#lastFrame = timestamp
    if (timestamp - this.#lastPublish >= this.#publishInterval) {
      this.#lastPublish = timestamp
      this.#snapshot = Object.freeze([
        ...this.#snapshot.slice(1),
        this.#envelope,
      ])
      for (const listener of this.#listeners) listener()
    }
    this.#frame = this.#requestFrame(this.#sample)
  }
  #resumeContext() {
    if (this.#context.state !== "suspended" || this.#resumeRequested) return
    this.#resumeRequested = true
    void this.#context.resume().catch(() => {
      this.#resumeRequested = false
    })
  }
}

export function createMicLevelMeter(): MicLevelMeterLike {
  return new MicLevelMeter()
}

export { EMPTY_LEVELS as EMPTY_MIC_LEVELS }
