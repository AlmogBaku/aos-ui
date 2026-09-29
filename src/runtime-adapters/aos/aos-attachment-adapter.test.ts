import { describe, expect, it } from "vitest"

import {
  AosAttachmentAdapter,
  stagedAttachmentOf,
} from "./aos-attachment-adapter"

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
})
