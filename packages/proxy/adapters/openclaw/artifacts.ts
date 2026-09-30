import { MAX_ARTIFACT_BYTES } from "../../core/artifact-path"
import type {
  OpenClawArtifactDownload,
  OpenClawSessionFile,
} from "./native-schemas"

/** OpenClaw's own transcript artifact ids (`artifact_managed_image_…` and kin). */
const NATIVE_ARTIFACT_ID = /^artifact_[A-Za-z0-9_-]{1,240}$/u
/** The only gateway route a download URL may name: ticketed outgoing media. */
const GATEWAY_MEDIA_PATH = "/api/chat/media/outgoing/"
const MIME =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u
const encoder = new TextEncoder()

/** The artifact is authoritative, but OpenClaw cannot hand back its bytes. */
export class OpenClawArtifactUnreadableError extends Error {
  constructor() {
    super("OpenClaw could not read this artifact")
    this.name = "OpenClawArtifactUnreadableError"
  }
}

/** The bytes exist but are over the limit or could not be fetched right now. */
export class OpenClawArtifactUnavailableError extends Error {
  constructor() {
    super("OpenClaw artifact is temporarily unavailable")
    this.name = "OpenClawArtifactUnavailableError"
  }
}

export type OpenClawArtifactDescriptor = Readonly<{
  id: string
  filename: string
  mimeType?: string
  sizeBytes?: number
  source: Readonly<{ type: "provider"; reference: string }>
}>

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function safeFilename(value: unknown) {
  return typeof value === "string" &&
    value.length > 0 &&
    encoder.encode(value).byteLength <= 255 &&
    !/[\\/\r\n\0]/u.test(value)
    ? value
    : undefined
}

export function artifactMime(value: unknown) {
  return typeof value === "string" && value.length <= 256 && MIME.test(value)
    ? value
    : undefined
}

function descriptor(
  id: string,
  filename: string,
  mimeType: string | undefined,
  sizeBytes?: number
): OpenClawArtifactDescriptor {
  return {
    id,
    filename,
    ...(mimeType ? { mimeType } : {}),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    source: { type: "provider", reference: id },
  }
}

export function isNativeArtifactId(artifactId: string) {
  return NATIVE_ARTIFACT_ID.test(artifactId)
}

/**
 * The artifact one native media block names, under OpenClaw's own artifact
 * id. The gateway turns an assistant's `MEDIA:` line into such a block when it
 * persists the turn; the block's URL stays native and is never surfaced.
 */
export function openClawMediaArtifact(
  block: Record<string, unknown>
): OpenClawArtifactDescriptor | undefined {
  const kind = block.type
  const media =
    kind === "attachment"
      ? record(block.attachment)
      : kind === "image" || kind === "audio" || kind === "video"
        ? block
        : undefined
  const id =
    typeof media?.artifactId === "string" &&
    isNativeArtifactId(media.artifactId)
      ? media.artifactId
      : undefined
  if (!media || !id) return undefined
  const sizeBytes =
    typeof media.sizeBytes === "number" &&
    Number.isSafeInteger(media.sizeBytes) &&
    media.sizeBytes >= 0
      ? media.sizeBytes
      : undefined
  return descriptor(
    id,
    safeFilename(media.fileName ?? media.label ?? media.alt) ?? String(kind),
    artifactMime(media.mimeType),
    sizeBytes
  )
}

function bounded(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_ARTIFACT_BYTES)
    throw new OpenClawArtifactUnavailableError()
  return bytes
}

function base64Bytes(value: string) {
  if (value.length % 4 !== 0 || !BASE64.test(value))
    throw new OpenClawArtifactUnreadableError()
  if ((value.length / 4) * 3 > MAX_ARTIFACT_BYTES + 2)
    throw new OpenClawArtifactUnavailableError()
  return bounded(new Uint8Array(Buffer.from(value, "base64")))
}

/**
 * The bytes `sessions.files.get` answered with. The gateway previews text and
 * browser images only, so a missing file, and one it answers without content
 * (a binary or anything over its preview cap), is unreadable.
 */
export function sessionFileBytes(file: OpenClawSessionFile) {
  if (file.missing || file.content === undefined)
    throw new OpenClawArtifactUnreadableError()
  return file.contentEncoding === "base64"
    ? base64Bytes(file.content)
    : bounded(encoder.encode(file.content))
}

/**
 * The bytes `artifacts.download` answered with: inline base64, or a ticketed
 * gateway media URL fetched from the gateway's own origin. Any other URL is
 * refused rather than fetched, so a transcript cannot aim the proxy elsewhere.
 */
export async function downloadBytes(
  download: OpenClawArtifactDownload,
  gatewayOrigin: string | undefined,
  fetchImpl: typeof fetch
) {
  if (download.encoding === "base64" && download.data !== undefined)
    return base64Bytes(download.data)
  if (
    download.url === undefined ||
    gatewayOrigin === undefined ||
    !download.url.startsWith(GATEWAY_MEDIA_PATH)
  )
    throw new OpenClawArtifactUnreadableError()
  const url = new URL(download.url, gatewayOrigin)
  if (url.origin !== gatewayOrigin) throw new OpenClawArtifactUnreadableError()
  let response: Response
  try {
    response = await fetchImpl(url, { redirect: "error" })
  } catch {
    throw new OpenClawArtifactUnavailableError()
  }
  if (response.status === 404 || response.status === 403)
    throw new OpenClawArtifactUnreadableError()
  if (!response.ok) throw new OpenClawArtifactUnavailableError()
  if (Number(response.headers.get("content-length")) > MAX_ARTIFACT_BYTES)
    throw new OpenClawArtifactUnavailableError()
  return bounded(new Uint8Array(await response.arrayBuffer()))
}

export function artifactFilename(value: unknown) {
  return safeFilename(value) ?? "artifact"
}
