type NativeRecord = Record<string, unknown>

const MAX_ATTACHMENTS = 16
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
const MAX_RECORDING_BYTES = 5 * 1024 * 1024
const MAX_SPEECH_BYTES = 20 * 1024 * 1024
const MAX_SPEECH_TEXT_LENGTH = 32_000
const MAX_TRANSCRIPT_LENGTH = 1_000_000
const SAFE_MIME =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u
const IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
])
const RECORDING_MIME =
  /^(?:audio\/(?:aac|flac|m4a|mp3|mp4|mpeg|ogg|wav|wave|webm|x-m4a|x-wav)|video\/webm)(?:;[^,\r\n]+)*$/u
const SPEECH_MIME = /^(?:audio\/(?:mpeg|ogg|wav|flac))$/u
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
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
    params: Readonly<Record<string, unknown>>
  ): Promise<unknown>
  /** Reads at most `maxBytes`; the native path is never returned to callers. */
  readArtifact?(
    scope: HermesContentSession,
    reference: string,
    maxBytes: number
  ): Promise<{ bytes: Uint8Array; mimeType?: string }>
  audioConfig?(
    scope: HermesContentSession,
    kind: "stt" | "tts"
  ): Promise<unknown>
  transcribe?(
    scope: HermesContentSession,
    request: { dataUrl: string; mimeType: string }
  ): Promise<unknown>
  speak?(scope: HermesContentSession, text: string): Promise<unknown>
}

export type HermesContentAttachment =
  | { type: "image"; dataUrl: string; filename?: string }
  | { type: "file"; dataUrl: string; filename?: string; mimeType?: string }

export type HermesPublicAttachment =
  | { type: "image"; dataUrl: string; filename?: string }
  | { type: "file"; filename?: string; mimeType: string }

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

function isRecord(value: unknown): value is NativeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: NativeRecord, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function boundedText(value: unknown, max: number) {
  return typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : undefined
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

function decodedLength(encoded: string) {
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  return (encoded.length / 4) * 3 - padding
}

function parseDataUrl(value: unknown, maxBytes: number) {
  if (typeof value !== "string" || value.length === 0) return undefined
  const separator = value.indexOf(";base64,")
  if (!value.startsWith("data:") || separator <= 5) return undefined
  const mimeType = value.slice(5, separator)
  const encoded = value.slice(separator + 8)
  const maxEncoded = Math.ceil(maxBytes / 3) * 4
  if (
    !SAFE_MIME.test(mimeType) ||
    encoded.length === 0 ||
    encoded.length > maxEncoded ||
    encoded.length % 4 !== 0 ||
    !BASE64.test(encoded) ||
    decodedLength(encoded) > maxBytes
  )
    return undefined
  return { dataUrl: value, mimeType, encoded }
}

function privateNativePath(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096
    ? value
    : undefined
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
    !BASE64.test(encoded) ||
    decodedLength(encoded) > maxBytes
  )
    return undefined
  try {
    const binary = atob(encoded)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return undefined
  }
}

function audioReadiness(value: unknown, kind: "stt" | "tts") {
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
    return "unavailable" as const
  const providers = value.providers.flatMap((row) => {
    if (
      !isRecord(row) ||
      !boundedText(row.name, 256) ||
      typeof row.is_active !== "boolean"
    )
      return []
    const readiness =
      row.status === "ready"
        ? "ready"
        : row.status === "needs_keys" ||
            row.status === "needs_auth" ||
            row.status === "needs_setup"
          ? "unverified"
          : "unavailable"
    return [
      {
        name: String(row.name),
        active: row.is_active,
        readiness,
        edge: row.tts_provider === "edge",
      },
    ]
  })
  if (value.active_provider !== null) {
    const provider = providers.find(
      ({ name }) => name === value.active_provider
    )
    return provider?.active ? provider.readiness : "unavailable"
  }
  if (providers.some(({ active }) => active)) return "unavailable"
  if (kind === "tts")
    return providers.find(({ edge }) => edge)?.readiness ?? "unavailable"
  return "unverified" as const
}

