import {
  CompactionStatus,
  StopReason,
  ToolKind,
  TurnEventKind,
  TurnEventSchema,
  type TurnEvent,
} from "../../core/events"
import { describe, expect, it } from "vitest"

import {
  OpenCodeEventProjector,
  OpenCodeEventValidationError,
  validateOpenCodeLiveEvent,
} from "./events"

const sessionId = "session-1"

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
      aggregateID: sessionId,
      seq,
      version:
        type === "session.next.step.ended" ||
        type === "session.next.step.failed"
          ? 2
          : 1,
    },
    data: { sessionID: sessionId, ...data },
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

function planEvents(event: { kind: TurnEventKind }) {
  return event.kind === TurnEventKind.PlanUpdated
}

describe("OpenCodeEventProjector", () => {
  it("orders real durable reasoning, text, tools, progress, usage, and authoritative finish as turn events", () => {
    const projector = new OpenCodeEventProjector(sessionId, 0)
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

    expect(events.slice(0, -1)).toEqual([
      {
        kind: TurnEventKind.ThoughtChunk,
        messageId: "assistant-1",
        text: "think",
      },
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "Hi there",
      },
      {
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "call-1",
        title: "read",
        name: "read",
        toolKind: ToolKind.Read,
        startedAt: "1970-01-01T00:00:05.000Z",
        parentMessageId: "assistant-1",
      },
      {
        kind: TurnEventKind.ToolCallInputChunk,
        toolCallId: "call-1",
        delta: '{"path":"README.md"}',
      },
      {
        kind: TurnEventKind.ToolCallOutputChunk,
        toolCallId: "call-1",
        text: "Reading",
      },
      { kind: TurnEventKind.ToolCallInputEnded, toolCallId: "call-1" },
      {
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "call-1",
        output: "contents",
        failed: false,
        completedAt: "1970-01-01T00:00:08.000Z",
      },
    ])
    expect(JSON.stringify(events)).not.toContain("/private/worktree")
    expect(events.at(-1)).toEqual({
      kind: TurnEventKind.TurnEnded,
      stopReason: StopReason.EndTurn,
      usage: [
        {
          inputTokens: 11,
          outputTokens: 7,
          reasoningTokens: 5,
          cachedInputTokens: 3,
          cachedWriteTokens: 2,
          totalTokens: 23,
        },
      ],
      cost: { amount: 0.01, currency: "USD" },
    })
    for (const event of events)
      expect(TurnEventSchema.safeParse(event).success).toBe(true)
  })

  it("accepts the real durable tool failure shape and emits a safe terminal tool result", () => {
    const projector = new OpenCodeEventProjector(sessionId, 0)
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
        { kind: TurnEventKind.ToolCallInputEnded, toolCallId: "call-1" },
        {
          kind: TurnEventKind.ToolCallFinished,
          toolCallId: "call-1",
          output: '{"status":"error"}',
          failed: true,
          completedAt: "1970-01-01T00:00:02.000Z",
        },
      ],
    })
  })

  it("emits the native subagent tool under its canonical name with a summary result", () => {
    const projector = new OpenCodeEventProjector(sessionId, 0)

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
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "call-1",
        title: "delegate_subagent",
        name: "delegate_subagent",
        startedAt: "1970-01-01T00:00:01.000Z",
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
        kind: TurnEventKind.ToolCallInputChunk,
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
      { kind: TurnEventKind.ToolCallInputEnded, toolCallId: "call-1" },
      {
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "call-1",
        output: '{"summary":"The review is complete."}',
        failed: false,
        completedAt: "1970-01-01T00:00:03.000Z",
      },
    ])
  })

  it("publishes the native Todo tool's own input as this Session's plan", () => {
    const projector = new OpenCodeEventProjector(sessionId, 0)
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
      kind: TurnEventKind.PlanUpdated,
      todos: [
        { id: "0", label: "Read the adapter", status: "active" },
        { id: "1", label: "Write the test", status: "pending" },
      ],
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
      kind: TurnEventKind.PlanUpdated,
      todos: [
        { id: "0", label: "Read the adapter", status: "completed" },
        { id: "1", label: "Write the test", status: "failed" },
      ],
    })
  })

  it("publishes no plan at all for a native Todo tool input it cannot read", () => {
    const projector = new OpenCodeEventProjector(sessionId, 0)
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
      { kind: TurnEventKind.ToolCallInputEnded, toolCallId: "call-1" },
      {
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "call-1",
        output: "Todos updated.",
        failed: false,
        completedAt: "1970-01-01T00:00:02.000Z",
      },
    ])
  })

  it("publishes no plan for a native Todo tool call that failed", () => {
    const projector = new OpenCodeEventProjector(sessionId, 0)
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
    const projector = new OpenCodeEventProjector(sessionId, 0)
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
          validateOpenCodeLiveEvent(event, sessionId)
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
    const projector = new OpenCodeEventProjector(sessionId, 0)
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
          { durable: { aggregateID: sessionId, seq: 1, version: 1 } }
        )
      )
    ).toThrow(OpenCodeEventValidationError)
    expect(projector.recoveryPosition().lastSeen).toBe(0)
  })

  it("rejects forward gaps and unknown durable event types without advancing", () => {
    const projector = new OpenCodeEventProjector(sessionId, 3)

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
    const projector = new OpenCodeEventProjector(sessionId, 0, {
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
    const projector = new OpenCodeEventProjector(sessionId, 8)

    expect(
      projector.acceptHistory(
        durable(9, "session.next.text.ended", {
          assistantMessageID: "assistant-1",
          textID: "text-1",
          text: "Recovered text",
          timestamp: 9,
        })
      ).events
    ).toEqual([
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "Recovered text",
      },
    ])
  })

  it("aggregates usage across every durable provider step in a tool-continuation run", () => {
    const projector = new OpenCodeEventProjector(sessionId, 0)
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
      kind: TurnEventKind.TurnEnded,
      usage: [
        {
          inputTokens: 30,
          outputTokens: 10,
          reasoningTokens: 4,
          cachedInputTokens: 6,
          cachedWriteTokens: 2,
          totalTokens: 44,
        },
      ],
      cost: { amount: 0, currency: "USD" },
    })
  })

  function stepEnded(seq: number, finish: string, cost = 0.25) {
    return live(seq, "session.next.step.ended", {
      assistantMessageID: `assistant-${seq}`,
      finish,
      cost,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      timestamp: seq,
    })
  }

  it.each([
    ["length", StopReason.MaxTokens],
    ["content-filter", StopReason.Refusal],
    ["stop", StopReason.EndTurn],
    ["tool-calls", StopReason.EndTurn],
    ["other", StopReason.EndTurn],
  ])(
    "ends the turn with the last step's %s finish and the summed cost",
    (finish, stopReason) => {
      const projector = new OpenCodeEventProjector(sessionId, 0)
      projector.accept(stepEnded(1, "tool-calls"))
      projector.accept(stepEnded(2, finish, 0.5))

      expect(projector.finish().events.at(-1)).toMatchObject({
        kind: TurnEventKind.TurnEnded,
        stopReason,
        cost: { amount: 0.75, currency: "USD" },
      })
    }
  )

  it("leaves a stopped turn's reason to the stop rather than its last step", () => {
    const projector = new OpenCodeEventProjector(sessionId, 0)
    projector.accept(stepEnded(1, "stop"))
    projector.markStopping()

    const ended = projector.finish().events.at(-1)
    expect(ended).toMatchObject({ kind: TurnEventKind.TurnEnded })
    expect(ended).not.toHaveProperty("stopReason")
  })

  it("names the provider and model of the step that failed", () => {
    const projector = new OpenCodeEventProjector(sessionId, 0)
    projector.accept(
      live(1, "session.next.step.started", {
        assistantMessageID: "assistant-1",
        agent: "build",
        model: { id: "gpt-5", providerID: "openai" },
        timestamp: 1,
      })
    )

    expect(
      projector.accept(
        live(2, "session.next.step.failed", {
          assistantMessageID: "assistant-1",
          error: { type: "unknown", message: "secret native failure" },
          timestamp: 2,
        })
      )
    ).toEqual({
      events: [
        {
          kind: TurnEventKind.TurnFailed,
          code: "AOS_PROVIDER_RUN_FAILED",
          message: "OpenCode could not complete this turn.",
          provider: "openai",
          model: "gpt-5",
        },
      ],
      terminal: "error",
    })
  })

  it("streams only the text each progress snapshot adds to a running call", () => {
    const projector = new OpenCodeEventProjector(sessionId, 0)
    projector.accept(
      live(1, "session.next.tool.input.started", {
        assistantMessageID: "assistant-1",
        callID: "call-1",
        name: "bash",
        timestamp: 1,
      })
    )
    const progress = (seq: number, text: string) =>
      projector.accept(
        live(seq, "session.next.tool.progress", {
          assistantMessageID: "assistant-1",
          callID: "call-1",
          structured: {},
          content: [{ type: "text", text }],
          timestamp: seq,
        })
      ).events

    expect(progress(2, "Build")).toEqual([
      {
        kind: TurnEventKind.ToolCallOutputChunk,
        toolCallId: "call-1",
        text: "Build",
      },
    ])
    expect(progress(3, "Building")).toEqual([
      {
        kind: TurnEventKind.ToolCallOutputChunk,
        toolCallId: "call-1",
        text: "ing",
      },
    ])
    expect(progress(4, "Building")).toEqual([])
    expect(progress(5, "Rewritten")).toEqual([])
  })

  // Live and replayed durable events project through one path, so a recovered
  // turn reports the same facts the watched turn did.
  type Frame = [seq: number, type: string, data: Record<string, unknown>]
  function valid(events: TurnEvent[]) {
    for (const event of events)
      expect(TurnEventSchema.safeParse(event).success).toBe(true)
    return events
  }
  describe.each([
    [
      "live",
      (projector: OpenCodeEventProjector, ...[seq, type, data]: Frame) =>
        valid(projector.accept(live(seq, type, data)).events),
    ],
    [
      "replayed",
      (projector: OpenCodeEventProjector, ...[seq, type, data]: Frame) =>
        valid(projector.acceptHistory(durable(seq, type, data)).events),
    ],
  ] as const)("%s durable events", (_, accept) => {
    it("tell an operator shell command as a call that runs a terminal", () => {
      const projector = new OpenCodeEventProjector(sessionId, 0)

      expect(
        accept(projector, 1, "session.next.shell.started", {
          messageID: "shell-1",
          callID: "call-shell",
          command: "ls",
          timestamp: 1_000,
        })
      ).toEqual([
        {
          kind: TurnEventKind.ToolCallStarted,
          toolCallId: "call-shell",
          title: "shell",
          name: "shell",
          toolKind: ToolKind.Execute,
          startedAt: "1970-01-01T00:16:40.000Z",
          parentMessageId: "shell-1",
        },
        {
          kind: TurnEventKind.ToolCallInputChunk,
          toolCallId: "call-shell",
          delta: '{"command":"ls"}',
        },
        {
          kind: TurnEventKind.TerminalOutput,
          terminalId: "call-shell",
          toolCallId: "call-shell",
          command: "ls",
        },
      ])
      expect(
        accept(projector, 2, "session.next.shell.ended", {
          callID: "call-shell",
          output: "README.md\n",
          timestamp: 2_000,
        })
      ).toEqual([
        {
          kind: TurnEventKind.TerminalOutput,
          terminalId: "call-shell",
          toolCallId: "call-shell",
          data: "README.md\n",
          exit: {},
        },
        { kind: TurnEventKind.ToolCallInputEnded, toolCallId: "call-shell" },
        {
          kind: TurnEventKind.ToolCallFinished,
          toolCallId: "call-shell",
          output: "README.md\n",
          failed: false,
          completedAt: "1970-01-01T00:33:20.000Z",
        },
      ])
    })

    it("ignore the end of a shell that started before the segment", () => {
      const projector = new OpenCodeEventProjector(sessionId, 0)
      expect(
        accept(projector, 1, "session.next.shell.ended", {
          callID: "call-shell",
          output: "",
          timestamp: 1,
        })
      ).toEqual([])
    })

    it("report a compaction's start and its summary, never the kept tail", () => {
      const projector = new OpenCodeEventProjector(sessionId, 0)
      const events = [
        ...accept(projector, 1, "session.next.compaction.started", {
          messageID: "compaction-1",
          reason: "auto",
          timestamp: 1,
        }),
        ...accept(projector, 2, "session.next.compaction.ended", {
          messageID: "compaction-1",
          reason: "auto",
          text: "Earlier work",
          recent: "private recent data",
          timestamp: 2,
        }),
      ]

      expect(events).toEqual([
        {
          kind: TurnEventKind.CompactionUpdated,
          compactionId: "compaction-1",
          status: CompactionStatus.Started,
        },
        {
          kind: TurnEventKind.CompactionUpdated,
          compactionId: "compaction-1",
          status: CompactionStatus.Completed,
          summary: "Earlier work",
        },
      ])
    })

    it("name a model switch by its Session model catalog id", () => {
      const projector = new OpenCodeEventProjector(sessionId, 0)
      expect(
        accept(projector, 1, "session.next.model.switched", {
          messageID: "switch-1",
          model: { id: "claude", providerID: "anthropic" },
          timestamp: 1,
        })
      ).toEqual([
        {
          kind: TurnEventKind.ModelChanged,
          modelId: '["anthropic","claude"]',
        },
      ])
    })
  })
})
