import { validateChatSendParams } from "@openclaw/gateway-protocol"
import type { ServerAttachmentStage } from "../../core/runtime"

export const OPENCLAW_ATTACHMENT_PROXY_LIMITS = Object.freeze({
  maxMimeTypeBytes: 256,
  maxFilenameBytes: 255,
  maxCount: 16,
})
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
export type OpenClawGatewayPolicy = Readonly<{
  maxPayload: number
  attachments: Readonly<{
    maxBytes: number
    maxImageBytes: number
  }>
}>
type StagedOpenClawAttachments = Readonly<{
  attachments: readonly OpenClawAttachment[]
  policy: OpenClawGatewayPolicy
}>
const STAGED_OPENCLAW_ATTACHMENTS = Symbol("staged-openclaw-attachments")
const REQUEST_ID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000"
export type OpenClawAttachmentStage = ServerAttachmentStage & {
  readonly [STAGED_OPENCLAW_ATTACHMENTS]: StagedOpenClawAttachments
}
const text = (v: unknown, n: number) =>
  typeof v === "string" && v.trim() && encoder.encode(v).byteLength <= n
    ? v.trim()
    : undefined
const id = (v: unknown) => {
  const x = text(v, 256)
  return x && !/[\\/\0\r\n]/u.test(x) ? x : undefined
}
const filename = (v: unknown) => {
  const x = text(v, OPENCLAW_ATTACHMENT_PROXY_LIMITS.maxFilenameBytes)
  return x && !/[\\/\0\r\n]/u.test(x) ? x : undefined
}
const mime = (v: unknown) => {
  const x = text(v, OPENCLAW_ATTACHMENT_PROXY_LIMITS.maxMimeTypeBytes)
  return x && MIME.test(x) ? x : undefined
}
function validPolicy(
  policy: OpenClawGatewayPolicy | undefined
): policy is OpenClawGatewayPolicy {
  return (
    !!policy &&
    !!policy.attachments &&
    Number.isSafeInteger(policy.maxPayload) &&
    policy.maxPayload > 0 &&
    Number.isSafeInteger(policy.attachments.maxBytes) &&
    policy.attachments.maxBytes > 0 &&
    Number.isSafeInteger(policy.attachments.maxImageBytes) &&
    policy.attachments.maxImageBytes > 0
  )
}
function parseDataUrl(v: unknown, maxBytes: number) {
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
  return sizeBytes <= maxBytes
    ? { dataUrl: v, mimeType: m[1]!, sizeBytes }
    : undefined
}
function prepareAttachments(
  attachments: readonly OpenClawAttachment[],
  policy: OpenClawGatewayPolicy
) {
  if (
    !validPolicy(policy) ||
    attachments.length > OPENCLAW_ATTACHMENT_PROXY_LIMITS.maxCount
  )
    throw new OpenClawContentPublicError()
  const publicAttachments: Array<
    | { type: "image"; dataUrl: string; filename?: string }
    | { type: "file"; filename?: string; mimeType: string }
  > = []
  const staged: OpenClawAttachment[] = []
  const native = attachments.map((attachment) => {
    if (attachment.type !== "image" && attachment.type !== "file")
      throw new OpenClawContentPublicError()
    const parsed = parseDataUrl(
        attachment.dataUrl,
        attachment.type === "image"
          ? policy.attachments.maxImageBytes
          : policy.attachments.maxBytes
      ),
      name =
        attachment.filename === undefined
          ? undefined
          : filename(attachment.filename)
    if (
      !parsed ||
      (attachment.filename !== undefined && !name) ||
      (attachment.mimeType !== undefined &&
        attachment.mimeType !== parsed.mimeType)
    )
      throw new OpenClawContentPublicError()
    const canonical = Object.freeze({
      type: attachment.type,
      dataUrl: parsed.dataUrl,
      mimeType: parsed.mimeType,
      ...(name ? { filename: name } : {}),
    })
    staged.push(canonical)
    publicAttachments.push(
      attachment.type === "image"
        ? {
            type: "image",
            dataUrl: parsed.dataUrl,
            ...(name ? { filename: name } : {}),
          }
        : {
            type: "file",
            mimeType: parsed.mimeType,
            ...(name ? { filename: name } : {}),
          }
    )
    return {
      type: attachment.type,
      content: parsed.dataUrl,
      mimeType: parsed.mimeType,
      sizeBytes: parsed.sizeBytes,
      ...(name ? { fileName: name } : {}),
    }
  })
  return {
    native,
    staged: Object.freeze(staged),
    public: Object.freeze(publicAttachments),
  }
}
/** Validates the entire official chat.send request, including encoded attachment content. */
export function prepareOpenClawChatAttachments(
  input: Readonly<{
    agentId: string
    sessionKey: string
    message: string
    idempotencyKey: string
    attachments: readonly OpenClawAttachment[]
  }>,
  policy: OpenClawGatewayPolicy
) {
  if (
    !id(input.agentId) ||
    !id(input.sessionKey) ||
    !text(input.message, 1_000_000) ||
    !id(input.idempotencyKey)
  )
    throw new OpenClawContentPublicError()
  const attachments = prepareAttachments(input.attachments, policy)
  const native = {
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    message: input.message,
    idempotencyKey: input.idempotencyKey,
    attachments: attachments.native,
  }
  if (
    !validateChatSendParams(native) ||
    encoder.encode(
      JSON.stringify({
        type: "req",
        id: REQUEST_ID_PLACEHOLDER,
        method: "chat.send",
        params: native,
      })
    ).byteLength > policy.maxPayload
  )
    throw new OpenClawContentPublicError()
  return { native, public: attachments.public }
}
/** Holds validated provider inputs server-side until the next native admission. */
export function stageOpenClawChatAttachments(
  input: readonly OpenClawAttachment[],
  policy: OpenClawGatewayPolicy
): OpenClawAttachmentStage {
  if (!validPolicy(policy)) throw new OpenClawContentPublicError()
  const retainedPolicy = Object.freeze({
      maxPayload: policy.maxPayload,
      attachments: Object.freeze({
        maxBytes: policy.attachments.maxBytes,
        maxImageBytes: policy.attachments.maxImageBytes,
      }),
    }),
    prepared = prepareAttachments(input, retainedPolicy)
  return {
    public: prepared.public,
    appendTo: (message) => message,
    cleanup: async () => undefined,
    [STAGED_OPENCLAW_ATTACHMENTS]: Object.freeze({
      attachments: prepared.staged,
      policy: retainedPolicy,
    }),
  }
}
export function readOpenClawChatAttachments(
  stage: ServerAttachmentStage | undefined
) {
  if (!stage) return undefined
  return (stage as Partial<OpenClawAttachmentStage>)[
    STAGED_OPENCLAW_ATTACHMENTS
  ]
}
