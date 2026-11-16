import {
  SimpleImageAttachmentAdapter,
  type AttachmentAdapter,
  type CompleteAttachment,
  type PendingAttachment,
} from "@assistant-ui/react"

import type { Dictionary } from "@/lib/i18n/dictionary"

import type { AcpAttachmentStage } from "./acp/use-acp-runtime"

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

/**
 * What one stage request carries. The SDK's
 * `SessionAttachmentStageRequestSchema` bounds a batch at 16 files and each
 * data URL at 35,000,000 characters, and the gateway reads at most 35,500,000
 * bytes of the whole request, so the batch's data URLs together stay under the
 * one-file cap. Both refuse past a bound without saying which, so staging
 * checks first.
 */
export const MAX_STAGED_ATTACHMENTS = 16
export const MAX_STAGED_DATA_URL_LENGTH = 35_000_000
/** The size the copy promises: files this size together fit under the cap. */
export const MAX_STAGED_MEGABYTES = 25

/**
 * Stages a turn's composed attachments through `stage`, refusing first, in the
 * operator's words, a batch the gateway's stage request cannot carry.
 */
export async function stageComposedAttachments(
  composed: readonly CompleteAttachment[],
  stage: (staged: AosStagedAttachment[]) => Promise<{ stageId: string }>,
  copy: Dictionary["attachmentLimits"]
): Promise<AcpAttachmentStage> {
  const staged = composed.map(stagedAttachmentOf)
  if (staged.length > MAX_STAGED_ATTACHMENTS)
    throw new Error(
      copy.tooMany.replace("{count}", () => String(MAX_STAGED_ATTACHMENTS))
    )
  const total = staged.reduce((sum, { dataUrl }) => sum + dataUrl.length, 0)
  if (total > MAX_STAGED_DATA_URL_LENGTH) {
    const megabytes = () => String(MAX_STAGED_MEGABYTES)
    const large = staged.findIndex(
      ({ dataUrl }) => dataUrl.length > MAX_STAGED_DATA_URL_LENGTH
    )
    throw new Error(
      large === -1
        ? copy.tooLargeTogether.replace("{megabytes}", megabytes)
        : // The filename goes in last, so no placeholder it holds is filled.
          copy.tooLarge
            .replace("{megabytes}", megabytes)
            .replace("{name}", () => composed[large]?.name ?? "")
    )
  }
  const { stageId } = await stage(staged)
  return {
    stageId,
    attachments: composed.map(({ id, name, contentType }) => ({
      id,
      name,
      ...(contentType === undefined ? {} : { contentType }),
    })),
  }
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
