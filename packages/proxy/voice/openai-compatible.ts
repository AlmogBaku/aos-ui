import type { z } from "zod"

import type { SessionWorkspaceCapabilitiesResponseSchema } from "../../protocol"
import {
  MAX_RECORDING_BYTES,
  MAX_SPEECH_BYTES,
  MAX_SPEECH_TEXT_BYTES,
  MAX_TRANSCRIPT_BYTES,
  parseRecordingMime,
  RECORDING_CODECS,
  RECORDING_MIME_TYPES,
} from "../../protocol/audio"

type WorkspaceContent = z.infer<
  typeof SessionWorkspaceCapabilitiesResponseSchema
>["content"]

export type TranscriptionCapability = Extract<
  WorkspaceContent["transcription"],
  { status: "available" }
>
export type SpeechCapability = Extract<
  WorkspaceContent["speech"],
  { status: "available" }
>

export type SpeechFormat = "mp3" | "opus" | "wav" | "flac"

export type OpenAiCompatibleTranscriptionOptions = {
  /** Base URL including the version segment, as in `https://host/v1`. */
  baseUrl: string
  model: string
  language?: string
  timeoutMs: number
}

export type OpenAiCompatibleSpeechOptions = {
  /** Base URL including the version segment, as in `https://host/v1`. */
  baseUrl: string
  model: string
  voice: string
  format: SpeechFormat
  timeoutMs: number
}

/**
 * The only failure a voice provider reports. `invalid_request` is the browser's
 * to fix and `temporarily_unavailable` is everything else; the message repeats
 * the code so no upstream body text can reach a log or a client.
 */
export class VoiceProviderError extends Error {
  constructor(readonly code: "invalid_request" | "temporarily_unavailable") {
    super(code)
    this.name = "VoiceProviderError"
  }
}

export type VoiceTranscriber = {
  capability(): TranscriptionCapability
  transcribe(
    bytes: Uint8Array,
    mimeType: string,
    signal?: AbortSignal
  ): Promise<string>
}

export type VoiceSynthesizer = {
  capability(): SpeechCapability
  speak(
    text: string,
    signal?: AbortSignal
  ): Promise<{ bytes: Uint8Array; mimeType: string }>
}

const MAX_TRANSCRIPTION_RESPONSE_BYTES = 1024 * 1024

/** The filename extension a provider infers the container from. */
const RECORDING_EXTENSION: Record<string, string> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/m4a": "m4a",
  "audio/mp3": "mp3",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/webm": "webm",
  "audio/x-m4a": "m4a",
  "audio/x-wav": "wav",
  "video/webm": "webm",
}

/** What a requested speech format actually is, whatever the upstream claims. */
const SPEECH_FORMAT_MIME: Record<SpeechFormat, string> = {
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).length
}

async function post(
  fetchImpl: typeof fetch,
  url: string,
  body: FormData | string,
  apiKey: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal
) {
  signal?.throwIfAborted()
  const timeout = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: {
        ...(typeof body === "string"
          ? { "content-type": "application/json" }
          : {}),
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch {
    // A caller who stopped waiting keeps their own reason; a timeout, a refused
    // connection, and a redirect are one outage to everyone else.
    signal?.throwIfAborted()
    throw new VoiceProviderError("temporarily_unavailable")
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new VoiceProviderError("temporarily_unavailable")
  }
  return response
}

/** Reads at most `maxBytes` of a response, refusing anything longer. */
async function boundedBytes(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
) {
  if (!response.body) throw new VoiceProviderError("temporarily_unavailable")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength > maxBytes - total)
        throw new VoiceProviderError("temporarily_unavailable")
      chunks.push(value)
      total += value.byteLength
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    signal?.throwIfAborted()
    throw error instanceof VoiceProviderError
      ? error
      : new VoiceProviderError("temporarily_unavailable")
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export function createOpenAiCompatibleTranscriber(
  options: OpenAiCompatibleTranscriptionOptions,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch
): VoiceTranscriber {
  return {
    capability() {
      return {
        status: "available",
        scope: "agent",
        acceptedMimeTypes: [...RECORDING_MIME_TYPES],
        mimeParameter: "codecs",
        codecValues: [...RECORDING_CODECS],
        maxRecordingBytes: MAX_RECORDING_BYTES,
        maxTranscriptBytes: MAX_TRANSCRIPT_BYTES,
      }
    },
    async transcribe(bytes, mimeType, signal) {
      signal?.throwIfAborted()
      // The provider infers the container from the bare type and the filename.
      const bareMime = parseRecordingMime(mimeType)?.type
      if (!bareMime || bytes.length === 0 || bytes.length > MAX_RECORDING_BYTES)
        throw new VoiceProviderError("invalid_request")
      const form = new FormData()
      form.set(
        "file",
        new Blob([bytes], { type: bareMime }),
        `recording.${RECORDING_EXTENSION[bareMime]}`
      )
      form.set("model", options.model)
      form.set("response_format", "json")
      if (options.language) form.set("language", options.language)
      const response = await post(
        fetchImpl,
        `${options.baseUrl}/audio/transcriptions`,
        form,
        apiKey,
        options.timeoutMs,
        signal
      )
      const body = await boundedBytes(
        response,
        MAX_TRANSCRIPTION_RESPONSE_BYTES,
        signal
      )
      let payload: unknown
      try {
        payload = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(body)
        )
      } catch {
        throw new VoiceProviderError("temporarily_unavailable")
      }
      const text =
        typeof payload === "object" && payload !== null
          ? (payload as { text?: unknown }).text
          : undefined
      if (typeof text !== "string" || utf8Bytes(text) > MAX_TRANSCRIPT_BYTES)
        throw new VoiceProviderError("temporarily_unavailable")
      return text
    },
  }
}

export function createOpenAiCompatibleSynthesizer(
  options: OpenAiCompatibleSpeechOptions,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch
): VoiceSynthesizer {
  const mimeType = SPEECH_FORMAT_MIME[options.format]

  return {
    capability() {
      return {
        status: "available",
        scope: "agent",
        acceptedMimeTypes: [mimeType],
        maxTextBytes: MAX_SPEECH_TEXT_BYTES,
        maxAudioBytes: MAX_SPEECH_BYTES,
      }
    },
    async speak(text, signal) {
      signal?.throwIfAborted()
      const textBytes = utf8Bytes(text)
      if (textBytes === 0 || textBytes > MAX_SPEECH_TEXT_BYTES)
        throw new VoiceProviderError("invalid_request")
      const response = await post(
        fetchImpl,
        `${options.baseUrl}/audio/speech`,
        JSON.stringify({
          model: options.model,
          input: text,
          voice: options.voice,
          response_format: options.format,
        }),
        apiKey,
        options.timeoutMs,
        signal
      )
      const bytes = await boundedBytes(response, MAX_SPEECH_BYTES, signal)
      if (bytes.length === 0)
        throw new VoiceProviderError("temporarily_unavailable")
      return { bytes, mimeType }
    },
  }
}
