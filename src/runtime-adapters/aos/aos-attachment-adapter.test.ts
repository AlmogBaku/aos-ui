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

  it("reads a staged file batch back off the composed attachment", async () => {
    const adapter = new AosAttachmentAdapter()
    const pending = await adapter.add({
      file: new File(["brief"], "brief.txt", { type: "text/plain" }),
    })

    expect(stagedAttachmentOf(await adapter.send(pending))).toEqual({
      type: "file",
      dataUrl: expect.stringMatching(/^data:text\/plain;base64,/u),
      filename: "brief.txt",
      mimeType: "text/plain",
    })
  })

  it("reads a staged image batch back off the composed attachment", async () => {
    const adapter = new AosAttachmentAdapter()
    const pending = await adapter.add({
      file: new File(["chart"], "chart.png", { type: "image/png" }),
    })

    expect(stagedAttachmentOf(await adapter.send(pending))).toEqual({
      type: "image",
      dataUrl: expect.stringMatching(/^data:image\/png;base64,/u),
      filename: "chart.png",
      mimeType: "image/png",
    })
  })

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
