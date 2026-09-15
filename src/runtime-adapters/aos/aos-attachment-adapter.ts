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