export function createHermesContentOperations(input: {
  authority: HermesContentAuthority
  transport: HermesContentTransport
}) {
  const requireScope = async (agentId: string, sessionId: string) => {
    let scope: HermesContentSession
    try {
      scope = await input.authority.requireSession(agentId, sessionId)
    } catch {
      throw new HermesContentScopeError()
    }
    if (
      scope.agentId !== agentId ||
      scope.sessionId !== sessionId ||
      !boundedText(scope.liveSessionId, 4_096) ||
      typeof scope.attached !== "boolean"
    )
      throw new HermesContentScopeError()
    if (!scope.attached) throw new HermesContentUnavailableError()
    return scope
  }
  const nativeRequest = async (
    method: string,
    params: Readonly<Record<string, unknown>>
  ) => {
    try {
      return await input.transport.request(method, params)
    } catch {
      throw new HermesContentUnavailableError()
    }
  }

  return {
    capabilities() {
      return {
        attachments: {
          status: "available" as const,
          scope: "attached-session" as const,
          inputs: ["image", "file"] as const,
        },
        artifacts:
          input.authority.requireArtifact && input.transport.readArtifact
            ? { status: "available" as const, scope: "session" as const }
            : {
                status: "unavailable" as const,
                reason: "artifact-reader-unavailable",
              },
        transcription:
          input.transport.audioConfig && input.transport.transcribe
            ? {
                status: "available" as const,
                scope: "attached-session" as const,
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
      if (attachments.length > MAX_ATTACHMENTS)
        throw new HermesContentUnavailableError()
      const scope = await requireScope(agentId, sessionId)
      const images: string[] = []
      const references: string[] = []
      const publicAttachments: HermesPublicAttachment[] = []
      const cleanup = async () => {
        const results = await Promise.allSettled(
          images.map((path) =>
            nativeRequest("image.detach", {
              session_id: scope.liveSessionId,
              path,
            })
          )
        )
        if (results.some((result) => result.status === "rejected"))
          throw new HermesContentUnavailableError()
      }
      try {
        for (const attachment of attachments) {
          if (!isRecord(attachment) || attachment.type === undefined)
            throw new HermesContentUnavailableError()
          const isImage = attachment.type === "image"
          if (
            (!isImage && attachment.type !== "file") ||
            !hasOnlyKeys(
              attachment,
              isImage
                ? ["type", "dataUrl", "filename"]
                : ["type", "dataUrl", "filename", "mimeType"]
            )
          )
            throw new HermesContentUnavailableError()
          const parsed = parseDataUrl(
            attachment.dataUrl,
            isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES
          )
          if (!parsed) throw new HermesContentUnavailableError()
          const filename = safeFilename(attachment.filename)
          if (isImage) {
            if (!IMAGE_MIME.has(parsed.mimeType))
              throw new HermesContentUnavailableError()
            const result = await nativeRequest("image.attach_bytes", {
              session_id: scope.liveSessionId,
              content_base64: parsed.dataUrl,
              filename: filename ?? "image.png",
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
              dataUrl: parsed.dataUrl,
              ...(filename ? { filename } : {}),
            })
            continue
          }
          if (
            attachment.mimeType !== undefined &&
            attachment.mimeType !== parsed.mimeType
          )
            throw new HermesContentUnavailableError()
          const result = await nativeRequest("file.attach", {
            session_id: scope.liveSessionId,
            data_url: parsed.dataUrl,
            name: filename ?? "attachment",
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
            mimeType: parsed.mimeType,
            ...(filename ? { filename } : {}),
          })
        }
      } catch (error) {
        if (images.length) await cleanup().catch(() => undefined)
        throw error instanceof HermesContentScopeError
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
      const filename = safeFilename(artifact?.filename)
      const reference = privateNativePath(artifact?.reference)
      if (!filename || !reference) throw new HermesContentScopeError()
      let result: { bytes: Uint8Array; mimeType?: string }
      try {
        result = await input.transport.readArtifact(
          scope,
          reference,
          MAX_ARTIFACT_BYTES
        )
      } catch {
        throw new HermesContentUnavailableError()
      }
      if (
        !(result.bytes instanceof Uint8Array) ||
        result.bytes.length === 0 ||
        result.bytes.length > MAX_ARTIFACT_BYTES ||
        (result.mimeType !== undefined && !SAFE_MIME.test(result.mimeType))
      )
        throw new HermesContentUnavailableError()
      return {
        bytes: result.bytes,
        ...(result.mimeType ? { mimeType: result.mimeType } : {}),
        filename,
      }
    },
    async audio(agentId: string, sessionId: string) {
      const scope = await requireScope(agentId, sessionId)
      if (!input.transport.audioConfig)
        return {
          transcription: "unavailable" as const,
          speech: "unavailable" as const,
        }
      const read = async (kind: "stt" | "tts") => {
        try {
          return audioReadiness(
            await input.transport.audioConfig!(scope, kind),
            kind
          )
        } catch {
          return "unavailable" as const
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
      mimeType: string
    ) {
      const scope = await requireScope(agentId, sessionId)
      if (
        !input.transport.transcribe ||
        !(bytes instanceof Uint8Array) ||
        bytes.length === 0 ||
        bytes.length > MAX_RECORDING_BYTES ||
        !RECORDING_MIME.test(mimeType)
      )
        throw new HermesContentUnavailableError()
      let result: unknown
      try {
        result = await input.transport.transcribe(scope, {
          dataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
          mimeType,
        })
      } catch {
        throw new HermesContentUnavailableError()
      }
      if (
        !isRecord(result) ||
        result.ok !== true ||
        typeof result.transcript !== "string" ||
        result.transcript.length > MAX_TRANSCRIPT_LENGTH
      )
        throw new HermesContentUnavailableError()
      return result.transcript
    },
    async speak(agentId: string, sessionId: string, text: string) {
      const scope = await requireScope(agentId, sessionId)
      if (!input.transport.speak || !boundedText(text, MAX_SPEECH_TEXT_LENGTH))
        throw new HermesContentUnavailableError()
      let result: unknown
      try {
        result = await input.transport.speak(scope, text)
      } catch {
        throw new HermesContentUnavailableError()
      }
      if (
        !isRecord(result) ||
        result.ok !== true ||
        typeof result.data_url !== "string" ||
        typeof result.mime_type !== "string" ||
        !SPEECH_MIME.test(result.mime_type)
      )
        throw new HermesContentUnavailableError()
      const prefix = `data:${result.mime_type};base64,`
      if (!result.data_url.startsWith(prefix))
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
