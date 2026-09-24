import { describe, expect, it } from "vitest"

import type { VerifiedGuestAuthorization } from "../../auth/guest-invitation"
import { guestErrorDescription } from "../../auth/guest-projection"
import { projectGuestHistory } from "./history"

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

describe("guest history projection", () => {
  it("keeps normalized recovery state and hides any first-turn envelope, whatever it asks", () => {
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
        execution: { status: "running", turnId: "run-1" },
      },
      // An invitation without setup text still hides another one's envelope.
      authorization,
      "ref"
    )

    expect(projected.messages).toEqual([])
    expect(projected.execution).toEqual({ status: "running", turnId: "run-1" })
  })

  it("hides the first-turn envelope on whichever page holds it, and nothing else", () => {
    const envelope = JSON.stringify({
      v: 1,
      type: "aos.guest.first-turn",
      instruction: "Private setup",
    })
    const text = (id: string, role: "user" | "assistant", body: string) => ({
      id,
      role,
      content: [{ type: "text" as const, text: body }],
      createdAt: "2026-09-15T00:00:00.000Z",
    })
    // Three pages of one Session, newest first, as a guest scrolls back.
    const pages = [
      [text("next", "user", "Next"), text("answer-3", "assistant", "Three")],
      [text("hello", "user", "Hello"), text("answer-2", "assistant", "Two")],
      [text("seed", "user", envelope), text("answer-1", "assistant", "One")],
    ].map((messages, index) =>
      projectGuestHistory(
        {
          sessionId: "stored",
          messages,
          total: 6,
          limit: 2,
          offset: index * 2,
          nextOffset: index * 2 + 2,
        },
        { ...authorization, firstTurn: { instruction: "Private setup" } },
        "ref"
      )
    )

    expect(
      pages.map((page) => page.messages.map((message) => message.id))
    ).toEqual([["next", "answer-3"], ["hello", "answer-2"], ["answer-1"]])
  })

  it("keeps no correction flag on a projected user turn", () => {
    const projected = projectGuestHistory(
      {
        sessionId: "stored",
        messages: [
          {
            id: "prompt",
            role: "user",
            content: [{ type: "text", text: "Summarize the notes" }],
            createdAt: "2026-09-15T00:00:00.000Z",
          },
          {
            id: "correction",
            role: "user",
            content: [{ type: "text", text: "Use the tables" }],
            createdAt: "2026-09-15T00:00:01.000Z",
            metadata: { custom: { correction: true } },
          },
        ],
        total: 2,
        limit: 200,
        offset: 0,
        nextOffset: 2,
      },
      authorization,
      "ref"
    )

    // The projection rebuilds every message, so a resume must count the
    // corrections it owes the journal on the authoritative page instead.
    expect(projected.messages).toHaveLength(2)
    for (const message of projected.messages)
      expect(message).not.toHaveProperty("metadata")
  })

  it("keeps a restored failed turn failed for a guest", () => {
    const projected = projectGuestHistory(
      {
        sessionId: "stored",
        messages: [
          {
            id: "ask",
            role: "user",
            content: [{ type: "text", text: "Summarize the filing" }],
            createdAt: "2026-09-15T00:00:00.000Z",
          },
          {
            id: "failed",
            role: "assistant",
            content: [{ type: "text", text: "I could not reach the model." }],
            createdAt: "2026-09-15T00:00:01.000Z",
            status: {
              type: "incomplete",
              reason: "error",
              error:
                "Hermes' model provider returned an error for this turn. Retry, switch models with /model, or continue in a new Session.",
            },
            metadata: {
              custom: {
                aos: { turnErrorCode: "AOS_PROVIDER_RETRYABLE_FAILURE" },
              },
            },
          },
        ],
        total: 2,
        limit: 200,
        offset: 0,
        nextOffset: 2,
      },
      authorization,
      "ref"
    )

    expect(projected.messages[1]).toMatchObject({
      id: "failed",
      role: "assistant",
      content: [{ type: "text", text: "I could not reach the model." }],
      status: {
        type: "incomplete",
        reason: "error",
        error: guestErrorDescription("temporarily_unavailable"),
      },
    })
    expect(projected.messages[1]).not.toHaveProperty("metadata")
    expect(JSON.stringify(projected)).not.toContain("Hermes")
  })

  it("keeps a restored failed turn that streamed no text", () => {
    const projected = projectGuestHistory(
      {
        sessionId: "stored",
        messages: [
          {
            id: "silent",
            role: "assistant",
            content: [],
            createdAt: "2026-09-15T00:00:01.000Z",
            status: {
              type: "incomplete",
              reason: "error",
              error: "Hermes could not complete this turn.",
            },
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
      id: "silent",
      content: [],
      status: {
        type: "incomplete",
        reason: "error",
        error: guestErrorDescription("request_failed"),
      },
    })
  })

  it("never projects the provider detail of a restored failure to a guest", () => {
    const projected = projectGuestHistory(
      {
        sessionId: "stored",
        messages: [
          {
            id: "failed",
            role: "assistant",
            content: [],
            createdAt: "2026-09-15T00:00:01.000Z",
            status: {
              type: "incomplete",
              reason: "error",
              error:
                "Hermes' model provider returned an error for this turn. Retry, switch models with /model, or continue in a new Session.\nAn error occurred (ValidationException) when calling the InvokeModel operation",
            },
            metadata: {
              custom: {
                aos: { turnErrorCode: "AOS_PROVIDER_RETRYABLE_FAILURE" },
              },
            },
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
      status: {
        type: "incomplete",
        reason: "error",
        error: guestErrorDescription("temporarily_unavailable"),
      },
    })
    expect(JSON.stringify(projected)).not.toContain("ValidationException")
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
})
