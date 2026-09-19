import {
  SimpleImageAttachmentAdapter,
  type AttachmentAdapter,
  type CompleteAttachment,
  type PendingAttachment,
} from "@assistant-ui/react"

const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
])

/** The bytes one composed attachment stages over REST, ready for the batch. */
export type AosStagedAttachment = {
  type: "image" | "file"
  dataUrl: string
  filename?: string
  mimeType: string
}

/**
 * Reads back what `AosAttachmentAdapter.send` put on the message, so a staging
 * caller never re-derives the encoding this adapter chose.
 */
export function stagedAttachmentOf(
  attachment: CompleteAttachment
): AosStagedAttachment {
  const part = attachment.content[0]
  const named = attachment.name ? { filename: attachment.name } : {}
  if (part?.type === "image")
    return {
      type: "image",
      dataUrl: part.image,
      ...named,
      // The stage request carries an image's type inside its data URL.
      mimeType: attachment.contentType ?? "application/octet-stream",
    }
  if (part?.type === "file")
    return {
      type: "file",
      dataUrl: part.data,
      ...named,
      mimeType: part.mimeType,
    }
  throw new Error("Could not read AOS attachment bytes")
}

/** Browser drafts retain bytes; the normalized run endpoint stages them once. */
export class AosAttachmentAdapter implements AttachmentAdapter {
  readonly accept = "*"
  readonly #bytes = new SimpleImageAttachmentAdapter()

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    const attachment = await this.#bytes.add({ file })
    return { ...attachment, type: imageTypes.has(file.type) ? "image" : "file" }
  }

  remove: AttachmentAdapter["remove"] = async () => {}

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const complete = await this.#bytes.send(attachment)
    const part = complete.content[0]
    if (part?.type !== "image")
      throw new Error("Could not read AOS attachment bytes")
    return {
      ...complete,
      content:
        attachment.type === "image"
          ? [{ ...part, filename: attachment.name }]
          : [
              {
                type: "file",
                data: part.image,
                filename: attachment.name,
                mimeType: attachment.file.type || "application/octet-stream",
              },
            ],
    }
  }
}
