import { describe, expect, it } from "vitest"

import {
  mapOpenCodeRichTool,
  OpenCodeContent,
  OpenCodeContentUnavailableError,
} from "./content"

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
    expect(stage.appendTo("Review")).toContain("[attachment: notes.txt]")
    expect(JSON.stringify(stage)).not.toMatch(/path|native/i)
  })

  it("accepts only the supported AOS artifact receipt shape", () => {
    const content = new OpenCodeContent()

    expect(
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
    ).toEqual({
      id: "artifact-1",
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 12,
    })
    expect(() =>
      content.artifactReceipt({ path: "/private/report.pdf" })
    ).toThrow(OpenCodeContentUnavailableError)
  })

  it("maps only integration-advertised rich tool input and drops raw provider fields", () => {
    expect(
      mapOpenCodeRichTool({
        tool: "render_stats",
        state: {
          status: "completed",
          input: {
            title: "Build",
            stats: [{ key: "tests", label: "Tests", value: 5 }],
            nativePath: "/private/worktree",
          },
          output: "Build is ready for display.",
        },
      })
    ).toEqual({
      kind: "stats",
      data: {
        title: "Build",
        stats: [{ key: "tests", label: "Tests", value: 5 }],
      },
      fallback: "Build is ready for display.",
    })
    expect(
      mapOpenCodeRichTool({ tool: "shell", state: { input: {} } })
    ).toBeUndefined()
  })
})
