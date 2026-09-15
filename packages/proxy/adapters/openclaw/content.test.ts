import { describe, expect, it } from "vitest"
import {
  OpenClawContentPublicError,
  prepareOpenClawChatAttachments,
  projectOpenClawRichPresentation,
} from "./content"
describe("OpenClaw content", () => {
  it("validates complete encoded native requests", () => {
    expect(
      prepareOpenClawChatAttachments({
        sessionKey: "session-a",
        message: "review",
        idempotencyKey: "turn-a",
        attachments: [
          {
            type: "file",
            filename: "brief.pdf",
            mimeType: "application/pdf",
            dataUrl: "data:application/pdf;base64,AQID",
          },
        ],
      })
    ).toMatchObject({
      native: { attachments: [{ fileName: "brief.pdf", sizeBytes: 3 }] },
    })
    expect(() =>
      prepareOpenClawChatAttachments({
        sessionKey: "session-a",
        message: "review",
        idempotencyKey: "turn-a",
        attachments: [
          {
            type: "file",
            filename: "../secret",
            dataUrl: "data:text/plain;base64,AQID",
          },
        ],
      })
    ).toThrow(OpenClawContentPublicError)
  })
  it("keeps the actual plugin's unsupported publication as text only", () => {
    expect(
      projectOpenClawRichPresentation({
        text: "Validated brief.pdf, but it was not published.",
        details: {
          type: "aos.artifact-publication",
          status: "unsupported",
          published: false,
          candidate: { path: "private.pdf" },
        },
      })
    ).toEqual({ text: "Validated brief.pdf, but it was not published." })
    expect(projectOpenClawRichPresentation({ path: "/secret" })).toBeUndefined()
  })
})
