import { describe, expect, it } from "vitest"
import { HermesAttachmentAdapter } from "./hermes-attachment-adapter"

describe("Hermes AttachmentAdapter", () => {
  it("keeps drafts removable and sends native file bytes, never text wrappers", async () => {
    const adapter = new HermesAttachmentAdapter()
    const attachment = await adapter.add({
      file: new File(["hi"], "notes.txt", { type: "text/plain" }),
    })
    expect(attachment).toMatchObject({
      type: "file",
      name: "notes.txt",
      status: { type: "requires-action", reason: "composer-send" },
    })
    await expect(adapter.remove(attachment)).resolves.toBeUndefined()
    expect(await adapter.send(attachment)).toMatchObject({
      status: { type: "complete" },
      content: [
        {
          type: "file",
          data: "data:text/plain;base64,aGk=",
          mimeType: "text/plain",
          filename: "notes.txt",
        },
      ],
    })
  })
})
