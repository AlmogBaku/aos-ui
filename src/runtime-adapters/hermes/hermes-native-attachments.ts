import type { AppendMessage, ImageMessagePart } from "@assistant-ui/react"
import { isRecord, stringValue, type JsonRecord } from "./hermes-native-codec"

type Request = (method: string, params: JsonRecord) => Promise<unknown>

export class HermesAttachmentStagingError extends Error {
  constructor(
    cause: unknown,
    readonly cleanup: (liveSessionId?: string) => Promise<void>
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "HermesAttachmentStagingError"
  }
}

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const IMAGE_DATA = /^data:image\/(png|jpeg|gif|webp|bmp);base64,(.+)$/u
const FILE_DATA = /^data:[\w.+-]+\/[\w.+-]+;base64,(.*)$/u

function validateBytes(data: string) {
  if (!data || !BASE64.test(data))
    throw new Error("Invalid Hermes attachment bytes")
}

export function hermesImagePaths(text: string): string[] {
  const references = text.matchAll(
    /@image:(?:`([^`]+)`|"([^"]+)"|'([^']+)'|([^\s]+))/gu
  )
  const paths = new Set<string>()
  for (const match of references) {
    const path = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (
      !/^(?:\/|[A-Za-z]:[\\/])/u.test(path) ||
      Array.from(path).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(path) ||
      !/\.(?:png|jpe?g|gif|webp|bmp|tiff?|svg|ico)$/iu.test(path)
    )
      throw new Error("Invalid native Hermes image attachment path")
    paths.add(path)
  }
  return [...paths]
}

/** Hermes stages images for the next turn; files become native @file references. */
export async function stageHermesAttachments(
  message: AppendMessage,
  liveSessionId: string,
  request: Request,
  preservedImagePaths: readonly string[] = []
) {
  const images: ImageMessagePart[] = []
  const references: string[] = []
  const stagedImages: string[] = []
  const parts = [
    ...message.content,
    ...(message.attachments ?? []).flatMap((attachment) => attachment.content),
  ]
  for (const part of parts) {
    if (part.type === "image" && preservedImagePaths.length === 0) {
      const data = IMAGE_DATA.exec(part.image)?.[2]
      if (!data || data.length > Math.ceil((25 * 1024 * 1024) / 3) * 4)
        throw new Error("Unsupported Hermes image attachment")
      validateBytes(data)
    } else if (part.type === "file") {
      if (part.sourceType || !/^[\w.+-]+\/[\w.+-]+$/u.test(part.mimeType))
        throw new Error("Unsupported Hermes file attachment")
      validateBytes(
        part.data.startsWith("data:")
          ? (FILE_DATA.exec(part.data)?.[1] ?? "")
          : part.data
      )
    }
  }
  const cleanup = async (attachedSessionId = liveSessionId) => {
    const results = await Promise.allSettled(
      stagedImages.map((path) =>
        request("image.detach", { session_id: attachedSessionId, path })
      )
    )
    const failed = results.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
  }
  try {
    for (const path of preservedImagePaths) {
      const result = await request("image.attach", {
        session_id: liveSessionId,
        path,
      })
      if (
        !isRecord(result) ||
        result.attached !== true ||
        !stringValue(result.path)
      )
        throw new Error("Hermes did not accept the preserved image attachment")
      stagedImages.push(String(result.path))
    }
    for (const part of parts) {
      if (part.type === "image") {
        // Native history carries both ordered path directives and image parts.
        // Paths are reattached above; parts are retained only for display.
        if (preservedImagePaths.length) {
          images.push(part)
          continue
        }
        const result = await request("image.attach_bytes", {
          session_id: liveSessionId,
          content_base64: part.image,
          filename: part.filename ?? "image.png",
        })
        if (
          !isRecord(result) ||
          result.attached !== true ||
          !stringValue(result.path)
        )
          throw new Error("Hermes did not accept the image attachment")
        images.push(part)
        stagedImages.push(String(result.path))
      } else if (part.type === "file") {
        const result = await request("file.attach", {
          session_id: liveSessionId,
          data_url: part.data.startsWith("data:")
            ? part.data
            : `data:${part.mimeType};base64,${part.data}`,
          name: part.filename ?? "attachment",
        })
        if (
          !isRecord(result) ||
          result.attached !== true ||
          !stringValue(result.ref_text) ||
          !/^@file:(?:`[^`\r\n]+`|"[^"\r\n]+"|'[^'\r\n]+'|[^\s]+)$/u.test(
            String(result.ref_text)
          )
        )
          throw new Error("Hermes did not accept the file attachment")
        references.push(String(result.ref_text))
      }
    }
  } catch (reason) {
    // Transfer cleanup ownership before attempting recovery: the gateway may
    // reject detach too, so the client must retain this handle for a retry.
    if (stagedImages.length)
      throw new HermesAttachmentStagingError(reason, cleanup)
    throw reason
  }
  return { images, references, cleanup }
}
