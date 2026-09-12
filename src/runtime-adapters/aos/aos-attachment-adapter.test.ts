import { describe, expect, it } from "vitest"

import { AosAttachmentAdapter } from "./aos-attachment-adapter"

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
})
