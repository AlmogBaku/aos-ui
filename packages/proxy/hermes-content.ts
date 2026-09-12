type NativeRecord = Record<string, unknown>

const MAX_ATTACHMENTS = 16
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
const MAX_RECORDING_BYTES = 5 * 1024 * 1024
const MAX_SPEECH_BYTES = 20 * 1024 * 1024
const MAX_SPEECH_TEXT_BYTES = 32_000
const MAX_TRANSCRIPT_BYTES = 1_000_000
const MAX_RPC_RESPONSE_BYTES = 64 * 1024
const MAX_AUDIO_CONFIG_RESPONSE_BYTES = 64 * 1024
const MAX_TRANSCRIPT_RESPONSE_BYTES = MAX_TRANSCRIPT_BYTES
const MAX_SPEECH_RESPONSE_BYTES = Math.ceil(MAX_SPEECH_BYTES / 3) * 4 + 512
const MAX_AUDIO_PROVIDERS = 32
const MAX_DATA_URL_METADATA_BYTES = 512
const SAFE_MIME =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u
const IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
])
const RECORDING_MIME_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/m4a",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
  "video/webm",
])
const RECORDING_CODECS = new Set([
  "aac",
  "flac",
  "mp3",
  "mp4a.40.2",
  "opus",
  "pcm",
  "vorbis",
])
const SPEECH_MIME = /^(?:audio\/(?:mpeg|ogg|wav|flac))$/u
const FILE_REFERENCE = /^@file:(?:`[^`\r\n]+`|"[^"\r\n]+"|'[^'\r\n]+'|[^\s]+)$/u

export type HermesContentSession = {
  agentId: string
  sessionId: string
  /** Server-only identifier for a currently attached native Session. */
  liveSessionId: string
  attached: boolean
}

export type HermesArtifactAuthority = {
  /** Resolves an already-published opaque artifact ID within this Session only. */
  reference: string
  filename: string
}

export interface HermesContentAuthority {
  requireSession(
    agentId: string,
    sessionId: string
  ): Promise<HermesContentSession>
  requireArtifact?(
    scope: HermesContentSession,
    artifactId: string
  ): Promise<HermesArtifactAuthority | undefined>
}

export interface HermesContentTransport {
  request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    maxResponseBytes: number
  ): Promise<unknown>
  /** Reads at most `maxBytes`; the native path is never returned to callers. */
  readArtifact?(
    scope: HermesContentSession,
    reference: string,
    maxBytes: number,
    maxResponseBytes: number
  ): Promise<{ bytes: Uint8Array; mimeType?: string }>
  audioConfig?(
    scope: HermesContentSession,
    kind: "stt" | "tts",
    maxResponseBytes: number
  ): Promise<unknown>
  transcribe?(
    scope: HermesContentSession,
    request: { data_url: string; mime_type: string },
    signal: AbortSignal | undefined,
    maxResponseBytes: number
  ): Promise<unknown>
  speak?(
    scope: HermesContentSession,
    text: string,
    signal: AbortSignal | undefined,
    maxResponseBytes: number
  ): Promise<unknown>
}

export type HermesContentAttachment =
  | { type: "image"; dataUrl: string; filename?: string }
  | { type: "file"; dataUrl: string; filename?: string; mimeType?: string }

export type HermesPublicAttachment =
  | { type: "image"; dataUrl: string; filename?: string }
  | { type: "file"; filename?: string; mimeType: string }

type PreparedAttachment = {
  type: "image" | "file"
  dataUrl: string
  mimeType: string
  filename?: string
  bytes: number
}

export class HermesContentScopeError extends Error {
  constructor() {
    super("Content is not available in this Agent Session scope")
    this.name = "HermesContentScopeError"
  }
}

export class HermesContentUnavailableError extends Error {
  constructor() {
    super("Hermes content operation is temporarily unavailable")
    this.name = "HermesContentUnavailableError"
  }
}

/** Server-only retry handle; it intentionally exposes no native identifiers. */
export class HermesContentCleanupRequiredError extends HermesContentUnavailableError {
  constructor(readonly retry: () => Promise<void>) {
    super()
    this.name = "HermesContentCleanupRequiredError"
  }
}

function isRecord(value: unknown): value is NativeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: NativeRecord, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function utf8BytesAtMost(value: string, maxBytes: number) {
  if (value.length === 0 || value.length > maxBytes) return undefined
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const point = value.codePointAt(index)!
    if (point > 0xffff) index += 1
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes > maxBytes) return undefined
  }
  return bytes
}

function boundedText(value: unknown, max: number) {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    return undefined
  const text = value.trim()
  return text && utf8BytesAtMost(text, max) !== undefined ? text : undefined
}

function safeFilename(value: unknown) {
  const filename = boundedText(value, 255)
  return filename && !filename.includes("\0") && !/[\\/\r\n]/u.test(filename)
    ? filename
    : undefined
}

function safeArtifactId(value: unknown) {
  const id = boundedText(value, 256)
  return id && !id.includes("\0") && !/[\\/\r\n]/u.test(id) ? id : undefined
}

function safeMimeType(value: unknown) {
  return typeof value === "string" && utf8BytesAtMost(value, 256) !== undefined
    ? SAFE_MIME.test(value)
      ? value
      : undefined
    : undefined
}

function decodedLength(encoded: string) {
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  return (encoded.length / 4) * 3 - padding
}

function validBase64(encoded: string) {
  if (encoded.length === 0 || encoded.length % 4 !== 0) return false
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  for (let index = 0; index < encoded.length - padding; index += 1) {
    const code = encoded.charCodeAt(index)
    if (!(
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f
    ))
      return false
  }
  return true
}

function safeRecordingMime(value: unknown) {
  if (typeof value !== "string" || utf8BytesAtMost(value, 128) === undefined)
    return undefined
  const separator = value.indexOf(";")
  const type = separator < 0 ? value : value.slice(0, separator)
  if (!RECORDING_MIME_TYPES.has(type)) return undefined
  if (separator < 0) return type
  const parameter = value.slice(separator + 1)
  if (!parameter.startsWith("codecs=")) return undefined
  const codec = parameter.slice("codecs=".length)
  return RECORDING_CODECS.has(codec) ? `${type};codecs=${codec}` : undefined
}

function exactDetachResult(value: unknown) {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    value.detached === true
  )
}

function parseDataUrl(value: unknown, maxBytes: number) {
  const maxEncoded = Math.ceil(maxBytes / 3) * 4
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxEncoded + MAX_DATA_URL_METADATA_BYTES
  )
    return undefined
  const separator = value.indexOf(";base64,")
  if (!value.startsWith("data:") || separator <= 5) return undefined
  const mimeType = value.slice(5, separator)
  const encoded = value.slice(separator + 8)
  if (
    !safeMimeType(mimeType) ||
    encoded.length === 0 ||
    encoded.length > maxEncoded ||
    encoded.length % 4 !== 0 ||
    decodedLength(encoded) > maxBytes ||
    !validBase64(encoded)
  )
    return undefined
  return { dataUrl: value, mimeType, bytes: decodedLength(encoded) }
}

function privateNativePath(value: unknown) {
  return boundedText(value, 4_096)
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  return btoa(binary)
}

function decodeBase64(encoded: string, maxBytes: number) {
  if (
    encoded.length === 0 ||
    encoded.length > Math.ceil(maxBytes / 3) * 4 ||
    encoded.length % 4 !== 0 ||
    decodedLength(encoded) > maxBytes ||
    !validBase64(encoded)
  )
    return undefined
  try {
    const binary = atob(encoded)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return undefined
  }
}

type AudioReadiness = {
  status: "ready" | "unverified" | "unavailable"
  reason?: string
}

function audioUnavailable(reason: string): AudioReadiness {
  return { status: "unavailable", reason }
}

function audioReadiness(value: unknown, kind: "stt" | "tts"): AudioReadiness {
  if (
    !isRecord(value) ||
    value.name !== kind ||
    value.has_category !== true ||
    !Array.isArray(value.providers) ||
    !(
      value.active_provider === null ||
      typeof value.active_provider === "string"
    )
  )
    return audioUnavailable("native-audio-config-invalid")
  if (value.providers.length > MAX_AUDIO_PROVIDERS)
    return audioUnavailable("native-audio-config-invalid")
  const providers: Array<{
    name: string
    active: boolean
    readiness: AudioReadiness
    edge: boolean
  }> = []
  for (const row of value.providers) {
    if (
      !isRecord(row) ||
      !boundedText(row.name, 256) ||
      typeof row.is_active !== "boolean"
    )
      return audioUnavailable("native-audio-config-invalid")
    const readiness: AudioReadiness =
      row.status === "ready"
        ? { status: "ready" }
        : row.status === "needs_keys"
          ? { status: "unverified", reason: "native-needs-keys" }
          : row.status === "needs_auth"
            ? { status: "unverified", reason: "native-needs-auth" }
            : row.status === "needs_setup"
              ? { status: "unverified", reason: "native-needs-setup" }
              : audioUnavailable("native-provider-unavailable")
    providers.push({
      name: String(row.name),
      active: row.is_active,
      readiness,
      edge: row.tts_provider === "edge",
    })
  }
  if (value.active_provider !== null) {
    const provider = providers.find(
      ({ name }) => name === value.active_provider
    )
    return provider?.active
      ? provider.readiness
      : audioUnavailable("native-active-provider-unavailable")
  }
  if (providers.some(({ active }) => active))
    return audioUnavailable("native-active-provider-unavailable")
  if (kind === "tts")
    return (
      providers.find(({ edge }) => edge)?.readiness ??
      audioUnavailable("native-speech-provider-unavailable")
    )
  return { status: "unverified", reason: "native-auto-selection" }
}

export function createHermesContentOperations(input: {
  authority: HermesContentAuthority
  transport: HermesContentTransport
}) {
  const requireScope = async (agentId: string, sessionId: string) => {
    let scope: unknown
    try {
      scope = await input.authority.requireSession(agentId, sessionId)
    } catch {
      throw new HermesContentScopeError()
    }
    const liveSessionId = isRecord(scope)
      ? boundedText(scope.liveSessionId, 4_096)
      : undefined
    if (
      !isRecord(scope) ||
      scope.agentId !== agentId ||
      scope.sessionId !== sessionId ||
      !liveSessionId ||
      typeof scope.attached !== "boolean"
    )
      throw new HermesContentScopeError()
    if (!scope.attached) throw new HermesContentUnavailableError()
    return {
      agentId,
      sessionId,
      liveSessionId,
      attached: scope.attached,
    }
  }
  const nativeRequest = async (
    method: string,
    params: Readonly<Record<string, unknown>>,
    maxResponseBytes = MAX_RPC_RESPONSE_BYTES
  ) => {
    try {
      return await input.transport.request(method, params, maxResponseBytes)
    } catch {
      throw new HermesContentUnavailableError()
    }
  }
  const pendingCleanups = new Map<string, Map<string, () => Promise<void>>>()
  const pendingCleanup = (agentId: string, sessionId: string) =>
    pendingCleanups.get(agentId)?.get(sessionId)
  const rememberCleanup = (
    agentId: string,
    sessionId: string,
    cleanup: () => Promise<void>
  ) => {
    const sessions = pendingCleanups.get(agentId) ?? new Map()
    sessions.set(sessionId, cleanup)
    pendingCleanups.set(agentId, sessions)
  }
  const clearCleanup = (agentId: string, sessionId: string) => {
    const sessions = pendingCleanups.get(agentId)
    if (!sessions) return
    sessions.delete(sessionId)
    if (sessions.size === 0) pendingCleanups.delete(agentId)
  }
  const prepareAttachments = (attachments: unknown): PreparedAttachment[] => {
    if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS)
      throw new HermesContentUnavailableError()
    const prepared: PreparedAttachment[] = []
    let totalBytes = 0
    for (const attachment of attachments) {
      if (!isRecord(attachment) || attachment.type === undefined)
        throw new HermesContentUnavailableError()
      const type = attachment.type === "image" ? "image" : "file"
      if (
        (type !== attachment.type && attachment.type !== "file") ||
        !hasOnlyKeys(
          attachment,
          type === "image"
            ? ["type", "dataUrl", "filename"]
            : ["type", "dataUrl", "filename", "mimeType"]
        )
      )
        throw new HermesContentUnavailableError()
      const parsed = parseDataUrl(
        attachment.dataUrl,
        type === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES
      )
      const filename = safeFilename(attachment.filename)
      if (
        !parsed ||
        (attachment.filename !== undefined && !filename) ||
        (type === "image" && !IMAGE_MIME.has(parsed.mimeType)) ||
        (type === "file" &&
          attachment.mimeType !== undefined &&
          attachment.mimeType !== parsed.mimeType)
      )
        throw new HermesContentUnavailableError()
      totalBytes += parsed.bytes
      if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES)
        throw new HermesContentUnavailableError()
      prepared.push({
        type,
        dataUrl: parsed.dataUrl,
        mimeType: parsed.mimeType,
        ...(filename ? { filename } : {}),
        bytes: parsed.bytes,
      })
    }
    return prepared
  }

  return {
    capabilities() {
      return {
        attachments: {
          status: "available" as const,
          scope: "attached-session" as const,
          inputs: ["image", "file"] as const,
          imageMimeTypes: [...IMAGE_MIME],
          fileMimeTypes: "valid-type/subtype" as const,
          maxMimeTypeBytes: 256,
          maxFilenameBytes: 255,
          maxCount: MAX_ATTACHMENTS,
          maxImageBytes: MAX_IMAGE_BYTES,
          maxFileBytes: MAX_FILE_BYTES,
          maxTotalBytes: MAX_ATTACHMENT_TOTAL_BYTES,
        },
        artifacts:
          input.authority.requireArtifact && input.transport.readArtifact
            ? {
                status: "available" as const,
                scope: "session" as const,
                maxBytes: MAX_ARTIFACT_BYTES,
              }
            : {
                status: "unavailable" as const,
                reason: "artifact-reader-unavailable",
              },
        transcription:
          input.transport.audioConfig && input.transport.transcribe
            ? {
                status: "available" as const,
                scope: "attached-session" as const,
                acceptedMimeTypes: [
                  "audio/aac",
                  "audio/flac",
                  "audio/m4a",
                  "audio/mp3",
                  "audio/mp4",
                  "audio/mpeg",
                  "audio/ogg",
                  "audio/wav",
                  "audio/wave",
                  "audio/webm",
                  "audio/x-m4a",
                  "audio/x-wav",
                  "video/webm",
                ] as const,
                mimeParameter: "codecs" as const,
                codecValues: [...RECORDING_CODECS],
                maxRecordingBytes: MAX_RECORDING_BYTES,
                maxTranscriptBytes: MAX_TRANSCRIPT_BYTES,
              }
            : {
                status: "unavailable" as const,
                reason: "native-transcription-unavailable",
              },
        speech:
          input.transport.audioConfig && input.transport.speak
            ? {
                status: "available" as const,
                scope: "attached-session" as const,
                acceptedMimeTypes: [
                  "audio/mpeg",
                  "audio/ogg",
                  "audio/wav",
                  "audio/flac",
                ] as const,
                maxTextBytes: MAX_SPEECH_TEXT_BYTES,
                maxAudioBytes: MAX_SPEECH_BYTES,
              }
            : {
                status: "unavailable" as const,
                reason: "native-speech-unavailable",
              },
      }
    },
    async stage(
      agentId: string,
      sessionId: string,
      attachments: readonly HermesContentAttachment[]
    ) {
      const prepared = prepareAttachments(attachments)
      const scope = await requireScope(agentId, sessionId)
      const queuedCleanup = pendingCleanup(agentId, sessionId)
      if (queuedCleanup)
        throw new HermesContentCleanupRequiredError(queuedCleanup)
      const images: string[] = []
      const references: string[] = []
      const publicAttachments: HermesPublicAttachment[] = []
      const cleanup = async () => {
        const results = await Promise.allSettled(
          images.map((path) =>
            nativeRequest("image.detach", {
              session_id: scope.liveSessionId,
              path,
            }).then((result) => {
              if (!exactDetachResult(result))
                throw new HermesContentUnavailableError()
            })
          )
        )
        if (results.some((result) => result.status === "rejected")) {
          rememberCleanup(agentId, sessionId, cleanup)
          throw new HermesContentUnavailableError()
        }
        clearCleanup(agentId, sessionId)
      }
      try {
        for (const attachment of prepared) {
          if (attachment.type === "image") {
            const result = await nativeRequest("image.attach_bytes", {
              session_id: scope.liveSessionId,
              content_base64: attachment.dataUrl,
              filename: attachment.filename ?? "image.png",
            })
            if (
              !isRecord(result) ||
              result.attached !== true ||
              !privateNativePath(result.path)
            )
              throw new HermesContentUnavailableError()
            images.push(String(result.path))
            publicAttachments.push({
              type: "image",
              dataUrl: attachment.dataUrl,
              ...(attachment.filename ? { filename: attachment.filename } : {}),
            })
            continue
          }
          const result = await nativeRequest("file.attach", {
            session_id: scope.liveSessionId,
            data_url: attachment.dataUrl,
            name: attachment.filename ?? "attachment",
          })
          if (
            !isRecord(result) ||
            result.attached !== true ||
            typeof result.ref_text !== "string" ||
            !FILE_REFERENCE.test(result.ref_text)
          )
            throw new HermesContentUnavailableError()
          references.push(result.ref_text)
          publicAttachments.push({
            type: "file",
            mimeType: attachment.mimeType,
            ...(attachment.filename ? { filename: attachment.filename } : {}),
          })
        }
      } catch (error) {
        if (images.length)
          try {
            await cleanup()
          } catch {
            throw new HermesContentCleanupRequiredError(cleanup)
          }
        throw error instanceof HermesContentCleanupRequiredError
          ? error
          : new HermesContentUnavailableError()
      }
      return {
        public: publicAttachments,
        appendTo(text: string) {
          return [text.trim(), ...references].filter(Boolean).join("\n")
        },
        cleanup,
      }
    },
    async artifact(agentId: string, sessionId: string, artifactId: string) {
      const scope = await requireScope(agentId, sessionId)
      const id = safeArtifactId(artifactId)
      if (
        !id ||
        !input.authority.requireArtifact ||
        !input.transport.readArtifact
      )
        throw new HermesContentScopeError()
      let artifact: HermesArtifactAuthority | undefined
      try {
        artifact = await input.authority.requireArtifact(scope, id)
      } catch {
        throw new HermesContentScopeError()
      }
      if (!isRecord(artifact)) throw new HermesContentScopeError()
      const filename = safeFilename(artifact.filename)
      const reference = privateNativePath(artifact.reference)
      if (!filename || !reference) throw new HermesContentScopeError()
      let result: unknown
      try {
        result = await input.transport.readArtifact(
          scope,
          reference,
          MAX_ARTIFACT_BYTES,
          MAX_ARTIFACT_BYTES
        )
      } catch {
        throw new HermesContentUnavailableError()
      }
      if (
        !isRecord(result) ||
        !(result.bytes instanceof Uint8Array) ||
        result.bytes.length === 0 ||
        result.bytes.length > MAX_ARTIFACT_BYTES ||
        (result.mimeType !== undefined && !safeMimeType(result.mimeType))
      )
        throw new HermesContentUnavailableError()
      const mimeType = safeMimeType(result.mimeType)
      return {
        bytes: result.bytes,
        ...(mimeType ? { mimeType } : {}),
        filename,
      }
    },
    async audio(agentId: string, sessionId: string) {
      const scope = await requireScope(agentId, sessionId)
      if (!input.transport.audioConfig)
        return {
          transcription: audioUnavailable("native-audio-config-unavailable"),
          speech: audioUnavailable("native-audio-config-unavailable"),
        }
      const read = async (kind: "stt" | "tts") => {
        if (kind === "stt" && !input.transport.transcribe)
          return audioUnavailable("native-transcription-unavailable")
        if (kind === "tts" && !input.transport.speak)
          return audioUnavailable("native-speech-unavailable")
        try {
          return audioReadiness(
            await input.transport.audioConfig!(
              scope,
              kind,
              MAX_AUDIO_CONFIG_RESPONSE_BYTES
            ),
            kind
          )
        } catch {
          return audioUnavailable("native-audio-config-unavailable")
        }
      }
      const [transcription, speech] = await Promise.all([
        read("stt"),
        read("tts"),
      ])
      return { transcription, speech }
    },
    async transcribe(
      agentId: string,
      sessionId: string,
      bytes: Uint8Array,
      mimeType: string,
      signal?: AbortSignal
    ) {
      signal?.throwIfAborted()
      const scope = await requireScope(agentId, sessionId)
      signal?.throwIfAborted()
      const recordingMime = safeRecordingMime(mimeType)
      if (
        !input.transport.transcribe ||
        !(bytes instanceof Uint8Array) ||
        bytes.length === 0 ||
        bytes.length > MAX_RECORDING_BYTES ||
        !recordingMime
      )
        throw new HermesContentUnavailableError()
      signal?.throwIfAborted()
      let result: unknown
      try {
        result = await input.transport.transcribe(
          scope,
          {
            data_url: `data:${recordingMime};base64,${bytesToBase64(bytes)}`,
            mime_type: recordingMime,
          },
          signal,
          MAX_TRANSCRIPT_RESPONSE_BYTES
        )
      } catch {
        signal?.throwIfAborted()
        throw new HermesContentUnavailableError()
      }
      signal?.throwIfAborted()
      if (
        !isRecord(result) ||
        result.ok !== true ||
        typeof result.transcript !== "string" ||
        utf8BytesAtMost(result.transcript, MAX_TRANSCRIPT_BYTES) === undefined
      )
        throw new HermesContentUnavailableError()
      return result.transcript
    },
    async speak(
      agentId: string,
      sessionId: string,
      text: string,
      signal?: AbortSignal
    ) {
      signal?.throwIfAborted()
      const scope = await requireScope(agentId, sessionId)
      signal?.throwIfAborted()
      const safeText = boundedText(text, MAX_SPEECH_TEXT_BYTES)
      if (!input.transport.speak || !safeText)
        throw new HermesContentUnavailableError()
      let result: unknown
      try {
        result = await input.transport.speak(
          scope,
          safeText,
          signal,
          MAX_SPEECH_RESPONSE_BYTES
        )
      } catch {
        signal?.throwIfAborted()
        throw new HermesContentUnavailableError()
      }
      signal?.throwIfAborted()
      if (
        !isRecord(result) ||
        result.ok !== true ||
        typeof result.data_url !== "string" ||
        typeof result.mime_type !== "string" ||
        !SPEECH_MIME.test(result.mime_type)
      )
        throw new HermesContentUnavailableError()
      const prefix = `data:${result.mime_type};base64,`
      if (
        result.data_url.length > prefix.length + MAX_SPEECH_RESPONSE_BYTES ||
        !result.data_url.startsWith(prefix)
      )
        throw new HermesContentUnavailableError()
      const bytes = decodeBase64(
        result.data_url.slice(prefix.length),
        MAX_SPEECH_BYTES
      )
      if (!bytes) throw new HermesContentUnavailableError()
      return { bytes, mimeType: result.mime_type }
    },
  }
}
