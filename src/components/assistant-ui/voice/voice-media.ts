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
import { VoicePlayback, type PlaybackState } from "./voice-playback"

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

type Options = {
  getUserMedia?: () => Promise<MediaStream>
  createRecorder?: (stream: MediaStream) => MediaRecorder
  createAudio?: () => HTMLAudioElement
  createMeter?: () => MicLevelMeterLike
}

/** One media owner per selected native integration; no messages or queues here. */
export class VoiceMediaController {
  readonly #options: Options
  readonly #listeners = new Set<() => void>()
  readonly #disarmListeners = new Set<() => void>()
  readonly #micLevelListeners = new Set<() => void>()
  #state: VoiceMediaState = {
    mode: readMode(),
    availability: LOADING,
    safelyIdle: false,
    retryAvailable: false,
  }
  #capture?: VoiceCapture
  #playback?: VoicePlayback
  #pendingPlaybackOwner?: VoicePlaybackOwner
  #previousPlaybackOwnerId?: string
  #audio?: HTMLAudioElement
  #meter?: MicLevelMeterLike
  #meterUnsubscribe?: () => void
  #retry?: Blob
  #operation = 0
  #captureAbort = new AbortController()
  #readTimer?: ReturnType<typeof setTimeout>

  constructor(options: Options = {}) {
    this.#options = options
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
  preparePlaybackOwner(messageId: string, messageIndex: number) {
    const scopeId = this.#state.scopeId
    if (!scopeId || messageIndex < 0) return
    const owner = { scopeId, messageId, messageIndex }
    this.#pendingPlaybackOwner = owner
    queueMicrotask(() => {
      if (this.#pendingPlaybackOwner === owner)
        this.#pendingPlaybackOwner = undefined
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
          const owner = this.#pendingPlaybackOwner
          this.#pendingPlaybackOwner = undefined
          this.stopSpeech()
          this.#audio ??= this.#options.createAudio?.() ?? new Audio()
          const playback = new VoicePlayback({
            text: services.projectText(text),
            audio: this.#audio,
            synthesize: services.synthesize,
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
    this.#pendingPlaybackOwner = undefined
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
  handleHidden = () => {
    this.disarm()
    this.#playback?.pause()
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
  #update(patch: Partial<VoiceMediaState>) {
    this.#state = { ...this.#state, ...patch }
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
