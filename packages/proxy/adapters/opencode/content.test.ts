import { describe, expect, it } from "vitest"

import { OpenCodeContent, OpenCodeContentUnavailableError } from "./content"

describe("OpenCodeContent", () => {
  it("stages a bounded batch without exposing a native path", () => {
    const content = new OpenCodeContent()
    const stage = content.stage([
      {
        type: "file",
        dataUrl: "data:text/plain;base64,SGVsbG8=",
        filename: "notes.txt",
      },
    ])

    expect(stage.public).toEqual([
      { type: "file", filename: "notes.txt", mimeType: "text/plain" },
    ])
    expect(stage.appendTo("Review")).toBe("Review")
    expect(stage.files).toEqual([
      { uri: "data:text/plain;base64,SGVsbG8=", name: "notes.txt" },
    ])
    expect(JSON.stringify(stage)).not.toMatch(/path|native/i)
  })

  it("keeps artifact download unavailable rather than exporting an unscoped receipt", () => {
    const content = new OpenCodeContent()

    expect(() =>
      content.artifactReceipt({
        metadata: {
          aos_ui: {
            kind: "artifact",
            id: "artifact-1",
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 12,
          },
        },
        attachments: [
          {
            type: "file",
            filename: "report.pdf",
            mime: "application/pdf",
            url: "data:application/pdf;base64,AQID",
          },
        ],
      })
    ).toThrow(OpenCodeContentUnavailableError)
    expect(() =>
      content.artifactReceipt({ path: "/private/report.pdf" })
    ).toThrow(OpenCodeContentUnavailableError)
  })
})
