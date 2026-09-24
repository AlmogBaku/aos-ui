import { describe, expect, it } from "vitest"

import type { VerifiedGuestAuthorization } from "../../auth/guest-invitation"
import { guestErrorDescription } from "../../auth/guest-projection"
import {
  CompactionStatus,
  PendingRequestKind,
  StopReason,
  TurnEventKind,
  TurnEventSchema,
  type TurnEvent,
} from "../../core/events"
import { createTurnProjector } from "./turns"

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

/** One guest turn stream's projector. */
const projectorOf = () =>
  createTurnProjector(
    { agentId: "agent", threadId: "ref" },
    authorization,
    { ...authorization, operation: "errors:read" },
    () => 10_000
  )

/** One turn event, validated the way the projector validates it. */
const project = (event: TurnEvent) =>
  projectorOf()(TurnEventSchema.parse(event))

describe("guest turn projection", () => {
  it("drops turn usage, cost, the composer prefill, and saved ids but keeps the stop reason", () => {
    expect(
      project({
        kind: TurnEventKind.TurnEnded,
        usage: [{ provider: "private", totalTokens: 12 }],
        cost: { amount: 0.5, currency: "USD" },
        composerPrefill: "/private",
        // The guest's live ids are hashed, so a native saved id would name
        // rows its projection may hide.
        saved: {
          user: { messageId: "user-1", savedId: "hermes-row-7" },
          replyId: "hermes-row-8",
        },
      })
    ).toEqual({ kind: TurnEventKind.TurnEnded })
    expect(
      project({
        kind: TurnEventKind.TurnEnded,
        stopReason: StopReason.Refusal,
        cost: { amount: 0.5, currency: "USD" },
      })
    ).toEqual({ kind: TurnEventKind.TurnEnded, stopReason: StopReason.Refusal })
    expect(project({ kind: TurnEventKind.TurnStarted })).toEqual({
      kind: TurnEventKind.TurnStarted,
    })
  })

  it("renames assistant prose and drops reasoning and tool calls", () => {
    const projected = project({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "Hello",
    })

    expect(projected).toMatchObject({
      kind: TurnEventKind.MessageChunk,
      text: "Hello",
    })
    expect(projected).not.toMatchObject({ messageId: "assistant-1" })
    expect(
      project({
        kind: TurnEventKind.ThoughtChunk,
        messageId: "assistant-1",
        text: "private reasoning",
      })
    ).toBeUndefined()
    expect(
      project({
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "tool-1",
        title: "terminal",
      })
    ).toBeUndefined()
  })

  it("drops a subagent's prose and every tool, terminal, compaction, and model fact", () => {
    const hidden: TurnEvent[] = [
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "child prose",
        subagentId: "sub-1",
      },
      { kind: TurnEventKind.ToolCallOutputChunk, toolCallId: "t", text: "ls" },
      {
        kind: TurnEventKind.TerminalOutput,
        terminalId: "term-1",
        toolCallId: "t",
        command: "ls",
        data: "secret.txt",
      },
      {
        kind: TurnEventKind.CompactionUpdated,
        compactionId: "c1",
        status: CompactionStatus.Completed,
        summary: "private context",
      },
      { kind: TurnEventKind.ModelChanged, modelId: "private-model" },
      {
        kind: TurnEventKind.SubagentUpdated,
        toolCallId: "t",
        subagent: { id: "sub-1", goal: "private goal" },
      },
    ]

    for (const event of hidden)
      expect(project(event), event.kind).toBeUndefined()
  })

  it("passes an MCP App call's card to a guest and hides any other tool call", () => {
    const projector = projectorOf()
    const projectOne = (event: TurnEvent) =>
      projector(TurnEventSchema.parse(event))

    expect(
      projectOne({
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "chart-1",
        title: "Render chart",
        name: "render_chart",
        parentMessageId: "assistant-native",
        app: true,
      })
    ).toEqual({
      kind: TurnEventKind.ToolCallStarted,
      toolCallId: "chart-1",
      title: "render_chart",
      name: "render_chart",
      app: true,
    })
    expect(
      projectOne({
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "chart-1",
        output: "private data",
        failed: false,
        app: true,
      })
    ).toEqual({
      kind: TurnEventKind.ToolCallFinished,
      toolCallId: "chart-1",
      output: "",
      failed: false,
      app: true,
      name: "render_chart",
    })
    expect(
      projectOne({
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "read-1",
        title: "read_file",
      })
    ).toBeUndefined()
    expect(
      projectOne({
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "read-1",
        output: "private file",
        failed: false,
      })
    ).toBeUndefined()
  })

  it("keeps a failure's provider and model from guests", () => {
    expect(
      project({
        kind: TurnEventKind.TurnFailed,
        code: "AOS_PROVIDER_ERROR",
        message: "private",
        provider: "private-provider",
        model: "private-model",
      })
    ).not.toMatchObject({ provider: expect.anything() })
  })

  it("projects pending requests without approval internals", () => {
    expect(
      project({
        kind: TurnEventKind.TurnRequiresAction,
        requests: [
          {
            requestId: "approval-1",
            kind: PendingRequestKind.Permission,
            message: "Run the command?",
            responseSchema: {
              type: "string",
              enum: ["once", "always", "deny"],
            },
          },
        ],
      })
    ).toEqual({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [
        {
          requestId: "approval-1",
          kind: PendingRequestKind.Permission,
          message: "Run the command?",
          responseSchema: { type: "string", enum: ["once", "deny"] },
        },
      ],
    })
  })

  it("preserves the normalized Todo list", () => {
    const todos = [{ id: "todo-1", label: "Review", status: "active" as const }]

    expect(project({ kind: TurnEventKind.PlanUpdated, todos })).toEqual({
      kind: TurnEventKind.PlanUpdated,
      todos,
    })
  })

  it("preserves a provider-held artifact and drops inline data", () => {
    expect(
      project({
        kind: TurnEventKind.ArtifactPublished,
        artifact: {
          id: "report-1",
          filename: "report.md",
          mimeType: "text/markdown",
          sizeBytes: 42,
          source: { type: "provider", reference: "report-1" },
        },
      })
    ).toEqual({
      kind: TurnEventKind.ArtifactPublished,
      artifact: {
        id: "report-1",
        filename: "report.md",
        mimeType: "text/markdown",
        sizeBytes: 42,
        source: { type: "provider", reference: "report-1" },
      },
    })
    expect(
      project({
        kind: TurnEventKind.ArtifactPublished,
        artifact: {
          id: "report-2",
          filename: "report.md",
          source: { type: "inline", encoding: "utf8", data: "private" },
        },
      })
    ).toBeUndefined()
    expect(
      project({
        kind: TurnEventKind.ArtifactPublished,
        artifact: {
          id: "report-3",
          filename: "report.md",
          source: { type: "provider", reference: "/private/report.md" },
        },
      })
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
    ["AOS_SESSION_LIMIT", "rate_limited"],
    ["AOS_PROVIDER_RUN_FAILED", "request_failed"],
    ["AOS_PROVIDER_BILLING_FAILED", "request_failed"],
    ["AOS_INTERACTION_EXPIRED", "request_failed"],
    ["AOS_INTERACTION_LOST", "request_failed"],
    ["AOS_SESSION_IN_USE", "request_failed"],
    ["AOS_UNKNOWN_TO_THIS_BUILD", "request_failed"],
    ["constructor", "request_failed"],
    ["toString", "request_failed"],
  ])("projects the run error code %s as %s", (code, expected) => {
    const projected = project({
      kind: TurnEventKind.TurnFailed,
      code,
      message: "Hermes said something private about /private/path",
    })

    expect(projected).toMatchObject({
      kind: TurnEventKind.TurnFailed,
      code: expected,
    })
    expect(String((projected as { message?: string })?.message)).not.toContain(
      "/private/path"
    )
  })

  it("never projects the provider detail of a run failure to a guest", () => {
    const projected = project({
      kind: TurnEventKind.TurnFailed,
      code: "AOS_PROVIDER_RETRYABLE_FAILURE",
      message:
        "Hermes' model provider returned an error for this turn. Retry, switch models with /model, or continue in a new Session.\nAn error occurred (ValidationException) when calling the InvokeModel operation",
    })

    expect(projected).toEqual({
      kind: TurnEventKind.TurnFailed,
      code: "temporarily_unavailable",
      message: guestErrorDescription("temporarily_unavailable"),
    })
    expect(JSON.stringify(projected)).not.toContain("ValidationException")
  })

  it("keeps a guest run whose failure awaits Stop stoppable", () => {
    expect(
      project({
        kind: TurnEventKind.TurnFailed,
        code: "AOS_INTERACTION_LOST",
        message: "Hermes lost the question",
        awaitingStop: true,
      })
    ).toEqual({
      kind: TurnEventKind.TurnFailed,
      code: "request_failed",
      message: guestErrorDescription("request_failed"),
      awaitingStop: true,
    })
  })
})
