import { describe, expect, it } from "vitest"

import { OpenCodeContent } from "./content"

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
})
