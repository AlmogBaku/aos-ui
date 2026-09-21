import { SessionWorkspaceCapabilitiesResponseSchema } from "../../protocol"
import type { AcpLogger } from "../acp/types"
import type { ServerRuntime } from "../core/runtime"
import { redactForLog } from "../redaction"
import type { VoiceSynthesizer, VoiceTranscriber } from "./openai-compatible"
import { VoiceProviderError } from "./openai-compatible"

/**
 * Whether a configured provider stands behind the native runtime or in front of
 * it: `fallback` keeps the native answer whenever there is one, `override`
 * ignores the native side entirely.
 */
export type VoiceMode = "fallback" | "override"

export type VoiceProviders = {
  transcription?: { mode: VoiceMode; provider: VoiceTranscriber }
  speech?: { mode: VoiceMode; provider: VoiceSynthesizer }
}

type VoiceDirection = "transcription" | "speech"

/**
 * Adds proxy-side voice to one server runtime without touching the adapter.
 * Only the two audio operations, the capabilities they are advertised by, and
 * the classification of a provider failure change; every other member stays the
 * native implementation, called on the native instance.
 */
export function withVoiceProviders(
  native: ServerRuntime,
  providers: VoiceProviders,
  logger: AcpLogger
): ServerRuntime {
  const replaces = (mode: VoiceMode, nativeStatus: string) =>
    mode === "override" || nativeStatus !== "available"

  const noteFallback = (direction: VoiceDirection, error: unknown) =>
    logger.info(
      redactForLog({
        event: "voice.fallback",
        direction,
        nativeCode: native.publicError(error)?.code ?? "unclassified",
      })
    )

  const overrides: Pick<
    ServerRuntime,
    "workspaceCapabilities" | "transcribe" | "speak" | "publicError"
  > = {
    async workspaceCapabilities(agentId, publicSessionId) {
      const value = await native.workspaceCapabilities(agentId, publicSessionId)
      const parsed = SessionWorkspaceCapabilitiesResponseSchema.safeParse(value)
      // A shape this proxy cannot read is the adapter's to answer for; rewriting
      // part of it would publish a capability nothing else agrees with.
      if (!parsed.success) return value
      const content = { ...parsed.data.content }
      const { transcription, speech } = providers
      if (
        transcription &&
        replaces(transcription.mode, content.transcription.status)
      )
        content.transcription = transcription.provider.capability()
      if (speech && replaces(speech.mode, content.speech.status))
        content.speech = speech.provider.capability()
      return { ...parsed.data, content }
    },
    async transcribe(agentId, bytes, mimeType, signal) {
      const configured = providers.transcription
      if (!configured)
        return native.transcribe(agentId, bytes, mimeType, signal)
      if (configured.mode === "override")
        return configured.provider.transcribe(bytes, mimeType, signal)
      try {
        return await native.transcribe(agentId, bytes, mimeType, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        noteFallback("transcription", error)
        return configured.provider.transcribe(bytes, mimeType, signal)
      }
    },
    async speak(agentId, text, signal) {
      const configured = providers.speech
      if (!configured) return native.speak(agentId, text, signal)
      if (configured.mode === "override")
        return configured.provider.speak(text, signal)
      try {
        return await native.speak(agentId, text, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        noteFallback("speech", error)
        return configured.provider.speak(text, signal)
      }
    },
    publicError(cause) {
      return cause instanceof VoiceProviderError
        ? {
            code: cause.code,
            status: cause.code === "invalid_request" ? 400 : 503,
          }
        : native.publicError(cause)
    },
  }

  return new Proxy(native, {
    get(target, property) {
      if (Object.hasOwn(overrides, property))
        return overrides[property as keyof typeof overrides]
      // Adapters keep their state in `#private` fields, so a delegated method
      // has to stay bound to the native instance rather than to this Proxy.
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
