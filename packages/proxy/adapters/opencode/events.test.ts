import { RunEventKind, RunEventSchema } from "../../core/events"
import { describe, expect, it } from "vitest"

import { OpenCodeEventProjector, OpenCodeEventValidationError } from "./events"

const scope = {
  sessionId: "session-1",
  threadId: "thread-1",
  runId: "run-1",
}

function durable(
  seq: number,
  type: string,
  data: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {}
) {
  return {
    id: `native-${seq}`,
    type,
    durable: {
      aggregateID: scope.sessionId,
      seq,
      version:
        type === "session.next.step.ended" ||
        type === "session.next.step.failed"
          ? 2
          : 1,
    },
    data: { sessionID: scope.sessionId, ...data },
    ...overrides,
  }
}

function live(
  seq: number,
  type: string,
  data: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {}
) {
  return {
    id: String(seq),
    event: "session",
    data: durable(seq, type, data, overrides),
  }
}

describe("OpenCodeEventProjector", () => {
  it("orders real durable reasoning, text, tools, progress, usage, and authoritative finish as AG-UI", () => {
    const projector = new OpenCodeEventProjector(scope, 0)
    const events = [
      live(1, "session.next.reasoning.started", {
        assistantMessageID: "assistant-1",
        reasoningID: "reasoning-1",
        timestamp: 1,
      }),
      live(2, "session.next.reasoning.ended", {
        assistantMessageID: "assistant-1",
        reasoningID: "reasoning-1",
        text: "think",
        timestamp: 2,
      }),
      live(3, "session.next.text.started", {
        assistantMessageID: "assistant-1",
        textID: "text-1",
        timestamp: 3,
      }),
      live(4, "session.next.text.ended", {
        assistantMessageID: "assistant-1",
        textID: "text-1",
        text: "Hi there",
        timestamp: 4,
      }),
      live(5, "session.next.tool.input.started", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        name: "read",
        timestamp: 5,
      }),
      live(6, "session.next.tool.input.ended", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        text: '{"path":"README.md"}',
        timestamp: 6,
      }),
      live(7, "session.next.tool.progress", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        structured: { ignoredNativePath: "/private/worktree" },
        content: [{ type: "text", text: "Reading" }],
        timestamp: 7,
      }),
      live(8, "session.next.tool.success", {
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
        timestamp: 8,
      }),
      live(9, "session.next.step.ended", {
        assistantMessageID: "assistant-1",
        finish: "stop",
        cost: 0.01,
        tokens: {
          input: 11,
          output: 7,
          reasoning: 5,
          cache: { read: 3, write: 2 },
        },
        timestamp: 9,
      }),
    ].flatMap((event) => projector.accept(event).events)
    events.push(...projector.finish().events)

    expect(events.map((event) => event.type)).toEqual([
      RunEventKind.REASONING_MESSAGE_START,
      RunEventKind.REASONING_MESSAGE_CONTENT,
      RunEventKind.REASONING_MESSAGE_END,
      RunEventKind.TEXT_MESSAGE_START,
      RunEventKind.TEXT_MESSAGE_CONTENT,
      RunEventKind.TEXT_MESSAGE_END,
      RunEventKind.TOOL_CALL_START,
      RunEventKind.TOOL_CALL_ARGS,
      RunEventKind.ACTIVITY_SNAPSHOT,
      RunEventKind.TOOL_CALL_END,
      RunEventKind.TOOL_CALL_RESULT,
      RunEventKind.RUN_FINISHED,
    ])
    expect(events[8]).toMatchObject({
      activityType: "PROGRESS",
      content: { callId: "call-1", status: "running", text: "Reading" },
    })
    expect(events[10]).toMatchObject({ content: "contents" })
    expect(JSON.stringify(events)).not.toContain("/private/worktree")
    expect(events.at(-1)).toMatchObject({
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
      expect(RunEventSchema.safeParse(event).success).toBe(true)
  })

  it("accepts the real durable tool failure shape and emits a safe terminal tool result", () => {
    const projector = new OpenCodeEventProjector(scope, 0)
    projector.accept(
      live(1, "session.next.tool.input.started", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        name: "read",
        timestamp: 1,
      })
    )

    expect(
      projector.accept(
        live(2, "session.next.tool.failed", {
          assistantMessageID: "assistant-1",
          callID: "call-1",
          error: { type: "unknown", message: "secret native failure" },
          provider: { executed: true },
          timestamp: 2,
        })
      )
    ).toEqual({
      events: [
        { type: RunEventKind.TOOL_CALL_END, toolCallId: "call-1" },
        {
          type: RunEventKind.TOOL_CALL_RESULT,
          messageId: "assistant-1:tool:call-1",
          toolCallId: "call-1",
          content: '{"status":"error"}',
          role: "tool",
        },
      ],
    })
  })

  it("validates the complete native durable envelope and rejects foreign aggregate correlation", () => {
    const projector = new OpenCodeEventProjector(scope, 0)
    const malformed = live(
      1,
      "session.next.text.started",
      {
        assistantMessageID: "assistant-1",
        textID: "text-1",
        timestamp: 1,
      },
      { durable: { aggregateID: "foreign", seq: 1, version: 1 } }
    )

    expect(() => projector.accept(malformed)).toThrow(
      OpenCodeEventValidationError
    )
    expect(projector.recoveryPosition().lastSeen).toBe(0)

    expect(() =>
      projector.accept(
        live(
          1,
          "session.next.step.ended",
          {
            assistantMessageID: "assistant-1",
            finish: "stop",
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            timestamp: 1,
          },
          { durable: { aggregateID: scope.sessionId, seq: 1, version: 1 } }
        )
      )
    ).toThrow(OpenCodeEventValidationError)
    expect(projector.recoveryPosition().lastSeen).toBe(0)
  })

  it("rejects forward gaps and unknown durable event types without advancing", () => {
    const projector = new OpenCodeEventProjector(scope, 3)

    expect(() =>
      projector.accept(
        live(5, "session.next.text.started", {
          assistantMessageID: "assistant-1",
          textID: "text-1",
          timestamp: 5,
        })
      )
    ).toThrow(OpenCodeEventValidationError)
    expect(() =>
      projector.accept(live(4, "session.next.future.unknown", { timestamp: 4 }))
    ).toThrow(OpenCodeEventValidationError)
    expect(projector.recoveryPosition().lastSeen).toBe(3)
  })

  it("allowlists and validates intentionally ignored prompt admission events", () => {
    const projector = new OpenCodeEventProjector(scope, 0, {
      admissionId: "aos-admission",
    })

    expect(
      projector.accept(
        live(1, "session.next.prompt.admitted", {
          timestamp: 1,
          messageID: "aos-admission",
          prompt: { text: "Hello" },
          delivery: "queue",
        })
      )
    ).toEqual({ events: [], admissionId: "aos-admission" })
    expect(projector.recoveryPosition().lastSeen).toBe(1)
    expect(
      projector.accept(
        live(2, "session.next.prompt.admitted", {
          timestamp: 2,
          messageID: "next-admission",
          prompt: { text: "Next" },
          delivery: "queue",
        })
      )
    ).toEqual({
      events: [],
      admissionId: "next-admission",
      admissionBoundary: true,
    })
  })

  it("repairs missed non-durable text deltas from a real durable ended event", () => {
    const projector = new OpenCodeEventProjector(scope, 8)

    expect(
      projector.acceptHistory(
        durable(9, "session.next.text.ended", {
          assistantMessageID: "assistant-1",
          textID: "text-1",
          text: "Recovered text",
          timestamp: 9,
        })
      ).events
    ).toMatchObject([
      { type: RunEventKind.TEXT_MESSAGE_START, messageId: "assistant-1" },
      { type: RunEventKind.TEXT_MESSAGE_CONTENT, delta: "Recovered text" },
      { type: RunEventKind.TEXT_MESSAGE_END, messageId: "assistant-1" },
    ])
  })

  it("aggregates usage across every durable provider step in a tool-continuation run", () => {
    const projector = new OpenCodeEventProjector(scope, 0)
    for (const [seq, input, output] of [
      [1, 10, 4],
      [2, 20, 6],
    ] as const)
      projector.accept(
        live(seq, "session.next.step.ended", {
          assistantMessageID: `assistant-${seq}`,
          finish: seq === 1 ? "tool-calls" : "stop",
          cost: 0,
          tokens: {
            input,
            output,
            reasoning: 2,
            cache: { read: 3, write: 1 },
          },
          timestamp: seq,
        })
      )

    expect(projector.finish().events.at(-1)).toMatchObject({
      type: RunEventKind.RUN_FINISHED,
      usage: [
        {
          inputTokens: 30,
          outputTokens: 10,
          reasoningTokens: 4,
          cachedInputTokens: 6,
          totalTokens: 44,
        },
      ],
    })
  })
})
