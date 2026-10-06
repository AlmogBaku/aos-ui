import type {
  DictationAdapter,
  SpeechSynthesisAdapter,
} from "@assistant-ui/react"
import {
  VoiceCapture,
  type CaptureResult,
  type CaptureState,
} from "./voice-capture"
import {
  createMicLevelMeter,
  EMPTY_MIC_LEVELS,
  type MicLevelMeterLike,
} from "./mic-level-meter"
import { ScreenWakeLock, type RequestWakeLock } from "./screen-wake-lock"
import { VoicePlayback, type PlaybackState } from "./voice-playback"
import {
  getCachedAudio,
  putCachedAudio,
  VOICE_AUDIO_TTL_MS,
} from "./voice-audio-cache"

export type VoiceMode = "transcription" | "voice-turn"
export type VoiceAvailability =
  "loading" | "ready" | "unverified" | "unconfigured" | "unavailable"
export function canAttemptSpeech(availability: VoiceAvailability | undefined) {
  return availability === "ready" || availability === "unverified"
}
export type VoiceServices = {
  transcribe: (recording: Blob, signal: AbortSignal) => Promise<string>
  synthesize: (text: string, signal: AbortSignal) => Promise<Blob>
  projectText: (text: string) => string
}
export type VoiceReadRequest = { scopeId: string; messageId: string }
export type VoicePlaybackOwner = {
  scopeId: string
  messageId: string
  messageIndex: number
}
export type VoiceAutoReadRequest = {
  scopeId: string
  baselineMessageIds: readonly string[]
}
export type VoiceMediaState = {
  scopeId?: string | undefined
  mode: VoiceMode
  availability: { transcription: VoiceAvailability; speech: VoiceAvailability }
  safelyIdle: boolean
  capture?: CaptureState | undefined
  retryAvailable: boolean
  playback?: PlaybackState | undefined
  playbackError?: PlaybackState["error"] | undefined
  playbackOwner?: VoicePlaybackOwner | undefined
  readRequest?: VoiceReadRequest | undefined
  autoReadRequest?: VoiceAutoReadRequest | undefined
}

const MODE_KEY = "aos.voice.mode.v1"
const LOADING = { transcription: "loading", speech: "loading" } as const
function readMode(): VoiceMode {
  try {
    return localStorage.getItem(MODE_KEY) === "voice-turn"
      ? "voice-turn"
      : "transcription"
  } catch {
    return "transcription"
  }
}

/** 12 ms of 8 kHz silence: the clip a tap plays to unlock the audio element. */
const SILENT_CLIP =
  "data:audio/wav;base64,UklGRogAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YWQAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA"

type Options = {
  getUserMedia?: () => Promise<MediaStream>
  createRecorder?: (stream: MediaStream) => MediaRecorder
  createAudio?: () => HTMLAudioElement
  createMeter?: () => MicLevelMeterLike
  requestWakeLock?: RequestWakeLock
}

