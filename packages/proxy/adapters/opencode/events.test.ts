import { RunEventKind, RunEventSchema } from "../../core/events"
import { describe, expect, it } from "vitest"

import {
  OpenCodeEventProjector,
  OpenCodeEventValidationError,
  validateOpenCodeLiveEvent,
} from "./events"

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

function planEvents(event: { type: RunEventKind }) {
  return (
    event.type === RunEventKind.ACTIVITY_SNAPSHOT ||
    event.type === RunEventKind.ACTIVITY_DELTA
  )
}

describe("OpenCodeEventProjector", () => {
  it("publishes an aos-ui MCP call under its bare name and its receipt as an opaque artifact", () => {
    const projector = new OpenCodeEventProjector(scope, 0)
    const receipt = JSON.stringify({
      ok: true,
      type: "aos.artifact",
      artifact: {
        path: "/workspaces/aos/out/report.pdf",
        filename: "report.pdf",
        mimeType: "application/pdf",
      },
    })
    const called = projector.accept(
      live(1, "session.next.tool.called", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        tool: "aos-ui_present_artifact",
        input: { path: "out/report.pdf" },
        provider: { executed: true },
        timestamp: 1,
      })
    ).events
    const settled = projector.accept(
      live(2, "session.next.tool.success", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        structured: {},
        content: [{ type: "text", text: receipt }],
        provider: { executed: true },
        timestamp: 2,
      })
    ).events

    expect(called).toContainEqual(
      expect.objectContaining({
        type: RunEventKind.TOOL_CALL_START,
        toolCallName: "present_artifact",
      })
    )
    const artifact = settled.find((event) => event.type === RunEventKind.CUSTOM)
    expect(artifact).toEqual({
      type: RunEventKind.CUSTOM,
      name: "aos.artifact",
      value: {
        id: expect.stringMatching(/^opencode-artifact-[0-9a-f]{32}$/u),
        filename: "report.pdf",
        mimeType: "application/pdf",
        source: { type: "provider", reference: expect.any(String) },
      },
    })
    const result = settled.find(
      (event) => event.type === RunEventKind.TOOL_CALL_RESULT
    )
    expect(result && "content" in result && JSON.parse(result.content)).toEqual(
      {
        ok: true,
        type: "aos.artifact",
        artifact: {
          id: (artifact as { value: { id: string } }).value.id,
          filename: "report.pdf",
          mimeType: "application/pdf",
        },
      }
    )
    expect(JSON.stringify(settled)).not.toContain("/workspaces")
    for (const event of [...called, ...settled])
      expect(RunEventSchema.safeParse(event).success).toBe(true)
  })

  it("publishes no artifact for a receipt naming a relative path", () => {
    const projector = new OpenCodeEventProjector(scope, 0)
    projector.accept(
      live(1, "session.next.tool.called", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        tool: "aos-ui_present_artifact",
        input: {},
        provider: { executed: true },
        timestamp: 1,
      })
    )
    const settled = projector.accept(
      live(2, "session.next.tool.success", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        structured: {},
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              type: "aos.artifact",
              artifact: { path: "out/report.pdf", filename: "report.pdf" },
            }),
          },
        ],
        provider: { executed: true },
        timestamp: 2,
      })
    ).events

    expect(settled.some((event) => event.type === RunEventKind.CUSTOM)).toBe(
      false
    )
  })

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

  it("emits the native subagent tool under its canonical name with a summary result", () => {
    const projector = new OpenCodeEventProjector(scope, 0)

    expect(
      projector.accept(
        live(1, "session.next.tool.input.started", {
          assistantMessageID: "assistant-1",
          callID: "call-1",
          name: "task",
          timestamp: 1,
        })
      ).events
    ).toEqual([
      {
        type: RunEventKind.TOOL_CALL_START,
        toolCallId: "call-1",
        toolCallName: "delegate_subagent",
        parentMessageId: "assistant-1",
      },
    ])

    expect(
      projector.accept(
        live(2, "session.next.tool.called", {
          assistantMessageID: "assistant-1",
          callID: "call-1",
          tool: "task",
          input: { description: "Review the launch plan" },
          provider: { executed: true },
          timestamp: 2,
        })
      ).events
    ).toEqual([
      {
        type: RunEventKind.TOOL_CALL_ARGS,
        toolCallId: "call-1",
        delta: '{"description":"Review the launch plan"}',
      },
    ])

    expect(
      projector.accept(
        live(3, "session.next.tool.success", {
          assistantMessageID: "assistant-1",
          callID: "call-1",
          structured: {},
          content: [{ type: "text", text: "The review is complete." }],
          provider: { executed: true },
          timestamp: 3,
        })
      ).events
    ).toEqual([
      { type: RunEventKind.TOOL_CALL_END, toolCallId: "call-1" },
      {
        type: RunEventKind.TOOL_CALL_RESULT,
        messageId: "assistant-1:tool:call-1",
        toolCallId: "call-1",
        content: '{"summary":"The review is complete."}',
        role: "tool",
      },
    ])
  })

  it("publishes the native Todo tool's own input as this Session's plan", () => {
    const projector = new OpenCodeEventProjector(scope, 0)
    const called = (
      seq: number,
      callId: string,
      input: Record<string, unknown>
    ) =>
      projector.accept(
        live(seq, "session.next.tool.called", {
          assistantMessageID: "assistant-1",
          callID: callId,
          tool: "todowrite",
          input,
          provider: { executed: true },
          timestamp: seq,
        })
      ).events
    const succeeded = (seq: number, callId: string) =>
      projector.accept(
        live(seq, "session.next.tool.success", {
          assistantMessageID: "assistant-1",
          callID: callId,
          structured: {},
          content: [{ type: "text", text: "Todos updated." }],
          provider: { executed: true },
          timestamp: seq,
        })
      ).events
    const running = {
      todos: [
        {
          content: "Read the adapter",
          status: "in_progress",
          priority: "high",
        },
        { content: "Write the test", status: "pending", priority: "medium" },
      ],
    }

    called(1, "call-1", running)

    expect(succeeded(2, "call-1").at(-1)).toEqual({
      type: RunEventKind.ACTIVITY_SNAPSHOT,
      messageId: `aos-plan:${scope.threadId}`,
      activityType: "PLAN",
      content: {
        todos: [
          { id: "0", label: "Read the adapter", status: "active" },
          { id: "1", label: "Write the test", status: "pending" },
        ],
      },
      replace: true,
    })

    // An unchanged list is the plan the browser already holds.
    called(3, "call-2", running)
    expect(succeeded(4, "call-2").filter(planEvents)).toEqual([])

    called(5, "call-3", {
      todos: [
        { content: "Read the adapter", status: "completed", priority: "high" },
        { content: "Write the test", status: "cancelled", priority: "medium" },
      ],
    })

    expect(succeeded(6, "call-3").at(-1)).toEqual({
      type: RunEventKind.ACTIVITY_DELTA,
      messageId: `aos-plan:${scope.threadId}`,
      activityType: "PLAN",
      patch: [
        {
          op: "replace",
          path: "/todos",
          value: [
            { id: "0", label: "Read the adapter", status: "completed" },
            { id: "1", label: "Write the test", status: "failed" },
          ],
        },
      ],
    })
  })

  it("publishes no plan at all for a native Todo tool input it cannot read", () => {
    const projector = new OpenCodeEventProjector(scope, 0)
    projector.accept(
      live(1, "session.next.tool.called", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        tool: "todowrite",
        input: { items: "everything" },
        provider: { executed: true },
        timestamp: 1,
      })
    )

    expect(
      projector.accept(
        live(2, "session.next.tool.success", {
          assistantMessageID: "assistant-1",
          callID: "call-1",
          structured: {},
          content: [{ type: "text", text: "Todos updated." }],
          provider: { executed: true },
          timestamp: 2,
        })
      ).events
    ).toEqual([
      { type: RunEventKind.TOOL_CALL_END, toolCallId: "call-1" },
      {
        type: RunEventKind.TOOL_CALL_RESULT,
        messageId: "assistant-1:tool:call-1",
        toolCallId: "call-1",
        content: "Todos updated.",
        role: "tool",
      },
    ])
  })

  it("publishes no plan for a native Todo tool call that failed", () => {
    const projector = new OpenCodeEventProjector(scope, 0)
    projector.accept(
      live(1, "session.next.tool.called", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        tool: "todowrite",
        input: { todos: [{ content: "Never shown", status: "pending" }] },
        provider: { executed: true },
        timestamp: 1,
      })
    )

    expect(
      projector
        .accept(
          live(2, "session.next.tool.failed", {
            assistantMessageID: "assistant-1",
            callID: "call-1",
            error: { type: "unknown", message: "The tool failed." },
            provider: { executed: true },
            timestamp: 2,
          })
        )
        .events.filter(planEvents)
    ).toEqual([])
  })

  it("rebuilds the plan from a suppressed replay without publishing it again", () => {
    const projector = new OpenCodeEventProjector(scope, 0)
    const input = {
      todos: [{ content: "Read the adapter", status: "in_progress" }],
    }
    for (const event of [
      live(1, "session.next.tool.called", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        tool: "todowrite",
        input,
        provider: { executed: true },
        timestamp: 1,
      }),
      live(2, "session.next.tool.success", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        structured: {},
        content: [{ type: "text", text: "Todos updated." }],
        provider: { executed: true },
        timestamp: 2,
      }),
    ])
      expect(
        projector.reconstructValidated(
          validateOpenCodeLiveEvent(event, scope.sessionId)
        ).events
      ).toEqual([])

    projector.accept(
      live(3, "session.next.tool.called", {
        assistantMessageID: "assistant-1",
        callID: "call-2",
        tool: "todowrite",
        input,
        provider: { executed: true },
        timestamp: 3,
      })
    )

    expect(
      projector
        .accept(
          live(4, "session.next.tool.success", {
            assistantMessageID: "assistant-1",
            callID: "call-2",
            structured: {},
            content: [{ type: "text", text: "Todos updated." }],
            provider: { executed: true },
            timestamp: 4,
          })
        )
        .events.filter(planEvents)
    ).toEqual([])
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
