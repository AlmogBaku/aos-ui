import { validateChatSendParams } from "@openclaw/gateway-protocol"

const MAX = 25 * 1024 * 1024
const MAX_COUNT = 16
const MIME =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u
const encoder = new TextEncoder()
export class OpenClawContentPublicError extends Error {
  constructor() {
    super("OpenClaw content is invalid or unavailable")
    this.name = "OpenClawContentPublicError"
  }
}
export type OpenClawAttachment = Readonly<{
  type: "image" | "file"
  dataUrl: string
  filename?: string
  mimeType?: string
}>
const text = (v: unknown, n: number) =>
  typeof v === "string" && v.trim() && encoder.encode(v).byteLength <= n
    ? v.trim()
    : undefined
const id = (v: unknown) => {
  const x = text(v, 256)
  return x && !/[\\/\0\r\n]/u.test(x) ? x : undefined
}
const filename = (v: unknown) => {
  const x = text(v, 255)
  return x && !/[\\/\0\r\n]/u.test(x) ? x : undefined
}
const mime = (v: unknown) => {
  const x = text(v, 256)
  return x && MIME.test(x) ? x : undefined
}
function parseDataUrl(v: unknown) {
  if (typeof v !== "string") return undefined
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(v)
  if (
    !m ||
    !mime(m[1]) ||
    !m[2] ||
    m[2].length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(m[2])
  )
    return undefined
  const padding = m[2].endsWith("==") ? 2 : m[2].endsWith("=") ? 1 : 0,
    sizeBytes = (m[2].length / 4) * 3 - padding
  return sizeBytes <= MAX
    ? { dataUrl: v, mimeType: m[1]!, sizeBytes }
    : undefined
}
/** Validates the entire official chat.send request, including encoded attachment content. */
export function prepareOpenClawChatAttachments(
  input: Readonly<{
    sessionKey: string
    message: string
    idempotencyKey: string
    attachments: readonly OpenClawAttachment[]
  }>
) {
  if (
    !id(input.sessionKey) ||
    !text(input.message, 1_000_000) ||
    !id(input.idempotencyKey) ||
    input.attachments.length > MAX_COUNT
  )
    throw new OpenClawContentPublicError()
  let total = 0
  const publicAttachments: Array<{
    type: "image" | "file"
    filename?: string
    mimeType: string
  }> = []
  const attachments = input.attachments.map((a) => {
    const parsed = parseDataUrl(a.dataUrl),
      name = a.filename === undefined ? undefined : filename(a.filename)
    if (
      !parsed ||
      (a.filename !== undefined && !name) ||
      (a.mimeType !== undefined && a.mimeType !== parsed.mimeType) ||
      (a.type !== "image" && a.type !== "file")
    )
      throw new OpenClawContentPublicError()
    total += parsed.sizeBytes
    if (total > MAX) throw new OpenClawContentPublicError()
    publicAttachments.push({
      type: a.type,
      ...(name ? { filename: name } : {}),
      mimeType: parsed.mimeType,
    })
    return {
      type: a.type,
      content: parsed.dataUrl,
      mimeType: parsed.mimeType,
      sizeBytes: parsed.sizeBytes,
      ...(name ? { fileName: name } : {}),
    }
  })
  const native = {
    sessionKey: input.sessionKey,
    message: input.message,
    idempotencyKey: input.idempotencyKey,
    attachments,
  }
  if (!validateChatSendParams(native)) throw new OpenClawContentPublicError()
  return { native, public: publicAttachments }
}
type ArtifactScope = Readonly<{
  agentId: string
  sessionId: string
  messageId: string
  runId?: string
  messageSeq?: number
}>
type Receipt = Readonly<{
  artifactId: string
  filename: string
  mimeType?: string
  sizeBytes?: number
}>
/** Only exact provider receipts become downloadable normalized artifact identities. */
export class OpenClawArtifactReceipts {
  readonly #values = new Map<string, Receipt>()
  accept(scope: ArtifactScope, raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new OpenClawContentPublicError()
    const v = raw as Record<string, unknown>,
      artifactId = id(v.id),
      title = filename(v.title),
      mimeType = v.mimeType === undefined ? undefined : mime(v.mimeType),
      sizeBytes = v.sizeBytes,
      download = v.download as Record<string, unknown> | undefined
    if (
      !artifactId ||
      !title ||
      (v.mimeType !== undefined && !mimeType) ||
      (sizeBytes !== undefined &&
        (!Number.isSafeInteger(sizeBytes) ||
          (sizeBytes as number) < 0 ||
          (sizeBytes as number) > MAX)) ||
      v.agentId !== scope.agentId ||
      v.sessionKey !== scope.sessionId ||
      (scope.runId !== undefined && v.runId !== scope.runId) ||
      (scope.messageSeq !== undefined && v.messageSeq !== scope.messageSeq) ||
      !download ||
      download.mode !== "bytes"
    )
      throw new OpenClawContentPublicError()
    const receipt = {
      artifactId,
      filename: title,
      ...(mimeType ? { mimeType } : {}),
      ...(sizeBytes === undefined ? {} : { sizeBytes: sizeBytes as number }),
    }
    this.#values.set(
      this.key(scope.agentId, scope.sessionId, scope.messageId, artifactId),
      receipt
    )
    return receipt
  }
  get(
    agentId: string,
    sessionId: string,
    messageId: string,
    artifactId: string
  ) {
    return this.#values.get(this.key(agentId, sessionId, messageId, artifactId))
  }
  private key(
    agentId: string,
    sessionId: string,
    messageId: string,
    artifactId: string
  ) {
    return `${agentId}\0${sessionId}\0${messageId}\0${artifactId}`
  }
}
/** Optional AOS plugin cards stay a tiny allowlist with inspectable prose. */
export function projectOpenClawRichPresentation(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const v = raw as Record<string, unknown>,
    p = v.presentation
  if (
    v.type !== "aos.artifact-publication" ||
    !text(v.text, 8192) ||
    !p ||
    typeof p !== "object" ||
    Array.isArray(p)
  )
    return undefined
  const rich = p as Record<string, unknown>,
    title = filename(rich.title),
    mimeType = mime(rich.mimeType)
  return rich.kind === "artifact" && title && mimeType
    ? {
        text: text(v.text, 8192)!,
        rich: { kind: "artifact" as const, title, mimeType },
      }
    : undefined
}
