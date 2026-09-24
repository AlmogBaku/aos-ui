import { describe, expect, it, vi } from "vitest"

import type { SessionHistoryResponse } from "../../../protocol"
import { guestErrorDescription } from "../../auth/guest-projection"
import { TurnEventKind } from "../../core/events"
import {
  CommandRefusedError,
  type MemberAct,
  type MemberCommands,
  type MemberEvent,
} from "../../core/member"
import { createHistoryMiddleware, projectGuestHistory } from "./history"

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

  it("drops a system notice", () => {
    const projected = projectGuestHistory(
      {
        ...page([{ id: "ask", role: "user", text: "Hello" }]),
        messages: [
          {
            id: "notice",
            role: "system",
            content: [{ type: "text", text: "Private notice" }],
            createdAt: "2026-09-15T00:00:00.000Z",
          },
          ...page([{ id: "ask", role: "user", text: "Hello" }]).messages,
        ],
      },
      "ref"
    )

    expect(projected.messages.map((message) => message.id)).toEqual(["ask"])
  })

  it("keeps a long message whole", () => {
    const text = "x".repeat(20_000)
    const projected = projectGuestHistory(
      page([
        { id: "ask", role: "user", text },
        { id: "reply", role: "assistant", text },
      ]),
      "ref"
    )

    expect(projected.messages.map((message) => message.content)).toEqual([
      [{ type: "text", text }],
      [{ type: "text", text }],
    ])
  })
})

const SETUP = JSON.stringify({
  v: 1,
  type: "aos.guest.first-turn",
  instruction: "Private setup",
})

/** One history page of text messages. */
function page(
  messages: Array<{ id: string; role: "user" | "assistant"; text: string }>
): SessionHistoryResponse {
  return {
    sessionId: "stored",
    messages: messages.map(({ id, role, text }) => ({
      id,
      role,
      content: [{ type: "text", text }],
      createdAt: "2026-09-15T00:00:00.000Z",
    })),
    total: messages.length,
    limit: 200,
    offset: 0,
    nextOffset: messages.length,
  }
}

const act: MemberAct = { decline: () => undefined }

/** A guest's history layer, and what an Edit or Retry of `sourceId` does. */
function guarded() {
  const middleware = createHistoryMiddleware({
    grant: {
      agentId: "agent",
      ref: "ref",
      principalId: "guest_ref",
      expiresAt: 100,
    },
  })
  const next = vi.fn(async () => ({ messageId: "sent" }))
  return {
    show: (event: MemberEvent) => middleware.event?.(event, act),
    rewind: (rewindSourceId: string) => {
      const command: MemberCommands["send"] = {
        sessionId: "ref",
        content: [{ kind: "text", text: "Again" }],
        text: "Again",
        rewindSourceId,
      }
      return middleware.commands?.send?.(command, next)
    },
    next,
  }
}

const STREAM = { turnId: "run-1", replayedCorrections: 0, dropped: false }

describe("guest Edit and Retry", () => {
  it("refuses a message the guest was never shown, the setup turn among them", async () => {
    const test = guarded()
    test.show({
      sessionId: "ref",
      kind: "history",
      sequence: 0,
      page: page([
        { id: "seed", role: "user", text: SETUP },
        { id: "reply", role: "assistant", text: "Welcome" },
      ]),
    })

    for (const id of ["seed", "reply", "never-shown"])
      await expect(test.rewind(id), id).rejects.toBeInstanceOf(
        CommandRefusedError
      )
    expect(test.next).not.toHaveBeenCalled()
  })

  it("runs on a message the guest was shown, by any id it knows it by", async () => {
    const test = guarded()
    test.show({
      sessionId: "ref",
      kind: "history",
      sequence: 0,
      page: page([{ id: "stored-ask", role: "user", text: "Hello" }]),
    })
    test.show({
      sessionId: "ref",
      kind: "prompt",
      messageId: "live-ask",
      content: [{ kind: "text", text: "Next" }],
      own: true,
    })
    const ended = (messageId: string, savedId: string): MemberEvent => ({
      sessionId: "ref",
      kind: "turn",
      stream: STREAM,
      sequence: 1,
      stopping: false,
      event: {
        kind: TurnEventKind.TurnEnded,
        saved: { user: { messageId, savedId } },
      },
    })
    test.show(ended("live-ask", "row-7"))
    test.show(ended("unseen-ask", "row-9"))

    for (const id of ["stored-ask", "live-ask", "row-7"])
      await expect(test.rewind(id), id).resolves.toEqual({
        messageId: "sent",
      })
    await expect(test.rewind("row-9")).rejects.toBeInstanceOf(
      CommandRefusedError
    )
    expect(test.next).toHaveBeenCalledTimes(3)
  })
})
