import type { Locale } from "@/lib/i18n/config"
import { VoiceMediaController } from "@/components/assistant-ui/voice/voice-media"
import { projectSpeechText } from "@/components/assistant-ui/voice/speech-text"
import { HermesAudioError, type HermesAudioClient } from "./hermes-audio-client"
import type { HermesNativeClient } from "./hermes-native-client"

type NativeVoice = Pick<
  HermesNativeClient,
  "session" | "subscribe" | "isConnected" | "subscribeConnection"
>
type NativeAudio = Pick<
  HermesAudioClient,
  "getAvailability" | "transcribe" | "synthesize"
>

/** Native ownership and configuration stay here; Assistant UI still owns the chat. */
export class HermesMediaBinding {
  readonly media: VoiceMediaController
  #metadata?: AbortController
  #profile?: string
  #threadId?: string
  #messages: readonly { id?: string; role: string }[] = []

  constructor(
    private readonly client: NativeVoice,
    private readonly audio: NativeAudio,
    private readonly locale: Locale,
    private readonly onError?: (error: Error) => void
  ) {
    this.media = new VoiceMediaController()
  }

  connect() {
    const subscriptions = [
      this.client.subscribe(this.#sync),
      this.client.subscribeConnection(() => {
        this.media.cancelCapture()
        this.media.stopSpeech()
        this.#refresh()
        this.#sync()
      }),
    ]
    this.#sync()
    return () => {
      subscriptions.forEach((unsubscribe) => unsubscribe())
      this.#metadata?.abort()
      this.#metadata = undefined
      this.#profile = undefined
      this.media.dispose()
    }
  }

  select(threadId: string | undefined) {
    if (threadId === this.#threadId) return
    this.#metadata?.abort()
    this.#profile = undefined
    this.#threadId = threadId
    this.#messages = []
    this.media.setScope(threadId)
    this.#sync()
  }

  adapters(threadId: string, profile: string) {
    // Both identifiers are immutable closures for the lifetime of an operation.
    const request = async <T>(
      signal: AbortSignal,
      action: () => Promise<T>
    ) => {
      try {
        return await action()
      } catch (error) {
        if (
          !signal.aborted &&
          threadId === this.#threadId &&
          error instanceof HermesAudioError &&
          error.code === "authentication"
        ) {
          this.#authenticationLost()
          this.onError?.(new Error("Hermes authentication failed (401)"))
        }
        throw error
      }
    }
    return this.media.createAdapters(threadId, {
      transcribe: (recording, signal) =>
        request(signal, () =>
          this.audio.transcribe(profile, recording, signal)
        ),
      synthesize: (text, signal) =>
        request(signal, () => this.audio.synthesize(profile, text, signal)),
      projectText: (text) => projectSpeechText(text, this.locale),
    })
  }

  handleNativeError = (error: Error) => {
    if (/Hermes authentication failed/u.test(error.message))
      this.#authenticationLost()
    this.onError?.(error)
  }

  #authenticationLost() {
    this.#metadata?.abort()
    this.#metadata = undefined
    this.media.authenticationLost()
  }

  #sync = () => {
    const session = this.#threadId
      ? this.client.session(this.#threadId)
      : undefined
    const messages =
      session?.messages?.map((message) => ({
        id: message.id,
        role: message.role,
      })) ?? []
    const messageIds = messages.map((message) => message.id)
    const replacements =
      this.#messages.length === messages.length
        ? this.#messages.flatMap((previous, index) => {
            const next = messages[index]
            return previous.id && next?.id && previous.id !== next.id
              ? [{ previous, next }]
              : []
          })
        : []
    const knownOptimisticReplacement =
      replacements.length > 0 &&
      replacements.every(
        ({ previous, next }) =>
          previous.role === next.role &&
          ((previous.role === "user" &&
            previous.id?.startsWith("hermes-user-")) ||
            (previous.role === "assistant" &&
              previous.id?.startsWith("hermes-assistant-"))) &&
          !messageIds.includes(previous.id)
      )
    if (knownOptimisticReplacement)
      for (const { previous, next } of replacements)
        if (previous.role === "assistant")
          this.media.reconcilePlaybackOwner(
            this.#threadId!,
            previous.id!,
            next.id!
          )
    this.#messages = messages
    const safelyIdle = Boolean(
      this.client.isConnected &&
      session?.liveSessionId &&
      session.status === "idle" &&
      !session.running &&
      !session.loading &&
      !session.approval
    )
    if (session?.approval && this.media.getSnapshot().autoReadRequest)
      this.media.disarm()
    if (
      this.media.getSnapshot().safelyIdle &&
      !safelyIdle &&
      this.media.captureActive &&
      this.media.getSnapshot().mode === "voice-turn"
    ) {
      // Activity that arrived during a voice capture converts it to review only.
      this.media.disarm()
      void this.media.finishCapture(true)
    }
    this.media.setSafelyIdle(safelyIdle)
    if (session?.profile && session.profile !== this.#profile) this.#refresh()
  }

  #refresh() {
    this.#metadata?.abort()
    const threadId = this.#threadId
    const profile = threadId
      ? this.client.session(threadId)?.profile
      : undefined
    this.#profile = profile
    if (!threadId || !profile) return
    const operation = new AbortController()
    this.#metadata = operation
    this.media.setAvailability(threadId, {
      transcription: "loading",
      speech: "loading",
    })
    void this.audio
      .getAvailability(profile, operation.signal)
      .then((availability) => {
        if (!operation.signal.aborted)
          this.media.setAvailability(threadId, availability)
      })
      .catch(() => {
        if (!operation.signal.aborted)
          this.media.setAvailability(threadId, {
            transcription: "unavailable",
            speech: "unavailable",
          })
      })
  }
}
