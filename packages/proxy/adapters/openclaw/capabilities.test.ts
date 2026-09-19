import { describe, expect, it } from "vitest"
import { SessionWorkspaceCapabilitiesResponseSchema } from "../../../protocol"
import { openClawCapabilities } from "./capabilities"

describe("OpenClaw capabilities", () => {
  it("returns provider-neutral fragments with negotiated attachment limits", () => {
    const capabilities = openClawCapabilities({
      maxPayload: 30 * 1024 * 1024,
      attachments: {
        maxBytes: 25 * 1024 * 1024,
        maxImageBytes: 10 * 1024 * 1024,
      },
    })

    expect(
      SessionWorkspaceCapabilitiesResponseSchema.shape.interactions.parse(
        capabilities.interactions
      )
    ).toEqual({
      steering: {
        status: "unavailable",
        reason: "active-run-steering-unavailable",
      },
      approvals: {
        status: "available",
        protocol: "acp-request",
        scope: "run",
        choices: [
          { value: "once", scope: "request" },
          { value: "always", scope: "agent" },
          { value: "deny", scope: "request" },
        ],
        maxPending: 64,
      },
      questions: {
        status: "available",
        protocol: "acp-request",
        scope: "run",
        answerModes: ["single", "multiple", "free-text"],
        cancellation: "native-cancel",
        maxQuestions: 3,
        maxChoicesPerQuestion: 4,
        maxAnswerValuesPerQuestion: "complete-request",
        maxStringBytes: 4096,
      },
      reactions: {
        status: "unavailable",
        reason: "interaction-reactions-unavailable",
      },
    })
    expect(
      SessionWorkspaceCapabilitiesResponseSchema.shape.content.parse(
        capabilities.content
      )
    ).toEqual({
      attachments: {
        status: "available",
        scope: "attached-session",
        inputs: ["image", "file"],
        imageMimeTypes: "provider-dependent",
        fileMimeTypes: "provider-dependent",
        maxMimeTypeBytes: 256,
        maxFilenameBytes: 255,
        maxCount: 16,
        maxImageBytes: 10 * 1024 * 1024,
        maxFileBytes: 25 * 1024 * 1024,
        maxTotalBytes: "complete-request",
        maxEncodedRequestBytes: 30 * 1024 * 1024,
        completeRequestValidation: "native-run-input",
      },
      artifacts: {
        status: "unavailable",
        reason: "artifact-publication-unavailable",
      },
      transcription: {
        status: "unavailable",
        reason: "audio-transcription-unavailable",
      },
      speech: {
        status: "unavailable",
        reason: "audio-speech-unavailable",
      },
    })
    expect(JSON.stringify(capabilities)).not.toMatch(
      /question\.resolve|approval\.resolve|chat\.send|@openclaw/u
    )
  })
})
