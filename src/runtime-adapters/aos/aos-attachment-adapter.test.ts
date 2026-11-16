import type { CompleteAttachment } from "@assistant-ui/react"
import { SessionAttachmentStageRequestSchema } from "@harness-gw/sdk/protocol"
import { describe, expect, it } from "vitest"

import {
  AosAttachmentAdapter,
  MAX_STAGED_ATTACHMENTS,
  MAX_STAGED_DATA_URL_LENGTH,
  MAX_STAGED_MEGABYTES,
  stageComposedAttachments,
  stagedAttachmentOf,
  type AosStagedAttachment,
} from "./aos-attachment-adapter"

const copy = {
  tooLarge: "{name} is over {megabytes} MB",
  tooLargeTogether: "together over {megabytes} MB",
  tooMany: "over {count} files",
}

/** A composed file whose data URL is `length` characters long. */
function composedFile(name: string, length = 64): CompleteAttachment {
  return {
    id: name,
    type: "file",
    name,
    contentType: "video/mp4",
    status: { type: "complete" },
    content: [
      {
        type: "file",
        data: "data:video/mp4;base64,".padEnd(length, "A"),
        filename: name,
        mimeType: "video/mp4",
      },
    ],
  }
}

function files(count: number, length?: number) {
  return Array.from({ length: count }, (_, index) =>
    composedFile(`clip-${index}.mp4`, length)
  )
}

describe("AOS attachment projection", () => {
  it("keeps file bytes in the browser draft until the normalized run stages them", async () => {
    const adapter = new AosAttachmentAdapter()
    const pending = await adapter.add({
      file: new File(["brief"], "brief.txt", { type: "text/plain" }),
    })
    const complete = await adapter.send(pending)

    expect(complete.content).toEqual([
      {
        type: "file",
        data: expect.stringMatching(/^data:text\/plain;base64,/u),
        filename: "brief.txt",
        mimeType: "text/plain",
      },
    ])
  })

  it.each([
    ["file", "brief.txt", "text/plain", /^data:text\/plain;base64,/u],
    ["image", "chart.png", "image/png", /^data:image\/png;base64,/u],
  ])(
    "reads a staged %s batch back off the composed attachment",
    async (type, filename, mimeType, dataUrl) => {
      const adapter = new AosAttachmentAdapter()
      const pending = await adapter.add({
        file: new File(["bytes"], filename, { type: mimeType }),
      })

      expect(stagedAttachmentOf(await adapter.send(pending))).toEqual({
        type,
        dataUrl: expect.stringMatching(dataUrl),
        filename,
        mimeType,
      })
    }
  )

  it("refuses an attachment whose bytes it cannot read", () => {
    expect(() =>
      stagedAttachmentOf({
        id: "att-1",
        type: "file",
        name: "brief.txt",
        status: { type: "complete" },
        content: [{ type: "text", text: "brief" }],
      })
    ).toThrow(/bytes/u)
  })

  it("bounds a batch exactly where the SDK's stage request does", () => {
    const batch = (count: number, length: number) => ({
      attachments: Array.from({ length: count }, () => ({
        type: "file" as const,
        dataUrl: "d".repeat(length),
      })),
    })
    const accepts = (count: number, length: number) =>
      SessionAttachmentStageRequestSchema.safeParse(batch(count, length))
        .success

    expect(accepts(MAX_STAGED_ATTACHMENTS, MAX_STAGED_DATA_URL_LENGTH)).toBe(
      true
    )
    expect(accepts(MAX_STAGED_ATTACHMENTS + 1, 1)).toBe(false)
    expect(accepts(1, MAX_STAGED_DATA_URL_LENGTH + 1)).toBe(false)
    // The promised size fits split across the most files, each naming the
    // longest type a data URL may carry.
    const prefixes =
      MAX_STAGED_ATTACHMENTS * `data:${"x".repeat(256)};base64,`.length
    const encoded = 4 * Math.ceil((MAX_STAGED_MEGABYTES * 2 ** 20) / 3)
    const padding = MAX_STAGED_ATTACHMENTS * 4
    expect(prefixes + encoded + padding).toBeLessThanOrEqual(
      MAX_STAGED_DATA_URL_LENGTH
    )
  })

  it.each([
    ["too many files", files(MAX_STAGED_ATTACHMENTS + 1), "over 16 files"],
    [
      "a file past the size cap",
      [
        composedFile("brief.pdf"),
        composedFile("clip.mp4", MAX_STAGED_DATA_URL_LENGTH + 1),
      ],
      "clip.mp4 is over 25 MB",
    ],
    [
      "files past the size cap together",
      files(2, MAX_STAGED_DATA_URL_LENGTH / 2 + 1),
      "together over 25 MB",
    ],
  ])("refuses %s before staging, naming why", async (_, composed, why) => {
    const sent: AosStagedAttachment[][] = []
    const stage = async (staged: AosStagedAttachment[]) => {
      sent.push(staged)
      return { stageId: "stage-1" }
    }

    await expect(
      stageComposedAttachments(composed, stage, copy)
    ).rejects.toThrow(why)
    expect(sent).toEqual([])
  })

  it("stages a batch at both bounds and links what it staged", async () => {
    const composed = files(
      MAX_STAGED_ATTACHMENTS,
      MAX_STAGED_DATA_URL_LENGTH / MAX_STAGED_ATTACHMENTS
    )
    const sent: AosStagedAttachment[][] = []
    const stage = async (staged: AosStagedAttachment[]) => {
      sent.push(staged)
      return { stageId: "stage-1" }
    }

    const stagedBatch = await stageComposedAttachments(composed, stage, copy)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toHaveLength(MAX_STAGED_ATTACHMENTS)
    expect(stagedBatch).toEqual({
      stageId: "stage-1",
      attachments: composed.map(({ id, name }) => ({
        id,
        name,
        contentType: "video/mp4",
      })),
    })
  })
})