/** One media owner per selected native integration; no messages or queues here. */
export class VoiceMediaController {
  readonly #options: Options
  readonly #listeners = new Set<() => void>()
  readonly #disarmListeners = new Set<() => void>()
  readonly #micLevelListeners = new Set<() => void>()
  readonly #wakeLock: ScreenWakeLock
  #state: VoiceMediaState = {
    mode: readMode(),
    availability: LOADING,
    safelyIdle: false,
    retryAvailable: false,
  }
  #capture?: VoiceCapture
  #playback?: VoicePlayback
  #pendingPlayback?: { owner: VoicePlaybackOwner; text: string }
  #previousPlaybackOwnerId?: string
  #audio?: HTMLAudioElement
  #audioUnlocked = false
  #meter?: MicLevelMeterLike
  #meterUnsubscribe?: () => void
  #retry?: Blob
  #operation = 0
  #captureAbort = new AbortController()
  #readTimer?: ReturnType<typeof setTimeout>

  constructor(options: Options = {}) {
    this.#options = options
    this.#wakeLock = new ScreenWakeLock(options.requestWakeLock)
  }
  getSnapshot = () => this.#state
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  subscribeDisarm = (listener: () => void) => {
    this.#disarmListeners.add(listener)
    return () => {
      this.#disarmListeners.delete(listener)
    }
  }
  getMicLevelsSnapshot = () => this.#meter?.getSnapshot() ?? EMPTY_MIC_LEVELS
  subscribeMicLevels = (listener: () => void) => {
    this.#micLevelListeners.add(listener)
    return () => this.#micLevelListeners.delete(listener)
  }
  disarm = () => {
    this.clearReadRequest()
    this.clearAutoRead()
    for (const listener of this.#disarmListeners) listener()
  }
  requestReadAloud(scopeId: string, messageId: string) {
    if (
      scopeId !== this.#state.scopeId ||
      !canAttemptSpeech(this.#state.availability.speech) ||
      this.captureActive ||
      (typeof document !== "undefined" && document.visibilityState === "hidden")
    )
      return
    this.clearReadRequest()
    this.#readTimer = setTimeout(this.clearReadRequest, 5_000)
    this.#update({ readRequest: { scopeId, messageId } })
  }
  clearReadRequest = () => {
    clearTimeout(this.#readTimer)
    this.#readTimer = undefined
    if (this.#state.readRequest) this.#update({ readRequest: undefined })
  }
  resolveAutoRead(request: VoiceAutoReadRequest, messageId: string) {
    if (request !== this.#state.autoReadRequest) return false
    this.#update({ autoReadRequest: undefined })
    this.requestReadAloud(request.scopeId, messageId)
    return true
  }
  clearAutoRead = (request?: VoiceAutoReadRequest) => {
    if (request && request !== this.#state.autoReadRequest) return
    if (this.#state.autoReadRequest)
      this.#update({ autoReadRequest: undefined })
  }
  consumeReadRequest(request: VoiceReadRequest) {
    if (request !== this.#state.readRequest) return false
    this.clearReadRequest()
    return true
  }
  /**
   * Names the message the next `speak` reads and the answer it reads: Assistant
   * UI hands the adapter every text part joined, mid-turn prose included.
   */
  preparePlaybackOwner(messageId: string, messageIndex: number, text: string) {
    const scopeId = this.#state.scopeId
    if (!scopeId || messageIndex < 0) return
    const pending = { owner: { scopeId, messageId, messageIndex }, text }
    this.#pendingPlayback = pending
    queueMicrotask(() => {
      if (this.#pendingPlayback === pending) this.#pendingPlayback = undefined
    })
  }
  reconcilePlaybackOwner(scopeId: string, previousId: string, nextId: string) {
    const owner = this.#state.playbackOwner
    if (
      owner?.scopeId === scopeId &&
      owner.messageId === previousId &&
      previousId !== nextId
    ) {
      // Native history and Assistant UI publish separately. Keep the known
      // predecessor valid only until Assistant UI exposes its replacement.
      this.#previousPlaybackOwnerId ??= previousId
      this.#update({ playbackOwner: { ...owner, messageId: nextId } })
    }
  }
  isPlaybackOwnerPresent(messageIds: readonly string[]) {
    const owner = this.#state.playbackOwner
    if (!owner) return false
    if (messageIds.includes(owner.messageId)) {
      this.#previousPlaybackOwnerId = undefined
      return true
    }
    return Boolean(
      this.#previousPlaybackOwnerId &&
      messageIds.includes(this.#previousPlaybackOwnerId)
    )
  }
  get captureSignal() {
    return this.#captureAbort.signal
  }
  get captureOperation() {
    return this.#operation
  }
  get recordingSupported() {
    return Boolean(
      this.#options.getUserMedia ||
      (typeof window !== "undefined" &&
        window.isSecureContext !== false &&
        typeof navigator.mediaDevices?.getUserMedia === "function" &&
        typeof MediaRecorder !== "undefined")
    )
  }

  setScope(scopeId: string | undefined) {
    if (this.#state.scopeId === scopeId) return
    this.cancelCapture()
    this.stopSpeech()
    this.#update({
      scopeId,
      availability: LOADING,
      safelyIdle: false,
      playback: undefined,
    })
  }
  setAvailability(
    scopeId: string,
    availability: VoiceMediaState["availability"]
  ) {
    if (scopeId === this.#state.scopeId) this.#update({ availability })
  }
  setSafelyIdle(safelyIdle: boolean) {
    if (safelyIdle !== this.#state.safelyIdle) this.#update({ safelyIdle })
  }
  setMode(mode: VoiceMode) {
    try {
      localStorage.setItem(MODE_KEY, mode)
    } catch {
      /* View preference only. */
    }
    this.#update({ mode })
  }

  createAdapters(
    scopeId: string,
    services: VoiceServices
  ): {
    dictation: DictationAdapter
    speech: SpeechSynthesisAdapter
  } {
    return {
      dictation: {
        disableInputDuringDictation: true,
        listen: () => {
          if (
            scopeId !== this.#state.scopeId ||
            !canAttemptSpeech(this.#state.availability.transcription)
          )
            throw new Error("Voice input is unavailable")
          this.stopSpeech()
          this.disarm()
          const recording = this.#retry
          this.#retry = undefined
          this.cancelCapture()
          let meter: MicLevelMeterLike | undefined
          if (!recording) {
            try {
              meter = (this.#options.createMeter ?? createMicLevelMeter)()
            } catch {
              /* Visualization support must never block recording. */
            }
          }
          this.#setMeter(meter)
          const operation = this.#operation
          this.#captureAbort = new AbortController()
          const capture = new VoiceCapture({
            ...this.#options,
            transcribe: services.transcribe,
            recording,
            meter,
            onState: (state) => {
              if (this.#operation !== operation) return
              this.#update({
                capture: state,
                retryAvailable: Boolean(
                  this.#capture?.recording && state.phase === "error"
                ),
              })
            },
          })
          this.#capture = capture
          this.#update({ capture: capture.state, retryAvailable: false })
          return capture
        },
      },
      speech: {
        speak: (text) => {
          if (
            scopeId !== this.#state.scopeId ||
            !canAttemptSpeech(this.#state.availability.speech) ||
            this.captureActive
          )
            throw new Error("Read aloud is unavailable")
          const pending = this.#pendingPlayback
          const owner = pending?.owner
          this.#pendingPlayback = undefined
          this.stopSpeech()
          const projectedText = services.projectText(pending?.text ?? text)
          const cacheKey = owner
            ? JSON.stringify([
                "v1",
                owner.scopeId,
                owner.messageId,
                projectedText,
              ])
            : undefined
          const playback = new VoicePlayback({
            text: projectedText,
            audio: this.#sharedAudio(),
            synthesize: async (speechText, signal) => {
              if (cacheKey) {
                try {
                  const cached = await getCachedAudio(cacheKey)
                  if (cached) return cached
                } catch {
                  /* Browser persistence must never block speech. */
                }
              }
              const audio = await services.synthesize(speechText, signal)
              if (cacheKey) {
                void putCachedAudio(
                  cacheKey,
                  audio,
                  Date.now() + VOICE_AUDIO_TTL_MS
                ).catch(() => {
                  /* Browser persistence must never block speech. */
                })
              }
              return audio
            },
            onState: (state) => {
              if (this.#playback !== playback) return
              if (playback.status.type === "ended") {
                this.#playback = undefined
                this.#update({
                  playback: undefined,
                  playbackError: state.error,
                  playbackOwner: undefined,
                })
              } else this.#update({ playback: state })
            },
          })
          this.#playback = playback
          this.#update({ playback: playback.state, playbackOwner: owner })
          return playback
        },
      },
    }
  }

  get captureActive() {
    return (
      this.#state.capture?.phase === "starting" ||
      this.#state.capture?.phase === "recording" ||
      this.#state.capture?.phase === "transcribing"
    )
  }
  finishCapture = async (
    reviewOnly = false
  ): Promise<
    (CaptureResult & { operation: number; scopeId: string }) | undefined
  > => {
    const operation = this.#operation
    const scopeId = this.#state.scopeId
    const result = await this.#capture?.finish(reviewOnly)
    if (!result || !scopeId || this.#operation !== operation) return undefined
    return { ...result, operation, scopeId }
  }
  prepareRetry = () => {
    if (!this.#capture?.recording || this.#state.capture?.phase !== "error")
      return false
    this.#retry = this.#capture.recording
    return true
  }
  cancelCapture = () => {
    this.#operation++
    this.#captureAbort.abort()
    this.#capture?.cancel()
    this.#capture = undefined
    this.#setMeter(undefined)
    this.#retry = undefined
    this.#update({ capture: undefined, retryAvailable: false })
    this.disarm()
  }
  stopSpeech = () => {
    const playback = this.#playback
    this.#playback = undefined
    playback?.cancel()
    this.#pendingPlayback = undefined
    this.#previousPlaybackOwnerId = undefined
    this.#update({
      playback: undefined,
      playbackError: undefined,
      playbackOwner: undefined,
    })
  }
  togglePlayback = async () => {
    await this.#playback?.toggle()
  }
  cycleRate = () => {
    this.#playback?.cycleRate()
  }
  seekPlayback = (seconds: number) => {
    this.#playback?.seek(seconds)
  }
  submitVoiceTurn = (
    baselineMessageIds: readonly string[],
    send: () => void
  ) => {
    const { scopeId, safelyIdle, availability } = this.#state
    if (
      !scopeId ||
      !safelyIdle ||
      !canAttemptSpeech(availability.transcription) ||
      !canAttemptSpeech(availability.speech)
    )
      return false
    const request = { scopeId, baselineMessageIds: [...baselineMessageIds] }
    this.#update({ autoReadRequest: request })
    try {
      send()
      return true
    } catch (error) {
      this.clearAutoRead(request)
      throw error
    }
  }
  /** Audio already playing carries on with the screen off; a waiting voice turn does not. */
  handleHidden = () => {
    this.disarm()
  }
  /** Takes the wake lock back: the browser released it while the page was hidden. */
  handleVisible = () => {
    this.#wakeLock.hold(this.#needsScreen())
  }
  /**
   * iOS starts an audio element without a tap only once that element has
   * played inside one. Called from the tap that starts a voice turn or a read
   * aloud, this plays a silent clip so the reply can play on the same element
   * long after the tap.
   */
  unlockAudio = () => {
    if (this.#audioUnlocked || this.#playback) return
    this.#audioUnlocked = true
    void this.#playSilentClip(this.#sharedAudio())
  }
  async #playSilentClip(audio: HTMLAudioElement) {
    audio.src = SILENT_CLIP
    try {
      // Called synchronously inside the tap: the await follows the call.
      await audio.play()
      if (audio.src === SILENT_CLIP) audio.pause()
    } catch (error) {
      // A read-aloud replacing the clip mid-load still leaves the element unlocked.
      if (error instanceof DOMException && error.name === "NotAllowedError")
        this.#audioUnlocked = false
    }
  }
  #sharedAudio() {
    return (this.#audio ??= this.#options.createAudio?.() ?? new Audio())
  }
  authenticationLost = () => {
    this.cancelCapture()
    this.stopSpeech()
    this.#retry = undefined
    this.#update({
      availability: { transcription: "unavailable", speech: "unavailable" },
      safelyIdle: false,
    })
  }
  dispose = () => {
    this.cancelCapture()
    this.stopSpeech()
    this.#retry = undefined
    this.#micLevelListeners.clear()
  }
  #setMeter(meter: MicLevelMeterLike | undefined) {
    this.#meterUnsubscribe?.()
    this.#meterUnsubscribe = undefined
    this.#meter = meter
    if (meter)
      this.#meterUnsubscribe = meter.subscribe(() => {
        for (const listener of this.#micLevelListeners) listener()
      })
    for (const listener of this.#micLevelListeners) listener()
  }
  /**
   * Voice work a screen turning off would stop: a recording, a voice turn
   * waiting for its reply, and audio still being generated, since playback can
   * only start on a visible page. Playback itself carries on with the screen off.
   */
  #needsScreen() {
    const { autoReadRequest, readRequest, playback } = this.#state
    return (
      this.captureActive ||
      Boolean(autoReadRequest || readRequest || playback?.loading)
    )
  }
  #update(patch: Partial<VoiceMediaState>) {
    this.#state = { ...this.#state, ...patch }
    this.#wakeLock.hold(this.#needsScreen())
    for (const listener of this.#listeners) listener()
  }
}

export function waitForCommittedTranscript(
  composer: {
    getState(): { text: string; dictation?: unknown }
    subscribe(listener: () => void): () => void
  },
  expected: string,
  signal: AbortSignal
): Promise<boolean> {
  return new Promise((resolve) => {
    let unsubscribe = () => {}
    let settled = false
    const timer = setTimeout(() => finish(false), 5_000)
    function finish(value: boolean) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      signal.removeEventListener("abort", aborted)
      resolve(value)
    }
    const aborted = () => finish(false)
    const check = () => {
      const state = composer.getState()
      if (state.text === expected && state.dictation == null) finish(true)
    }
    unsubscribe = composer.subscribe(check)
    signal.addEventListener("abort", aborted, { once: true })
    if (signal.aborted) finish(false)
    else check()
  })
}
