import {
  SimpleImageAttachmentAdapter,
  type AttachmentAdapter,
  type CompleteAttachment,
  type PendingAttachment,
} from "@assistant-ui/react"

const NATIVE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
])

/** Bytes stay in Assistant UI's draft until Send; Hermes owns native staging. */
export class HermesAttachmentAdapter implements AttachmentAdapter {
  readonly accept = "*"
  readonly #bytes = new SimpleImageAttachmentAdapter()

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    const attachment = await this.#bytes.add({ file })
    return {
      ...attachment,
      type: NATIVE_IMAGE_TYPES.has(file.type) ? "image" : "file",
    }
  }

  remove: AttachmentAdapter["remove"] = async () => {}

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const complete = await this.#bytes.send(attachment)
    const part = complete.content[0]
    if (part?.type !== "image")
      throw new Error("Could not read Hermes attachment bytes")
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
