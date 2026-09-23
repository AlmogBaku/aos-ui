import { describe, expect, it } from "vitest"

import { OpenCodeContent, openCodeArtifactReceipt } from "./content"

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

const receipt = (artifact: Record<string, unknown>) =>
  JSON.stringify({ ok: true, type: "aos.artifact", artifact })

describe("openCodeArtifactReceipt", () => {
  it("publishes an aos-ui receipt as an opaque artifact whose id derives from the call and path", () => {
    const text = receipt({
      path: "/workspaces/aos/out/report.pdf",
      filename: "report.pdf",
      mimeType: "application/pdf",
    })
    const projected = openCodeArtifactReceipt("call-1", text)

    expect(projected).toEqual({
      path: "/workspaces/aos/out/report.pdf",
      descriptor: {
        id: expect.stringMatching(/^opencode-artifact-[0-9a-f]{32}$/u),
        filename: "report.pdf",
        mimeType: "application/pdf",
        source: { type: "provider", reference: projected?.descriptor.id },
      },
      result: {
        ok: true,
        type: "aos.artifact",
        artifact: {
          id: projected?.descriptor.id,
          filename: "report.pdf",
          mimeType: "application/pdf",
        },
      },
    })
    expect(JSON.stringify(projected?.result)).not.toContain("/workspaces")
    expect(openCodeArtifactReceipt("call-1", text)?.descriptor.id).toBe(
      projected?.descriptor.id
    )
    expect(openCodeArtifactReceipt("call-2", text)?.descriptor.id).not.toBe(
      projected?.descriptor.id
    )
  })

  it.each([
    ["malformed JSON", "{not json"],
    ["a failed receipt", JSON.stringify({ ok: false, type: "aos.artifact" })],
    [
      "a relative path",
      receipt({ path: "out/report.pdf", filename: "report.pdf" }),
    ],
    [
      "a traversing path",
      receipt({ path: "/workspaces/../etc/passwd", filename: "passwd" }),
    ],
    [
      "a sensitive path",
      receipt({ path: "/workspaces/aos/.env", filename: ".env" }),
    ],
    ["no filename", receipt({ path: "/workspaces/aos/out/report.pdf" })],
    [
      "a filename with a separator",
      receipt({ path: "/workspaces/aos/out/report.pdf", filename: "a/b.pdf" }),
    ],
    [
      "an invalid media type",
      receipt({
        path: "/workspaces/aos/out/report.pdf",
        filename: "report.pdf",
        mimeType: "pdf",
      }),
    ],
  ])("publishes no artifact for %s", (_label, text) => {
    expect(openCodeArtifactReceipt("call-1", text)).toBeUndefined()
  })
})
