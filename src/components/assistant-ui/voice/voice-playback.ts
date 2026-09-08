import type { SpeechSynthesisAdapter } from "@assistant-ui/react"

export type PlaybackState = {
  text: string
  loading: boolean
  playing: boolean
  blocked: boolean
  rate: number
  elapsed: number
  duration: number
  error?: "speech" | "authentication" | "unconfigured" | "unavailable"
}

type PlaybackOptions = {
  text: string
  audio: HTMLAudioElement
  synthesize: (text: string, signal: AbortSignal) => Promise<Blob>
  onState: (state: PlaybackState) => void
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
}

const RATES = [1, 1.25, 1.5, 2] as const

/** Fine playback controls supplement, rather than replace, AUI's utterance. */
export class VoicePlayback implements SpeechSynthesisAdapter.Utterance {
  status: SpeechSynthesisAdapter.Status = { type: "starting" }
  state: PlaybackState
  readonly #options: PlaybackOptions
  readonly #abort = new AbortController()
  readonly #listeners = new Set<() => void>()
  #url?: string
  #wantsPlay = true
  #playAttempt = 0

  constructor(options: PlaybackOptions) {
    this.#options = options
    this.state = {
      text: options.text,
      loading: true,
      playing: false,
      blocked: false,
      rate: 1,
      elapsed: 0,
      duration: 0,
    }
    queueMicrotask(() => void this.#load())
  }

  subscribe = (callback: () => void) => {
    this.#listeners.add(callback)
    if (this.status.type === "ended")
      queueMicrotask(() => {
        if (this.#listeners.has(callback)) callback()
      })
    return () => {
      this.#listeners.delete(callback)
    }
  }

  cancel = () => {
    this.#finish("cancelled")
  }

  pause = () => {
    if (this.status.type === "ended") return
    this.#wantsPlay = false
    this.#playAttempt++
    this.#options.audio.pause()
    this.#update({ playing: false })
  }

  toggle = async () => {
    if (this.status.type === "ended") return
    if (this.state.playing) this.pause()
    else {
      this.#wantsPlay = true
      if (!this.state.loading) await this.#play()
    }
  }

  cycleRate = () => {
    if (this.status.type === "ended") return
    const rate =
      RATES[
        (RATES.indexOf(this.state.rate as (typeof RATES)[number]) + 1) %
          RATES.length
      ] ?? 1
    this.#options.audio.playbackRate = rate
    this.#update({ rate })
  }

  async #load() {
    if (this.#abort.signal.aborted) return
    try {
      const blob = await this.#options.synthesize(
        this.state.text,
        this.#abort.signal
      )
      if (this.#abort.signal.aborted) return
      this.#url = (this.#options.createObjectURL ?? URL.createObjectURL)(blob)
      const audio = this.#options.audio
      audio.addEventListener("timeupdate", this.#sync)
      audio.addEventListener("durationchange", this.#sync)
      audio.addEventListener("loadedmetadata", this.#sync)
      audio.addEventListener("play", this.#sync)
      audio.addEventListener("pause", this.#sync)
      audio.addEventListener("ended", this.#ended)
      audio.addEventListener("error", this.#error)
      audio.src = this.#url
      audio.playbackRate = this.state.rate
      audio.currentTime = 0
      this.status = { type: "running" }
      this.#update({ loading: false })
      this.#sync()
      if (this.#wantsPlay) await this.#play()
    } catch (error) {
      if (this.#abort.signal.aborted) return
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined
      this.#update({
        error:
          code === "authentication" ||
          code === "unconfigured" ||
          code === "unavailable"
            ? code
            : "speech",
      })
      this.#finish("error")
    }
  }

  async #play() {
    if (this.#abort.signal.aborted) return
    const attempt = ++this.#playAttempt
    try {
      await this.#options.audio.play()
      if (this.#abort.signal.aborted || attempt !== this.#playAttempt) return
      this.#update({ playing: true, blocked: false })
    } catch {
      if (this.#abort.signal.aborted || attempt !== this.#playAttempt) return
      // Keep this exact audio/utterance for a user-gesture retry.
      this.#update({ playing: false, blocked: true })
    }
  }

  #sync = () => {
    if (this.#abort.signal.aborted) return
    const audio = this.#options.audio
    this.#update({
      elapsed: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      duration:
        Number.isFinite(audio.duration) && audio.duration >= 0
          ? audio.duration
          : 0,
      playing: !audio.paused,
    })
  }
  #ended = () => {
    this.#finish("finished")
  }
  #error = () => {
    this.#update({ error: "speech" })
    this.#finish("error")
  }

  #update(patch: Partial<PlaybackState>) {
    this.state = { ...this.state, ...patch }
    this.#options.onState(this.state)
    for (const listener of this.#listeners) listener()
  }

  #finish(reason: "finished" | "cancelled" | "error") {
    if (this.status.type === "ended") return
    this.#abort.abort()
    this.status = { type: "ended", reason }
    const audio = this.#options.audio
    audio.removeEventListener("timeupdate", this.#sync)
    audio.removeEventListener("durationchange", this.#sync)
    audio.removeEventListener("loadedmetadata", this.#sync)
    audio.removeEventListener("play", this.#sync)
    audio.removeEventListener("pause", this.#sync)
    audio.removeEventListener("ended", this.#ended)
    audio.removeEventListener("error", this.#error)
    audio.pause()
    audio.removeAttribute("src")
    audio.load()
    if (this.#url)
      (this.#options.revokeObjectURL ?? URL.revokeObjectURL)(this.#url)
    this.#url = undefined
    this.#update({ loading: false, playing: false })
    this.#listeners.clear()
  }
}
