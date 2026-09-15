import { describe, expect, it } from "vitest"
import {
  OpenClawArtifactReceipts,
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
      public: [{ filename: "brief.pdf" }],
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
  it("binds receipts to exact scope and exposes no native paths", () => {
    const x = new OpenClawArtifactReceipts()
    x.accept(
      {
        agentId: "agent-a",
        sessionId: "session-a",
        messageId: "message-a",
        runId: "run-a",
        messageSeq: 7,
      },
      {
        id: "artifact-a",
        type: "file",
        title: "brief.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
        agentId: "agent-a",
        sessionKey: "session-a",
        runId: "run-a",
        messageSeq: 7,
        download: { mode: "bytes" },
      }
    )
    expect(x.get("agent-a", "session-a", "message-a", "artifact-a")).toEqual({
      artifactId: "artifact-a",
      filename: "brief.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
    })
    expect(() =>
      x.accept(
        { agentId: "agent-a", sessionId: "session-a", messageId: "message-a" },
        {
          id: "bad",
          title: "/secret",
          agentId: "agent-a",
          sessionKey: "other",
          download: { mode: "url" },
        }
      )
    ).toThrow(OpenClawContentPublicError)
  })
  it("allows only the optional safe rich presentation", () => {
    expect(
      projectOpenClawRichPresentation({
        type: "aos.artifact-publication",
        text: "Validated brief.pdf.",
        presentation: {
          kind: "artifact",
          title: "brief.pdf",
          mimeType: "application/pdf",
        },
      })
    ).toMatchObject({
      text: "Validated brief.pdf.",
      rich: { kind: "artifact" },
    })
    expect(projectOpenClawRichPresentation({ path: "/secret" })).toBeUndefined()
  })
})
