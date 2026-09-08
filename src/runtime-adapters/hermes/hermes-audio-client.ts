import {
  absoluteUrl,
  isRecord,
} from "@/runtime-adapters/hermes/hermes-native-codec"

export type HermesAudioClientOptions = {
  baseUrl: string
  fetcher?: typeof fetch
}

export type HermesAudioReadiness = "ready" | "unverified" | "unavailable"

export type HermesAudioAvailability = {
  transcription: HermesAudioReadiness
  speech: HermesAudioReadiness
}

export type HermesAudioErrorCode =
  | "authentication"
  | "unavailable"
  | "network"
  | "invalid-response"
  | "invalid-recording"
  | "too-large"

const errorMessages: Record<HermesAudioErrorCode, string> = {
  authentication: "Sign in to Hermes to use audio.",
  unavailable: "Hermes audio is unavailable.",
  network: "Could not reach Hermes audio.",
  "invalid-response": "Hermes returned an invalid audio response.",
  "invalid-recording": "The audio recording could not be read.",
  "too-large": "The audio recording exceeds the upload limit.",
}

/** Deliberately excludes provider messages, response bodies, and error causes. */
export class HermesAudioError extends Error {
  constructor(readonly code: HermesAudioErrorCode) {
    super(errorMessages[code])
    this.name = "HermesAudioError"
  }
}

const MAX_RECORDING_BYTES = 5 * 1024 * 1024
const recordingMime =
  /^(?:audio\/(?:aac|flac|m4a|mp3|mp4|mpeg|ogg|wav|wave|webm|x-m4a|x-wav)|video\/webm)(?:;[^,\r\n]+)*$/u

function metadataReadiness(
  value: unknown,
  name: "stt" | "tts"
): HermesAudioReadiness {
  if (
    !isRecord(value) ||
    value.name !== name ||
    value.has_category !== true ||
    !Array.isArray(value.providers) ||
    !(
      value.active_provider === null ||
      typeof value.active_provider === "string"
    )
  )
    return "unavailable"

  const providers: Array<{
    name: string
    active: boolean
    readiness: HermesAudioReadiness
    defaultEdge: boolean
  }> = []
  for (const row of value.providers) {
    if (
      !isRecord(row) ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      typeof row.is_active !== "boolean"
    ) {
      return "unavailable"
    }
    let readiness: HermesAudioReadiness
    if (row.status === "ready") readiness = "ready"
    else if (
      row.status === "needs_keys" ||
      row.status === "needs_auth" ||
      row.status === "needs_setup"
    ) {
      // Picker rows only inspect selected config/env/setup. Native speech also
      // resolves credential pools, aliases, custom providers and auto-selection.
      // A negative picker hint cannot prove that the actual endpoint is unconfigured.
      readiness = "unverified"
    } else return "unavailable"
    providers.push({
      name: row.name,
      active: row.is_active,
      readiness,
      defaultEdge: row.tts_provider === "edge",
    })
  }

  if (value.active_provider !== null) {
    const active = providers.find((row) => row.name === value.active_provider)
    return active?.active ? active.readiness : "unavailable"
  }
  if (providers.some((row) => row.active)) return "unavailable"
  // Native TTS defaults to Edge even when the picker reports no selected row.
  if (name === "tts")
    return providers.find((row) => row.defaultEdge)?.readiness ?? "unavailable"
  return "unverified"
}

function speechBlob(value: unknown): Blob {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.data_url !== "string" ||
    typeof value.mime_type !== "string" ||
    !/^audio\/(?:mpeg|ogg|wav|flac)$/u.test(value.mime_type)
  )
    throw new HermesAudioError("invalid-response")

  const prefix = `data:${value.mime_type};base64,`
  if (!value.data_url.startsWith(prefix))
    throw new HermesAudioError("invalid-response")
  const encoded = value.data_url.slice(prefix.length)
  if (
    !encoded ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  ) {
    throw new HermesAudioError("invalid-response")
  }
  try {
    const binary = atob(encoded)
    return new Blob(
      [Uint8Array.from(binary, (character) => character.charCodeAt(0))],
      { type: value.mime_type }
    )
  } catch {
    throw new HermesAudioError("invalid-response")
  }
}

