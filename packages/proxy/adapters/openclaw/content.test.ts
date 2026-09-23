import { describe, expect, it } from "vitest"
import {
  OpenClawContentPublicError,
  prepareOpenClawChatAttachments,
  readOpenClawChatAttachments,
  stageOpenClawChatAttachments,
} from "./content"
const policy = {
  maxPayload: 30 * 1024 * 1024,
  attachments: {
    maxBytes: 25 * 1024 * 1024,
    maxImageBytes: 10 * 1024 * 1024,
  },
}
describe("OpenClaw content", () => {
  it("validates complete encoded native requests", () => {
    expect(
      prepareOpenClawChatAttachments(
        {
          agentId: "agent-a",
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
        },
        policy
      )
    ).toMatchObject({
      native: {
        agentId: "agent-a",
        attachments: [{ fileName: "brief.pdf", sizeBytes: 3 }],
      },
    })
    expect(() =>
      prepareOpenClawChatAttachments(
        {
          agentId: "agent-a",
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
        },
        policy
      )
    ).toThrow(OpenClawContentPublicError)
  })
  it("carries validated inputs privately from staging to native admission", () => {
    const staged = stageOpenClawChatAttachments(
      [
        {
          type: "file",
          filename: "brief.pdf",
          mimeType: "application/pdf",
          dataUrl: "data:application/pdf;base64,AQID",
        },
      ],
      policy
    )

    expect(staged.public).toEqual([
      {
        type: "file",
        filename: "brief.pdf",
        mimeType: "application/pdf",
      },
    ])
    expect(staged.appendTo("Review")).toBe("Review")
    expect(readOpenClawChatAttachments(staged)).toEqual({
      attachments: [
        {
          type: "file",
          filename: "brief.pdf",
          mimeType: "application/pdf",
          dataUrl: "data:application/pdf;base64,AQID",
        },
      ],
      policy,
    })
    expect(JSON.stringify(staged)).not.toContain("AQID")
  })
  it("validates the complete encoded request against the negotiated frame limit", () => {
    expect(() =>
      prepareOpenClawChatAttachments(
        {
          agentId: "agent-a",
          sessionKey: "session-a",
          message: "review",
          idempotencyKey: "turn-a",
          attachments: [
            {
              type: "file",
              dataUrl: "data:text/plain;base64,AQID",
            },
          ],
        },
        { ...policy, maxPayload: 128 }
      )
    ).toThrow(OpenClawContentPublicError)
  })
})
