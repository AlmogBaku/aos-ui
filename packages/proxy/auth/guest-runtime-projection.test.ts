import { describe, expect, it } from "vitest"

import { INTERACTION_PROTOCOL } from "../../protocol"
import type { VerifiedGuestAuthorization } from "./guest-invitation"
import {
  projectGuestCapabilities,
  projectGuestError,
} from "./guest-runtime-projection"

const authorization: VerifiedGuestAuthorization = {
  version: 1,
  lane: "guest",
  issuer: "aos-invite",
  audience: "aos-guest",
  deploymentId: "deployment",
  principalId: "guest_ref",
  invitationId: "invite_ref",
  runtimeId: "runtime",
  agentId: "agent",
  sessionId: "ref",
  ref: "ref",
  capabilities: [
    "artifact-metadata",
    "attachment-metadata",
    "custom-ui",
    "message-text",
    "safe-errors",
  ],
  tokenId: "token",
  issuedAt: 1,
  notBefore: 1,
  expiresAt: 100,
  authorizationExpiresAt: 100,
  operation: "messages:read",
}

describe("guest runtime projection", () => {
  it("returns normalized friendly HTTP errors", async () => {
    const response = projectGuestError(
      { ...authorization, operation: "errors:read" },
      "temporarily_unavailable",
      true,
      503
    )

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "temporarily_unavailable",
        description:
          "The service is temporarily unavailable. Please try again.",
      },
    })
  })

  it("removes Agent-wide approval grants from guest capabilities", () => {
    const projected = projectGuestCapabilities({
      workspace: {
        models: {
          status: "available",
          scope: "attached-session",
          selection: "native-session",
          choices: "provider-reported",
        },
        context: {
          status: "available",
          scope: "attached-session",
          source: "provider-usage-or-estimate",
          breakdown: "provider-categories",
        },
        todos: { status: "unavailable", reason: "not-supported" },
        activity: { status: "unavailable", reason: "not-supported" },
      },
      interactions: {
        steering: {
          status: "available",
          scope: "active-turn",
          semantics: "visible-user-message",
          input: "text",
          fallback: "provider-queue",
        },
        approvals: {
          status: "available",
          protocol: INTERACTION_PROTOCOL,
          scope: "turn",
          choices: [
            { value: "once", scope: "request" },
            { value: "session", scope: "session" },
            { value: "always", scope: "agent" },
            { value: "deny", scope: "request" },
          ],
          maxPending: 1,
        },
        questions: {
          status: "available",
          protocol: INTERACTION_PROTOCOL,
          scope: "turn",
          answerModes: ["single", "multiple", "free-text"],
          cancellation: "native-empty-answer",
          maxQuestions: 10,
          maxChoicesPerQuestion: 10,
          maxAnswerValuesPerQuestion: 10,
          maxStringBytes: 2_000,
        },
        reactions: { status: "unavailable", reason: "not-supported" },
      },
      content: {
        attachments: {
          status: "available",
          scope: "attached-session",
          inputs: ["image", "file"],
          imageMimeTypes: ["image/png"],
          fileMimeTypes: "valid-type/subtype",
          maxMimeTypeBytes: 256,
          maxFilenameBytes: 4_096,
          maxCount: 8,
          maxImageBytes: 1_000_000,
          maxFileBytes: 1_000_000,
          maxTotalBytes: 2_000_000,
        },
        artifacts: { status: "unavailable", reason: "not-supported" },
        mcpApps: { status: "unavailable", reason: "not-supported" },
        transcription: { status: "unavailable", reason: "not-supported" },
        speech: { status: "unavailable", reason: "not-supported" },
      },
    })

    expect(projected?.interactions.approvals.status).toBe("available")
    expect(projected?.interactions.steering).toEqual({
      status: "unavailable",
      reason: "operator-turn-control-required",
    })
    if (projected?.interactions.approvals.status === "available")
      expect(projected.interactions.approvals.choices).toEqual([
        { value: "once", scope: "request" },
        { value: "session", scope: "session" },
        { value: "deny", scope: "request" },
      ])
  })
})