export class HermesAudioClient {
  readonly #baseUrl: string
  readonly #fetch: typeof fetch

  constructor({
    baseUrl,
    fetcher = globalThis.fetch.bind(globalThis),
  }: HermesAudioClientOptions) {
    this.#baseUrl = baseUrl
    this.#fetch = fetcher
  }

  /** Configuration metadata is a hint; it does not prove live provider support. */
  async getAvailability(
    profile: string,
    signal: AbortSignal
  ): Promise<HermesAudioAvailability> {
    const [transcription, speech] = await Promise.all([
      this.#availability(profile, "stt", signal),
      this.#availability(profile, "tts", signal),
    ])
    return { transcription, speech }
  }

  async transcribe(
    profile: string,
    recording: Blob,
    signal: AbortSignal
  ): Promise<string> {
    signal.throwIfAborted()
    if (recording.size > MAX_RECORDING_BYTES) {
      throw new HermesAudioError("too-large")
    }
    if (recording.size === 0 || !recordingMime.test(recording.type)) {
      throw new HermesAudioError("invalid-recording")
    }
    let buffer: ArrayBuffer
    try {
      buffer = await recording.arrayBuffer()
    } catch {
      signal.throwIfAborted()
      throw new HermesAudioError("invalid-recording")
    }
    signal.throwIfAborted()
    const bytes = new Uint8Array(buffer)
    let binary = ""
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
    }
    const result = await this.#request(
      profile,
      "/api/audio/transcribe",
      signal,
      JSON.stringify({
        data_url: `data:${recording.type};base64,${btoa(binary)}`,
        mime_type: recording.type,
      })
    )
    if (
      !isRecord(result) ||
      result.ok !== true ||
      typeof result.transcript !== "string"
    ) {
      throw new HermesAudioError("invalid-response")
    }
    return result.transcript
  }

  async synthesize(
    profile: string,
    text: string,
    signal: AbortSignal
  ): Promise<Blob> {
    return speechBlob(
      await this.#request(
        profile,
        "/api/audio/speak",
        signal,
        JSON.stringify({ text })
      )
    )
  }

  async #availability(
    profile: string,
    name: "stt" | "tts",
    signal: AbortSignal
  ): Promise<HermesAudioReadiness> {
    try {
      return metadataReadiness(
        await this.#request(
          profile,
          `/api/tools/toolsets/${name}/config`,
          signal
        ),
        name
      )
    } catch {
      signal.throwIfAborted()
      return "unavailable"
    }
  }

  async #request(
    profile: string,
    path: string,
    signal: AbortSignal,
    body?: string
  ): Promise<unknown> {
    signal.throwIfAborted()
    if (!profile.trim()) throw new HermesAudioError("unavailable")
    const query = new URLSearchParams({ profile })
    let response: Response
    try {
      response = await this.#fetch(
        absoluteUrl(this.#baseUrl, `${path}?${query}`),
        {
          method: body === undefined ? "GET" : "POST",
          credentials: "include",
          redirect: "error",
          cache: "no-store",
          signal,
          headers: {
            accept: "application/json",
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body }),
        }
      )
    } catch {
      signal.throwIfAborted()
      throw new HermesAudioError("network")
    }
    signal.throwIfAborted()
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new HermesAudioError("authentication")
      }
      if (response.status === 413) throw new HermesAudioError("too-large")
      throw new HermesAudioError("unavailable")
    }
    try {
      const result: unknown = await response.json()
      signal.throwIfAborted()
      return result
    } catch {
      signal.throwIfAborted()
      throw new HermesAudioError("invalid-response")
    }
  }
}
