import { describe, expect, it } from "vitest"

import type { GuestAuthorization } from "./guest-invitation"
import { projectGuestOutbound } from "./guest-projection"

const authorization: GuestAuthorization = {
  version: 1,
  lane: "guest",
  issuer: "https://aos.example.test",
  audience: "aos-guest",
  deploymentId: "aos-prod-il1",
  principalId: "guest_4Ez4k6W5",
  invitationId: "invite_Q9mZ2",
  runtimeId: "hermes-primary",
  agentId: "agent_planner",
  sessionId: "session_launch",
  operation: "messages:read",
  capabilities: [
    "artifact-metadata",
    "attachment-metadata",
    "custom-ui",
    "message-text",
    "safe-errors",
  ],
  tokenId: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
  issuedAt: 1_700_000_000,
  notBefore: 1_700_000_000,
  expiresAt: 1_700_000_300,
}

describe("guest outbound projection", () => {
  it("projects only guest-safe message content from REST and turn envelopes", () => {
    const message = {
      type: "message",
      role: "assistant",
      text: "The launch checklist is ready.",
      customUi: {
        type: "card",
        title: "Launch",
        text: "Ready",
        items: ["Review", "Publish"],
      },
      attachments: [
        {
          name: "brief.pdf",
          mediaType: "application/pdf",
          sizeBytes: 412,
          id: "native-file-9",
          providerPath: "/srv/hermes/private/brief.pdf",
        },
      ],
      artifacts: [
        {
          name: "plan.md",
          mediaType: "text/markdown",
          sizeBytes: 120,
          digest: "sha256:abc123",
          liveId: "artifact-live-7",
        },
      ],
      reasoning: "Operator token is hms_secret",
      rawToolArguments: { token: "hms_secret" },
      rawToolResult: { nativeAgentId: "native-1" },
      approval: { approvedBy: "operator_1" },
      nativeMetadata: { provider: "hermes" },
      providerPath: "/native/messages/88",
      liveId: "message-live-88",
      nativePosition: 44,
    }

    for (const transport of ["rest", "turn"] as const) {
      expect(
        projectGuestOutbound(
          {
            transport,
            agentId: "agent_planner",
            sessionId: "session_launch",
            payload: message,
            nativeMetadata: { cursor: "native-cursor" },
            providerPath: "/api/hermes/ws",
            liveId: "event-123",
            nativePosition: 8,
          },
          authorization
        )
      ).toEqual({
        transport,
        agentId: "agent_planner",
        sessionId: "session_launch",
        payload: {
          type: "message",
          role: "assistant",
          text: "The launch checklist is ready.",
          customUi: {
            type: "card",
            title: "Launch",
            text: "Ready",
            items: ["Review", "Publish"],
          },
        },
      })
    }
  })

  it("never emits privileged roles, reasoning, tool internals, approvals, native data, paths, or live IDs", () => {
    for (const role of ["operator", "system", "developer", "tool"]) {
      expect(
        projectGuestOutbound(
          {
            transport: "turn",
            agentId: "agent_planner",
            sessionId: "session_launch",
            payload: {
              type: "message",
              role,
              text: "secret",
              reasoning: "chain of thought",
              rawToolArguments: { secret: "hms_token" },
              rawToolResult: { result: "private" },
              approval: { state: "approved" },
              nativeMetadata: { provider: "hermes" },
              providerPath: "/private",
              liveId: "live-1",
              nativePosition: 2,
            },
          },
          authorization
        )
      ).toBeUndefined()
    }
  })

  it("uses both operation and capability ceilings without implicit expansion", () => {
    const reduced: GuestAuthorization = {
      ...authorization,
      operation: "messages:read",
      capabilities: ["message-text"],
    }

    expect(
      projectGuestOutbound(
        {
          transport: "turn",
          agentId: "agent_planner",
          sessionId: "session_launch",
          payload: {
            type: "message",
            role: "assistant",
            text: "Public",
            customUi: { type: "status", text: "Hidden" },
            attachments: [
              {
                name: "hidden.pdf",
                mediaType: "application/pdf",
                sizeBytes: 2,
              },
            ],
            artifacts: [
              { name: "hidden.md", mediaType: "text/markdown", sizeBytes: 2 },
            ],
          },
        },
        reduced
      )
    ).toEqual({
      transport: "turn",
      agentId: "agent_planner",
      sessionId: "session_launch",
      payload: { type: "message", role: "assistant", text: "Public" },
    })
  })

  it("projects only the outbound family bound by the verified operation", () => {
    const payload = {
      type: "message",
      role: "assistant",
      text: "Message text",
      attachments: [
        { name: "brief.pdf", mediaType: "application/pdf", sizeBytes: 412 },
      ],
      artifacts: [
        {
          name: "plan.md",
          mediaType: "text/markdown",
          sizeBytes: 120,
          digest: "sha256:abc123",
        },
      ],
    }
    const envelope = {
      transport: "turn",
      agentId: "agent_planner",
      sessionId: "session_launch",
      payload,
    }

    expect(
      projectGuestOutbound(envelope, {
        ...authorization,
        operation: "messages:read",
      })
    ).toMatchObject({ payload: { text: "Message text" } })
    expect(
      projectGuestOutbound(envelope, {
        ...authorization,
        operation: "attachments:read",
      })
    ).toMatchObject({ payload: { attachments: [{ name: "brief.pdf" }] } })
    expect(
      projectGuestOutbound(envelope, {
        ...authorization,
        operation: "artifacts:read",
      })
    ).toMatchObject({ payload: { artifacts: [{ name: "plan.md" }] } })
    expect(
      projectGuestOutbound(envelope, {
        ...authorization,
        operation: "messages:create",
      })
    ).toBeUndefined()
    expect(
      projectGuestOutbound(envelope, {
        ...authorization,
        operation: "errors:read",
      })
    ).toBeUndefined()
  })

  it("projects artifact and safe error metadata only when explicitly scoped", () => {
    expect(
      projectGuestOutbound(
        {
          transport: "artifact",
          agentId: "agent_planner",
          sessionId: "session_launch",
          payload: {
            type: "artifact",
            name: "report.csv",
            mediaType: "text/csv",
            sizeBytes: 90,
            digest: "sha256:def456",
            id: "native-artifact-id",
            path: "/srv/hermes/report.csv",
            url: "http://hermes.internal/report.csv",
            nativeMetadata: { bucket: "private" },
            liveId: "live-artifact",
          },
        },
        { ...authorization, operation: "artifacts:read" }
      )
    ).toEqual({
      transport: "artifact",
      agentId: "agent_planner",
      sessionId: "session_launch",
      payload: {
        type: "artifact",
        name: "report.csv",
        mediaType: "text/csv",
        sizeBytes: 90,
        digest: "sha256:def456",
      },
    })
    expect(
      projectGuestOutbound(
        {
          transport: "error",
          agentId: "agent_planner",
          sessionId: "session_launch",
          payload: {
            type: "error",
            code: "temporarily_unavailable",
            message: "Please retry.",
            retryable: true,
            stack: "token=hms_secret",
            details: { nativeRequestId: "req-1" },
            nativeMetadata: { provider: "hermes" },
          },
        },
        { ...authorization, operation: "errors:read" }
      )
    ).toEqual({
      transport: "error",
      agentId: "agent_planner",
      sessionId: "session_launch",
      payload: {
        type: "error",
        code: "temporarily_unavailable",
        retryable: true,
      },
    })
  })

  it("omits provider error text containing tokens, URLs, paths, UNC paths, and live IDs", () => {
    const projected = projectGuestOutbound(
      {
        transport: "error",
        agentId: "agent_planner",
        sessionId: "session_launch",
        payload: {
          type: "error",
          code: "request_failed",
          message:
            "Bearer hms_super_secret at https://hermes.internal/private /srv/hermes/private C:\\Users\\operator\\secret \\\\server\\share live-event-123",
          retryable: false,
          stack: "at /srv/hermes/server.ts:4",
          details: {
            token: "hms_super_secret",
            url: "https://hermes.internal/private",
            path: "/srv/hermes/private",
            windowsPath: "C:\\Users\\operator\\secret",
            uncPath: "\\\\server\\share",
            liveId: "live-event-123",
          },
          nativeMetadata: { provider: "hermes" },
        },
      },
      { ...authorization, operation: "errors:read" }
    )

    expect(JSON.stringify(projected)).toBe(
      '{"transport":"error","agentId":"agent_planner","sessionId":"session_launch","payload":{"type":"error","code":"request_failed","retryable":false}}'
    )
    expect(
      projectGuestOutbound(
        {
          transport: "error",
          agentId: "agent_planner",
          sessionId: "session_launch",
          payload: {
            type: "error",
            code: "hms_super_secret",
            retryable: false,
          },
        },
        { ...authorization, operation: "errors:read" }
      )
    ).toBeUndefined()
  })

  it("retains only canonical friendly error descriptions", () => {
    expect(
      projectGuestOutbound(
        {
          transport: "error",
          agentId: "agent_planner",
          sessionId: "session_launch",
          payload: {
            type: "error",
            code: "temporarily_unavailable",
            description:
              "The service is temporarily unavailable. Please try again.",
            retryable: true,
            message: "Bearer native-secret at /srv/hermes/private",
          },
        },
        { ...authorization, operation: "errors:read" }
      )
    ).toMatchObject({
      payload: {
        code: "temporarily_unavailable",
        description:
          "The service is temporarily unavailable. Please try again.",
      },
    })

    expect(
      projectGuestOutbound(
        {
          transport: "error",
          agentId: "agent_planner",
          sessionId: "session_launch",
          payload: {
            type: "error",
            code: "temporarily_unavailable",
            description: "Retry via https://private.example/token",
            retryable: true,
          },
        },
        { ...authorization, operation: "errors:read" }
      )
    ).toBeUndefined()
  })

  it("projects public request fields without approval internals", () => {
    const envelope = {
      transport: "turn",
      agentId: "agent_planner",
      sessionId: "session_launch",
      payload: {
        type: "requests",
        requests: [
          {
            requestId: "approval-1",
            kind: "permission",
            message: "Allow deployment?",
            expiresAt: "2026-09-15T20:00:00.000Z",
            responseSchema: {
              type: "string",
              enum: ["deny", "once", "always"],
            },
          },
        ],
      },
    }

    expect(
      projectGuestOutbound({ ...envelope, transport: "rest" }, authorization)
    ).toBeUndefined()
    expect(projectGuestOutbound(envelope, authorization)).toEqual({
      transport: "turn",
      agentId: "agent_planner",
      sessionId: "session_launch",
      payload: {
        type: "requests",
        requests: [
          {
            requestId: "approval-1",
            kind: "permission",
            message: "Allow deployment?",
            responseSchema: {
              type: "string",
              enum: ["deny", "once"],
            },
          },
        ],
      },
    })
  })

  it("keeps a guest's question schema, words and label alike", () => {
    // The words of a question describe its answer field. Dropping an unknown
    // key here would take the whole schema with it and leave the guest a
    // question with no answer field at all.
    expect(
      projectGuestOutbound(
        {
          transport: "turn",
          agentId: "agent_planner",
          sessionId: "session_launch",
          payload: {
            type: "requests",
            requests: [
              {
                requestId: "clarify-1",
                kind: "elicitation",
                message: "1 question requires an answer",
                responseSchema: {
                  type: "string",
                  title: "Region",
                  description: "Which region?",
                  enum: ["eu", "us"],
                },
              },
            ],
          },
        },
        authorization
      )
    ).toMatchObject({
      payload: {
        requests: [
          {
            responseSchema: {
              type: "string",
              title: "Region",
              description: "Which region?",
              enum: ["eu", "us"],
            },
          },
        ],
      },
    })
  })

  it("rejects cross-Agent and cross-Session projection", () => {
    const payload = {
      type: "message",
      role: "assistant",
      text: "Do not cross scope.",
    }

    expect(
      projectGuestOutbound(
        { transport: "rest", agentId: "agent_other", payload },
        authorization
      )
    ).toBeUndefined()
    expect(
      projectGuestOutbound(
        {
          transport: "rest",
          agentId: "agent_planner",
          sessionId: "session_other",
          payload,
        },
        authorization
      )
    ).toBeUndefined()
  })

  it("fails closed when an envelope, payload, or safe nested object gains an unknown field", () => {
    const base = {
      transport: "rest",
      agentId: "agent_planner",
      sessionId: "session_launch",
      payload: { type: "message", role: "assistant", text: "Visible" },
    }

    expect(
      projectGuestOutbound(
        { ...base, newlyAddedNativeField: "secret" },
        authorization
      )
    ).toBeUndefined()
    expect(
      projectGuestOutbound(
        { ...base, payload: { ...base.payload, newMessageField: "secret" } },
        authorization
      )
    ).toBeUndefined()
    expect(
      projectGuestOutbound(
        {
          ...base,
          payload: {
            ...base.payload,
            customUi: { type: "card", text: "Visible", action: "admin" },
          },
        },
        authorization
      )
    ).toBeUndefined()
  })

  it("is deterministic regardless of source property order", () => {
    const first = projectGuestOutbound(
      {
        payload: { text: "Hello", role: "assistant", type: "message" },
        sessionId: "session_launch",
        agentId: "agent_planner",
        transport: "turn",
      },
      authorization
    )
    const second = projectGuestOutbound(
      {
        transport: "turn",
        agentId: "agent_planner",
        sessionId: "session_launch",
        payload: { type: "message", role: "assistant", text: "Hello" },
      },
      authorization
    )

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it("bounds UTF-8 bytes, depth, array count, object count, and malformed values before output", () => {
    const base = {
      transport: "turn",
      agentId: "agent_planner",
      sessionId: "session_launch",
    }

    expect(
      projectGuestOutbound(
        {
          ...base,
          payload: {
            type: "message",
            role: "assistant",
            text: "é".repeat(32_769),
          },
        },
        authorization
      )
    ).toBeUndefined()
    expect(
      projectGuestOutbound(
        {
          ...base,
          payload: {
            type: "message",
            role: "assistant",
            text: "Visible",
            reasoning: { a: { b: { c: { d: { e: { f: { g: "deep" } } } } } } },
          },
        },
        authorization
      )
    ).toBeUndefined()
    expect(
      projectGuestOutbound(
        {
          ...base,
          payload: {
            type: "message",
            role: "assistant",
            text: "Visible",
            rawToolResult: Array.from({ length: 65 }, (_, index) => index),
          },
        },
        authorization
      )
    ).toBeUndefined()
    expect(
      projectGuestOutbound(
        {
          ...base,
          payload: { type: "message", role: "assistant", text: Number.NaN },
        },
        authorization
      )
    ).toBeUndefined()
  })

  it("never includes secrets from forbidden inputs in serialized output", () => {
    const projected = projectGuestOutbound(
      {
        transport: "rest",
        agentId: "agent_planner",
        sessionId: "session_launch",
        payload: {
          type: "message",
          role: "assistant",
          text: "Safe",
          reasoning: "HERMES_TOKEN=hms_super_secret",
          rawToolArguments: { authorization: "Bearer hms_super_secret" },
          rawToolResult: { path: "/home/operator/.hermes" },
          approval: { principalId: "operator_root" },
        },
      },
      authorization
    )

    expect(JSON.stringify(projected)).toBe(
      '{"transport":"rest","agentId":"agent_planner","sessionId":"session_launch","payload":{"type":"message","role":"assistant","text":"Safe"}}'
    )
  })
})
