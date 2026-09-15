import {
  present_planSchema,
  render_chartSchema,
  render_mapSchema,
  render_statsSchema,
} from "../../../../shared/presentation/tools"

const MAX_ATTACHMENTS = 16
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_TOTAL_BYTES = 25 * 1024 * 1024
const MAX_TEXT_BYTES = 4_096
const SAFE_MIME =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u

export type OpenCodeContentAttachment =
  | { type: "image"; dataUrl: string; filename?: string }
  | { type: "file"; dataUrl: string; filename?: string; mimeType?: string }

export class OpenCodeContentUnavailableError extends Error {
  constructor() {
    super("OpenCode content operation is unavailable")
    this.name = "OpenCodeContentUnavailableError"
  }
}

const RICH_TOOLS = {
  render_chart: { kind: "chart", schema: render_chartSchema },
  render_map: { kind: "map", schema: render_mapSchema },
  render_stats: { kind: "stats", schema: render_statsSchema },
  present_plan: { kind: "plan", schema: present_planSchema },
} as const

/**
 * Maps only the AOS integration's validated presentation tools. Native tool
 * state, metadata, IDs, and unknown tools deliberately never become rich UI.
 */
export function mapOpenCodeRichTool(value: unknown) {
  const part = record(value)
  const descriptor =
    typeof part?.tool === "string"
      ? RICH_TOOLS[part.tool as keyof typeof RICH_TOOLS]
      : undefined
  const state = record(part?.state)
  if (
    !descriptor ||
    !state ||
    !["pending", "running", "completed", "error"].includes(String(state.status))
  )
    return undefined
  const parsed = descriptor.schema.safeParse(state.input)
  if (!parsed.success) return undefined
  const output =
    typeof state.output === "string" && bytes(state.output) <= MAX_TEXT_BYTES
      ? state.output
      : undefined
  return {
    kind: descriptor.kind,
    data: parsed.data,
    ...(output ? { fallback: output } : {}),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function bytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function safeFilename(value: unknown) {
  return typeof value === "string" &&
    value.length > 0 &&
    bytes(value) <= 255 &&
    !/[\\/\r\n\0]/u.test(value)
    ? value
    : undefined
}

function safeMime(value: unknown) {
  return typeof value === "string" &&
    bytes(value) <= 256 &&
    SAFE_MIME.test(value)
    ? value
    : undefined
}

function dataUrl(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("data:")) return undefined
  const separator = value.indexOf(";base64,")
  if (separator < 6) return undefined
  const mimeType = safeMime(value.slice(5, separator))
  const encoded = value.slice(separator + 8)
  if (
    !mimeType ||
    !encoded ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
  )
    return undefined
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  const length = (encoded.length / 4) * 3 - padding
  return Number.isSafeInteger(length) &&
    length > 0 &&
    length <= MAX_ATTACHMENT_BYTES
    ? { mimeType, bytes: length }
    : undefined
}

export class OpenCodeContent {
  stage(attachments: readonly OpenCodeContentAttachment[]) {
    if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS)
      throw new OpenCodeContentUnavailableError()
    let total = 0
    const prepared = attachments.map((attachment) => {
      const parsed = dataUrl(attachment?.dataUrl)
      const filename =
        attachment?.filename === undefined
          ? undefined
          : safeFilename(attachment.filename)
      const mimeType =
        attachment?.type === "file" && attachment.mimeType !== undefined
          ? safeMime(attachment.mimeType)
          : parsed?.mimeType
      if (
        !parsed ||
        (attachment.type !== "image" && attachment.type !== "file") ||
        (attachment.filename !== undefined && !filename) ||
        !mimeType ||
        (attachment.type === "image" && !parsed.mimeType.startsWith("image/"))
      )
        throw new OpenCodeContentUnavailableError()
      total += parsed.bytes
      return { type: attachment.type, filename, mimeType, bytes: parsed.bytes }
    })
    if (total > MAX_TOTAL_BYTES) throw new OpenCodeContentUnavailableError()
    return {
      public: prepared.map((attachment) =>
        attachment.type === "image"
          ? {
              type: "image" as const,
              dataUrl: attachments[prepared.indexOf(attachment)]!.dataUrl,
              ...(attachment.filename ? { filename: attachment.filename } : {}),
            }
          : {
              type: "file" as const,
              ...(attachment.filename ? { filename: attachment.filename } : {}),
              mimeType: attachment.mimeType,
            }
      ),
      appendTo(text: string) {
        return [
          text.trim(),
          ...prepared.map(
            (attachment) =>
              `[attachment: ${attachment.filename ?? "attachment"}]`
          ),
        ]
          .filter(Boolean)
          .join("\n")
      },
      async cleanup() {},
    }
  }

  artifactReceipt(value: unknown) {
    const result = record(value)
    const metadata = record(result?.metadata)
    const receipt = record(metadata?.aos_ui)
    const id =
      typeof receipt?.id === "string" && bytes(receipt.id) <= 256
        ? receipt.id
        : undefined
    const filename = safeFilename(receipt?.filename)
    const mimeType = safeMime(receipt?.mimeType)
    const sizeBytes = receipt?.sizeBytes
    const attachment = Array.isArray(result?.attachments)
      ? record(result.attachments[0])
      : undefined
    if (
      receipt?.kind !== "artifact" ||
      !id ||
      !filename ||
      !mimeType ||
      typeof sizeBytes !== "number" ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      sizeBytes > MAX_ATTACHMENT_BYTES ||
      !attachment ||
      attachment.type !== "file" ||
      attachment.filename !== filename ||
      attachment.mime !== mimeType ||
      typeof attachment.url !== "string" ||
      !attachment.url.startsWith(`data:${mimeType};base64,`)
    )
      throw new OpenCodeContentUnavailableError()
    return { id, filename, mimeType, sizeBytes }
  }
}
