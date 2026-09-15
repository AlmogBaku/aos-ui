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
/** The verified plugin reports validation only; it cannot publish a native artifact. */
export function projectOpenClawRichPresentation(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const v = raw as Record<string, unknown>,
    details = v.details,
    content = v.content
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    !content[0] ||
    typeof content[0] !== "object" ||
    Array.isArray(content[0]) ||
    (content[0] as Record<string, unknown>).type !== "text" ||
    !text((content[0] as Record<string, unknown>).text, 8192) ||
    !details ||
    typeof details !== "object" ||
    Array.isArray(details)
  )
    return undefined
  const result = details as Record<string, unknown>
  if (
    result.type !== "aos.artifact-publication" ||
    result.status !== "unsupported" ||
    result.published !== false
  )
    return undefined
  return { text: text((content[0] as Record<string, unknown>).text, 8192)! }
}
