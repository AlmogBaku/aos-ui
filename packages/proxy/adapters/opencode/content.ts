const MAX_ATTACHMENTS = 16
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_TOTAL_BYTES = 25 * 1024 * 1024
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])
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

const promptFiles = new WeakMap<
  object,
  readonly { uri: string; name?: string }[]
>()

/**
 * The run leaf accepts only file references produced by this content boundary.
 * A structural lookalike cannot smuggle unvalidated data URLs into a prompt.
 */
export function openCodePromptFiles(stage: unknown) {
  if (!stage || typeof stage !== "object")
    throw new OpenCodeContentUnavailableError()
  const files = promptFiles.get(stage)
  if (!files) throw new OpenCodeContentUnavailableError()
  return files.length ? files : undefined
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
        (attachment.type === "image" && !IMAGE_MIME_TYPES.has(parsed.mimeType))
      )
        throw new OpenCodeContentUnavailableError()
      total += parsed.bytes
      return { type: attachment.type, filename, mimeType, bytes: parsed.bytes }
    })
    if (total > MAX_TOTAL_BYTES) throw new OpenCodeContentUnavailableError()
    const stage = {
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
      files: attachments.map((attachment) => ({
        uri: attachment.dataUrl,
        ...(attachment.filename ? { name: attachment.filename } : {}),
      })),
      appendTo(text: string) {
        return text.trim()
      },
      async cleanup() {},
    }
    promptFiles.set(
      stage,
      Object.freeze(
        attachments.map((attachment) =>
          Object.freeze({
            uri: attachment.dataUrl,
            ...(attachment.filename ? { name: attachment.filename } : {}),
          })
        )
      )
    )
    return stage
  }

  artifactReceipt(value: unknown) {
    void value
    throw new OpenCodeContentUnavailableError()
    /*
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
    return { id, filename, mimeType, sizeBytes } */
  }
}
