import { EventSchemas, EventType } from "@ag-ui/core"
import { describe, expect, it } from "vitest"

import { OpenCodeEventProjector, OpenCodeEventValidationError } from "./events"

const scope = {
  sessionId: "session-1",
  threadId: "thread-1",
  runId: "run-1",
}

function native(
  id: number,
  type: string,
  properties: Record<string, unknown> = {}
) {
  return {
    id: String(id),
    event: "session",
    data: {
      type,
      properties: { sessionID: scope.sessionId, ...properties },
    },
  }
}

describe("OpenCodeEventProjector", () => {
  it("orders validated reasoning, text, tools, progress, usage, and terminal lifecycle as AG-UI", () => {
    const projector = new OpenCodeEventProjector(scope, 0)
    const events = [
      native(1, "session.next.reasoning.started", {
        assistantMessageID: "assistant-1",
        reasoningID: "reasoning-1",
        timestamp: 1,
      }),
      native(2, "session.next.reasoning.delta", {
        assistantMessageID: "assistant-1",
        reasoningID: "reasoning-1",
        delta: "th",
        timestamp: 2,
      }),
      native(3, "session.next.reasoning.ended", {
        assistantMessageID: "assistant-1",
        reasoningID: "reasoning-1",
        text: "think",
        timestamp: 3,
      }),
      native(4, "session.next.text.started", {
        assistantMessageID: "assistant-1",
        textID: "text-1",
        timestamp: 4,
      }),
      native(5, "session.next.text.delta", {
        assistantMessageID: "assistant-1",
        textID: "text-1",
        delta: "Hi",
        timestamp: 5,
      }),
      native(6, "session.next.text.ended", {
        assistantMessageID: "assistant-1",
        textID: "text-1",
        text: "Hi there",
        timestamp: 6,
      }),
      native(7, "session.next.tool.input.started", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        name: "read",
        timestamp: 7,
      }),
      native(8, "session.next.tool.input.delta", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        delta: '{"path":',
        timestamp: 8,
      }),
      native(9, "session.next.tool.input.ended", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        text: '{"path":"README.md"}',
        timestamp: 9,
      }),
      native(10, "session.next.tool.progress", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        structured: { ignoredNativePath: "/private/worktree" },
        content: [{ type: "text", text: "Reading" }],
        timestamp: 10,
      }),
      native(11, "session.next.tool.success", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        structured: {},
        content: [
          { type: "text", text: "contents" },
          {
            type: "file",
            uri: "file:///private/worktree/README.md",
            mime: "text/plain",
          },
        ],
        provider: { executed: true },
        outputPaths: ["/private/worktree/README.md"],
        timestamp: 11,
      }),
      native(12, "session.next.step.ended", {
        assistantMessageID: "assistant-1",
        finish: "stop",
        cost: 0.01,
        tokens: {
          input: 11,
          output: 7,
          reasoning: 5,
          cache: { read: 3, write: 2 },
        },
        timestamp: 12,
      }),
      native(13, "session.idle"),
    ].flatMap((event) => projector.accept(event).events)

    expect(events.map((event) => event.type)).toEqual([
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_ARGS,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ])
    expect(events[2]).toMatchObject({ delta: "ink" })
    expect(events[6]).toMatchObject({ delta: " there" })
    expect(events[11]).toMatchObject({
      activityType: "PROGRESS",
      content: { callId: "call-1", status: "running", text: "Reading" },
    })
    expect(events[13]).toMatchObject({ content: "contents" })
    expect(JSON.stringify(events)).not.toContain("/private/worktree")
    expect(events.at(-1)).toMatchObject({
      threadId: scope.threadId,
      runId: scope.runId,
      usage: [
        {
          inputTokens: 11,
          outputTokens: 7,
          reasoningTokens: 5,
          cachedInputTokens: 3,
          totalTokens: 23,
        },
      ],
      outcome: { type: "success" },
    })
    for (const event of events)
      expect(EventSchemas.safeParse(event).success).toBe(true)
  })

  it("ignores foreign and duplicate Session events without advancing its durable position", () => {
    const projector = new OpenCodeEventProjector(scope, 4)

    expect(
      projector.accept({
        ...native(5, "session.next.text.ended", {
          assistantMessageID: "assistant-foreign",
          textID: "text-foreign",
          text: 42,
          timestamp: 5,
        }),
        data: {
          type: "session.next.text.ended",
          properties: { sessionID: "session-foreign", text: 42 },
        },
      })
    ).toEqual({ events: [] })
    expect(projector.accept(native(4, "session.idle"))).toEqual({ events: [] })
    expect(projector.recoveryPosition()).toEqual({
      epoch: "opencode:session-1",
      lastSeen: 4,
    })
  })

  it("rejects a malformed known native event before conversion", () => {
    const projector = new OpenCodeEventProjector(scope, 0)

    expect(() =>
      projector.accept(
        native(1, "session.next.text.delta", {
          assistantMessageID: "assistant-1",
          textID: "text-1",
          delta: 42,
          timestamp: 1,
        })
      )
    ).toThrow(OpenCodeEventValidationError)
    expect(projector.recoveryPosition().lastSeen).toBe(0)
  })

  it("repairs missed live deltas from a validated durable history event and deduplicates overlap", () => {
    const projector = new OpenCodeEventProjector(scope, 8)
    const history = {
      id: "native-event-id",
      type: "session.next.text.ended",
      durable: { aggregateID: scope.sessionId, seq: 9, version: 1 },
      data: {
        sessionID: scope.sessionId,
        assistantMessageID: "assistant-1",
        textID: "text-1",
        text: "Recovered text",
        timestamp: 9,
      },
    }

    expect(projector.acceptHistory(history).events).toMatchObject([
      { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-1" },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "Recovered text",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-1" },
    ])
    expect(projector.acceptHistory(history)).toEqual({ events: [] })
    expect(projector.recoveryPosition().lastSeen).toBe(9)
  })

  it("maps the exact native Session error shape without exposing its provider message", () => {
    const projector = new OpenCodeEventProjector(scope, 0)

    expect(
      projector.accept(
        native(1, "session.error", {
          error: {
            name: "APIError",
            data: { message: "Authorization=secret /private/worktree" },
          },
        })
      )
    ).toEqual({
      events: [
        {
          type: EventType.RUN_ERROR,
          code: "AOS_PROVIDER_RUN_FAILED",
          message: "OpenCode could not complete this run.",
        },
      ],
      terminal: "error",
    })
  })
})
