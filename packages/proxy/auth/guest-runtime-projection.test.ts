import { EventType, type AGUIEvent } from "@ag-ui/core"
import { describe, expect, it } from "vitest"

import type { VerifiedGuestAuthorization } from "./guest-invitation"
import {
  createGuestRunAccess,
  projectGuestCapabilities,
  projectGuestError,
  projectGuestHistory,
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

const project = (event: AGUIEvent) =>
  createGuestRunAccess(
    authorization,
    { ...authorization, operation: "errors:read" },
    { agentId: "agent", sessionId: "stored", threadId: "ref" },
    "public-run",
    () => 10_000,
    "subscriber"
  ).project(event)

describe("guest AG-UI projection", () => {
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

  it("keeps normalized recovery state and hides the private first-turn envelope", () => {
    const projected = projectGuestHistory(
      {
        sessionId: "stored",
        messages: [
          {
            id: "seed",
            role: "user",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  v: 1,
                  type: "aos.guest.first-turn",
                  instruction: "Private setup",
                }),
              },
            ],
            createdAt: "2026-09-15T00:00:00.000Z",
          },
        ],
        total: 1,
        limit: 200,
        offset: 0,
        nextOffset: 1,
        execution: { status: "running", runId: "run-1" },
      },
      {
        ...authorization,
        firstTurn: { instruction: "Private setup" },
      },
      "ref"
    )

    expect(projected.messages).toEqual([])
    expect(projected.execution).toEqual({ status: "running", runId: "run-1" })
  })

  it("does not hide an ordinary user message that resembles a private seed", () => {
    const envelope = JSON.stringify({
      v: 1,
      type: "aos.guest.first-turn",
      instruction: "Private setup",
    })
    const projected = projectGuestHistory(
      {
        sessionId: "stored",
        messages: [
          {
            id: "ordinary",
            role: "user",
            content: [{ type: "text", text: "Hello" }],
            createdAt: "2026-09-15T00:00:00.000Z",
          },
          {
            id: "lookalike",
            role: "user",
            content: [{ type: "text", text: envelope }],
            createdAt: "2026-09-15T00:00:01.000Z",
          },
        ],
        total: 2,
        limit: 200,
        offset: 0,
        nextOffset: 2,
      },
      {
        ...authorization,
        firstTurn: { instruction: "Private setup" },
      },
      "ref"
    )

    expect(projected.messages).toHaveLength(2)
    expect(projected.messages[1]).toMatchObject({
      content: [{ type: "text", text: envelope }],
    })
  })

  it("preserves only normalized attachment metadata in guest history", () => {
    const projected = projectGuestHistory(
      {
        sessionId: "stored",
        messages: [
          {
            id: "message",
            role: "user",
            content: [{ type: "text", text: "what do you see?" }],
            attachments: [
              {
                id: "message:attachment:0",
                type: "file",
                name: "click.mov",
                contentType: "video/quicktime",
                status: { type: "complete" },
                content: [],
              },
            ],
            createdAt: "2026-09-15T00:00:00.000Z",
          },
        ],
        total: 1,
        limit: 200,
        offset: 0,
        nextOffset: 1,
      },
      authorization,
      "ref"
    )

    expect(projected.messages[0]).toMatchObject({
      content: [{ type: "text", text: "what do you see?" }],
      attachments: [
        {
          type: "file",
          name: "click.mov",
          contentType: "video/quicktime",
        },
      ],
    })
    expect(JSON.stringify(projected)).not.toContain(".hermes")
    expect(JSON.stringify(projected)).not.toContain("@file:")
  })

  it("removes Agent-wide approval grants from guest capabilities", () => {
    const projected = projectGuestCapabilities({
      agent: {
        identity: { type: "hermes", provider: "private-provider" },
        transport: { streaming: true, resumable: true },
        reasoning: { supported: true, streaming: true },
        multimodal: {
          input: { image: true, audio: false, file: true },
          output: { audio: false },
        },
        humanInTheLoop: {
          supported: true,
          approvals: true,
          interrupts: true,
        },
      },
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
          scope: "active-run",
          semantics: "visible-user-message",
          input: "text",
          fallback: "provider-queue",
        },
        approvals: {
          status: "available",
          protocol: "ag-ui-interrupt",
          scope: "run",
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
          protocol: "ag-ui-interrupt",
          scope: "run",
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
        transcription: { status: "unavailable", reason: "not-supported" },
        speech: { status: "unavailable", reason: "not-supported" },
      },
    })

    expect(projected?.interactions.approvals.status).toBe("available")
    expect(projected?.interactions.steering).toEqual({
      status: "unavailable",
      reason: "operator-run-control-required",
    })
    if (projected?.interactions.approvals.status === "available")
      expect(projected.interactions.approvals.choices).toEqual([
        { value: "once", scope: "request" },
        { value: "session", scope: "session" },
        { value: "deny", scope: "request" },
      ])
  })

  it("preserves only normalized PLAN activity snapshots and deltas", () => {
    const todos = [{ id: "todo-1", label: "Review", status: "active" }]

    expect(
      project({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "plan",
        activityType: "PLAN",
        content: { todos },
        replace: true,
        rawEvent: { native: "secret" },
      })
    ).toEqual({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "plan",
      activityType: "PLAN",
      content: { todos },
      replace: true,
    })
    expect(
      project({
        type: EventType.ACTIVITY_DELTA,
        messageId: "plan",
        activityType: "PLAN",
        patch: [{ op: "replace", path: "/todos", value: todos }],
      })
    ).toEqual({
      type: EventType.ACTIVITY_DELTA,
      messageId: "plan",
      activityType: "PLAN",
      patch: [{ op: "replace", path: "/todos", value: todos }],
    })
    expect(
      project({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "secret",
        activityType: "TRACE",
        content: { providerPath: "/private" },
      })
    ).toBeUndefined()
  })

  it("preserves safe artifact data and drops provider fields and other custom events", () => {
    expect(
      project({
        type: EventType.CUSTOM,
        name: "aos.artifact",
        value: {
          id: "report-1",
          filename: "report.md",
          mimeType: "text/markdown",
          sizeBytes: 42,
          source: { type: "provider", reference: "report-1" },
          providerPath: "/private/report.md",
        },
      })
    ).toEqual({
      type: EventType.CUSTOM,
      name: "aos.artifact",
      value: {
        id: "report-1",
        filename: "report.md",
        mimeType: "text/markdown",
        sizeBytes: 42,
        source: { type: "provider", reference: "report-1" },
      },
    })
    expect(
      project({ type: EventType.CUSTOM, name: "hermes.native", value: {} })
    ).toBeUndefined()
  })

  it.each([
    ["AOS_CONNECTION_INTERRUPTED", "AOS_CONNECTION_INTERRUPTED"],
    ["AOS_SEND_UNCERTAIN", "AOS_SEND_UNCERTAIN"],
    ["AOS_INTERACTION_UNCERTAIN", "AOS_INTERACTION_UNCERTAIN"],
    ["AOS_STOP_UNCERTAIN", "AOS_STOP_UNCERTAIN"],
    ["AOS_RESET_REQUIRED", "temporarily_unavailable"],
    ["AOS_STREAM_OVERFLOW", "temporarily_unavailable"],
    ["AOS_PROVIDER_RETRYABLE_FAILURE", "temporarily_unavailable"],
    ["AOS_PROVIDER_AGENT_UNAVAILABLE", "temporarily_unavailable"],
    ["AOS_SESSION_BUSY", "rate_limited"],
    ["AOS_PROVIDER_RUN_FAILED", "request_failed"],
    ["AOS_PROVIDER_BILLING_FAILED", "request_failed"],
    ["AOS_INTERACTION_EXPIRED", "request_failed"],
    ["AOS_UNKNOWN_TO_THIS_BUILD", "request_failed"],
    ["constructor", "request_failed"],
    ["toString", "request_failed"],
  ])("projects the run error code %s as %s", (code, expected) => {
    const projected = project({
      type: EventType.RUN_ERROR,
      code,
      message: "Hermes said something private about /private/path",
    })

    expect(projected).toMatchObject({
      type: EventType.RUN_ERROR,
      code: expected,
    })
    expect(String((projected as { message?: string })?.message)).not.toContain(
      "/private/path"
    )
  })
})
