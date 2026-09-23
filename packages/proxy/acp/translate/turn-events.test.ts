import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it } from "vitest"

import {
  AOS_META_KEY,
  AOS_PLAN_ID,
  AOS_STOP_REASONS,
  AosChunkMetaSchema,
  AosPlanMetaSchema,
  AosStateMetaSchema,
  AosToolCallMetaSchema,
  AosTurnMetaSchema,
} from "../../../protocol/acp"
import {
  CompactionStatus,
  DiffOperation,
  StopReason,
  SubagentStatus,
  ToolKind,
  TurnEventKind,
  type TurnEvent,
  type TurnEventOf,
} from "../../core/events"
import {
  initialTranslateState,
  type AcpOutbound,
  type TranslateContext,
  type TranslateState,
} from "../types"
import { translateTurnEvent } from "./turn-events"

/** The moment every state update in this suite stamps itself with. */
const AT = "2026-09-22T10:00:00.000Z"

const context: TranslateContext = {
  turnId: "run-1",
  sequence: 7,
  lane: "operator",
  stopping: false,
  now: () => Date.parse(AT),
}

function translate(
  events: TurnEvent[],
  overrides?: Partial<TranslateContext>,
  initial: TranslateState = initialTranslateState
) {
  let state = initial
  const outbound: AcpOutbound[] = []
  for (const event of events) {
    const step = translateTurnEvent(state, event, { ...context, ...overrides })
    state = step.state
    outbound.push(...step.outbound)
  }
  return { state, outbound }
}

function updatesOf(outbound: AcpOutbound[]) {
  return outbound.flatMap((item) =>
    item.kind === "update" ? [item.update] : []
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function aosMeta(update: SessionUpdate): unknown {
  const meta: unknown = update._meta
  return isRecord(meta) ? meta[AOS_META_KEY] : undefined
}

const started: TurnEvent = { kind: TurnEventKind.TurnStarted }

const finished: TurnEvent = { kind: TurnEventKind.TurnEnded }

/** Todos the adapter reported, which the translator still checks against the wire. */
function planUpdated(todos: unknown): TurnEvent {
  return {
    kind: TurnEventKind.PlanUpdated,
    todos: todos as TurnEventOf<typeof TurnEventKind.PlanUpdated>["todos"],
  }
}

function messageChunk(messageId: string, text: string): TurnEvent {
  return { kind: TurnEventKind.MessageChunk, messageId, text }
}

const todo = { id: "t1", label: "Ship it", status: "active" as const }

describe("translateTurnEvent lifecycle", () => {
  it("reports a started run as running with parseable run metadata", () => {
    const [update] = updatesOf(translate([started]).outbound)

    expect(update).toMatchObject({
      sessionUpdate: "state_update",
      state: "running",
    })
    expect(AosStateMetaSchema.parse(aosMeta(update!))).toEqual({
      sequence: 7,
      turnId: "run-1",
      at: AT,
    })
  })

  it.each([
    ["end_turn", false],
    ["cancelled", true],
  ])("settles an uninterrupted run as idle %s", (stopReason, stopping) => {
    const { state, outbound } = translate([finished], { stopping })

    expect(updatesOf(outbound)).toEqual([
      {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason,
        _meta: { [AOS_META_KEY]: { sequence: 7, turnId: "run-1", at: AT } },
      },
    ])
    expect(state).toEqual(initialTranslateState)
  })

  it("emits a composer prefill before the idle state", () => {
    const { outbound } = translate([
      { kind: TurnEventKind.TurnEnded, composerPrefill: "retry this" },
    ])

    expect(outbound[0]).toEqual({
      kind: "composer-prefill",
      turnId: "run-1",
      text: "retry this",
    })
    expect(outbound[1]).toMatchObject({ kind: "update" })
  })

  it("requires action and forwards every pending request of the segment", () => {
    const { outbound } = translate([
      {
        kind: TurnEventKind.TurnRequiresAction,
        requests: [
          {
            requestId: "i1",
            kind: "permission",
            responseSchema: { enum: ["once"] },
          },
          { requestId: "i2", kind: "elicitation", message: "Which one?" },
        ],
      },
    ])

    expect(updatesOf(outbound)[0]).toMatchObject({ state: "requires_action" })
    expect(outbound.slice(1).map((item) => item.kind)).toEqual([
      "request-permission",
      "elicitation",
    ])
  })

  it.each([
    ["AOS_TOOL_FAILED", AOS_STOP_REASONS.error],
    ["AOS_CONNECTION_INTERRUPTED", AOS_STOP_REASONS.uncertain],
  ])("maps the %s run error to %s", (code, stopReason) => {
    const { state, outbound } = translate([
      { kind: TurnEventKind.TurnFailed, message: "provider refused", code },
    ])
    const [update] = updatesOf(outbound)

    expect(update).toMatchObject({ state: "idle", stopReason })
    expect(AosStateMetaSchema.parse(aosMeta(update!))).toEqual({
      sequence: 7,
      turnId: "run-1",
      at: AT,
      code,
      message: "provider refused",
    })
    expect(state).toEqual(initialTranslateState)
  })

  it("reports a failure awaiting Stop as a running state that keeps the segment", () => {
    const { state: streaming } = translate([messageChunk("m1", "he")])
    const { state, outbound } = translate(
      [
        {
          kind: TurnEventKind.TurnFailed,
          code: "AOS_INTERACTION_LOST",
          message: "question lost",
          awaitingStop: true,
        },
      ],
      undefined,
      streaming
    )
    const [update] = updatesOf(outbound)

    expect(update).toMatchObject({
      sessionUpdate: "state_update",
      state: "running",
    })
    expect(update).not.toHaveProperty("stopReason")
    expect(AosStateMetaSchema.parse(aosMeta(update!))).toEqual({
      sequence: 7,
      turnId: "run-1",
      at: AT,
      code: "AOS_INTERACTION_LOST",
      message: "question lost",
    })
    expect(state).toBe(streaming)
  })
})

describe("translateTurnEvent messages", () => {
  it("streams assistant prose as message chunks and keeps the message id", () => {
    const { state, outbound } = translate([messageChunk("m1", "he")])
    const [update] = updatesOf(outbound)

    expect(updatesOf(outbound)).toHaveLength(1)
    expect(update).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: "he" },
    })
    expect(AosChunkMetaSchema.parse(aosMeta(update!))).toEqual({
      sequence: 7,
      turnId: "run-1",
    })
    expect(state.messageId).toBe("m1")
  })

  it("collapses a reasoning-first segment onto one assistant message", () => {
    const { state, outbound } = translate([
      { kind: TurnEventKind.ThoughtChunk, messageId: "m1", text: "think" },
      messageChunk("m1", "he"),
      {
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "c1",
        title: "read_file",
      },
    ])

    expect(updatesOf(outbound)).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "m1",
        content: { type: "text", text: "think" },
        _meta: { [AOS_META_KEY]: { sequence: 7, turnId: "run-1" } },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: { type: "text", text: "he" },
        _meta: { [AOS_META_KEY]: { sequence: 7, turnId: "run-1" } },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        title: "read_file",
        status: "in_progress",
        _meta: {
          [AOS_META_KEY]: { sequence: 7, turnId: "run-1", messageId: "m1" },
        },
      },
    ])
    expect(state.messageId).toBe("m1")
  })

  it("streams reasoning under the message id the prose opened", () => {
    const { outbound } = translate([
      messageChunk("m1", "he"),
      { kind: TurnEventKind.ThoughtChunk, messageId: "m1", text: "think" },
    ])

    expect(updatesOf(outbound)[1]).toEqual({
      sessionUpdate: "agent_thought_chunk",
      messageId: "m1",
      content: { type: "text", text: "think" },
      _meta: { [AOS_META_KEY]: { sequence: 7, turnId: "run-1" } },
    })
  })

  it("keeps the segment's first message id across later message ids", () => {
    const { outbound } = translate([
      messageChunk("m1", "he"),
      messageChunk("m2", "more"),
    ])

    expect(updatesOf(outbound)).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: { type: "text", text: "he" },
        _meta: { [AOS_META_KEY]: { sequence: 7, turnId: "run-1" } },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: { type: "text", text: "more" },
        _meta: { [AOS_META_KEY]: { sequence: 7, turnId: "run-1" } },
      },
    ])
  })
})

describe("translateTurnEvent tool calls", () => {
  const lifecycle: TurnEvent[] = [
    {
      kind: TurnEventKind.ToolCallStarted,
      toolCallId: "c1",
      title: "read_file",
      parentMessageId: "m1",
    },
    {
      kind: TurnEventKind.ToolCallInputChunk,
      toolCallId: "c1",
      delta: '{"p":',
    },
    { kind: TurnEventKind.ToolCallInputChunk, toolCallId: "c1", delta: '"a"}' },
    { kind: TurnEventKind.ToolCallInputEnded, toolCallId: "c1" },
  ]

  it("opens, streams, and closes one tool call attached to the message", () => {
    const { state, outbound } = translate(lifecycle)
    const updates = updatesOf(outbound)

    expect(updates[0]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      title: "read_file",
      status: "in_progress",
    })
    expect(AosToolCallMetaSchema.parse(aosMeta(updates[1]!))).toEqual({
      sequence: 7,
      turnId: "run-1",
      messageId: "m1",
      argsTextDelta: '{"p":',
    })
    expect(updates[3]).toMatchObject({
      toolCallId: "c1",
      rawInput: { p: "a" },
    })
    expect(AosToolCallMetaSchema.parse(aosMeta(updates[3]!))).toMatchObject({
      argsText: '{"p":"a"}',
    })
    expect(state.toolArgsText).toEqual({})
  })

  it.each([
    ["the streaming message over the event's parent", "m9", "m1", "m1"],
    ["the streaming message", undefined, "m1", "m1"],
    ["the parent message of the event", "m9", undefined, "m9"],
    ["the run itself", undefined, undefined, "run-1"],
  ])(
    "attaches a tool call to %s",
    (_label, parentMessageId, messageId, expected) => {
      const events: TurnEvent[] = [
        ...(messageId ? [messageChunk(messageId, "he")] : []),
        {
          kind: TurnEventKind.ToolCallStarted,
          toolCallId: "c1",
          title: "read_file",
          ...(parentMessageId ? { parentMessageId } : {}),
        },
      ]

      const update = updatesOf(translate(events).outbound).at(-1)

      expect(AosToolCallMetaSchema.parse(aosMeta(update!)).messageId).toBe(
        expected
      )
    }
  )

  it("streams one message across the provider's mid-turn message rotation", () => {
    // Hermes rotates its message id at every `message.interim`: the commentary
    // is one message, the tools that follow another, the closing text a third.
    // History replays the whole turn as one message, so the live stream must.
    const { outbound } = translate([
      messageChunk("m1", "Checking."),
      {
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "c1",
        title: "terminal",
        parentMessageId: "run-1:assistant:2",
      },
      { kind: TurnEventKind.ToolCallInputEnded, toolCallId: "c1" },
      {
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "c1",
        output: "ok",
        failed: false,
      },
      messageChunk("run-1:assistant:3", "Done."),
    ])

    // Chunks name their message on the update; tool calls in `_meta.aos`.
    const owners = updatesOf(outbound).map((update) => {
      const meta = aosMeta(update)
      return "messageId" in update
        ? update.messageId
        : isRecord(meta)
          ? meta.messageId
          : undefined
    })
    expect(owners).toEqual(["m1", "m1", "m1", "m1", "m1"])
  })

  it("lets a tool call that opens the segment name it for the text after", () => {
    const { outbound } = translate([
      {
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "c1",
        title: "read_file",
        parentMessageId: "m9",
      },
      messageChunk("m1", "Read."),
    ])

    const [call, chunk] = updatesOf(outbound)
    expect(AosToolCallMetaSchema.parse(aosMeta(call!)).messageId).toBe("m9")
    expect(chunk).toMatchObject({ messageId: "m9" })
  })

  it("keeps unparseable streamed arguments as text", () => {
    const { outbound } = translate([
      {
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "c1",
        title: "read_file",
      },
      {
        kind: TurnEventKind.ToolCallInputChunk,
        toolCallId: "c1",
        delta: "{oops",
      },
      { kind: TurnEventKind.ToolCallInputEnded, toolCallId: "c1" },
    ])

    expect(updatesOf(outbound)[2]).toMatchObject({
      rawInput: { text: "{oops" },
    })
  })

  it.each([
    ['{"status":"failed"}', true, "failed", { status: "failed" }],
    ["plain provider text", true, "failed", "plain provider text"],
    ['{"status":"completed"}', false, "completed", { status: "completed" }],
    ["plain provider text", false, "completed", "plain provider text"],
  ])(
    "settles the result %s reported failed=%s as %s",
    (output, failed, status, rawOutput) => {
      const [update] = updatesOf(
        translate([
          {
            kind: TurnEventKind.ToolCallFinished,
            toolCallId: "c1",
            output,
            failed,
          },
        ]).outbound
      )

      expect(update).toMatchObject({
        toolCallId: "c1",
        status,
        rawOutput,
        content: [{ type: "content", content: { type: "text", text: output } }],
      })
    }
  )
})

describe("translateTurnEvent plans", () => {
  it.each([
    ["pending", "pending"],
    ["active", "in_progress"],
    ["completed", "completed"],
    ["failed", "_failed"],
  ])("maps the %s Todo to the %s plan entry", (todoStatus, status) => {
    const [update] = updatesOf(
      translate([planUpdated([{ ...todo, status: todoStatus }])]).outbound
    )

    expect(update).toMatchObject({
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: AOS_PLAN_ID,
        entries: [{ content: "Ship it", priority: "medium", status }],
      },
    })
  })

  it("keeps the Session Todos losslessly in plan metadata", () => {
    const [update] = updatesOf(translate([planUpdated([todo])]).outbound)

    expect(AosPlanMetaSchema.parse(aosMeta(update!))).toEqual({
      sequence: 7,
      turnId: "run-1",
      todos: [todo],
    })
  })

  it("drops Todos that do not parse", () => {
    expect(translate([planUpdated([{ id: "t1" }])]).outbound).toEqual([])
  })
})

describe("translateTurnEvent extensions", () => {
  const artifact = {
    id: "a1",
    filename: "chart.png",
    mimeType: "image/png",
    source: { type: "provider" as const, reference: "a1" },
  }

  /** A descriptor the adapter reported, which the wire contract still checks. */
  function published(value: unknown): TurnEvent {
    return {
      kind: TurnEventKind.ArtifactPublished,
      artifact: value as TurnEventOf<
        typeof TurnEventKind.ArtifactPublished
      >["artifact"],
    }
  }

  it("grants a validated artifact against the streaming message", () => {
    const { outbound } = translate([
      messageChunk("m1", "he"),
      published(artifact),
    ])

    expect(outbound.filter((item) => item.kind === "artifact")).toEqual([
      { kind: "artifact", turnId: "run-1", messageId: "m1", artifact },
    ])
  })

  it("grants an artifact whose publisher knew a size but no media type", () => {
    const descriptor = {
      id: "a2",
      filename: "report.md",
      sizeBytes: 4_096,
      source: { type: "provider", reference: "a2" },
    }

    expect(translate([published(descriptor)]).outbound).toEqual([
      { kind: "artifact", turnId: "run-1", artifact: descriptor },
    ])
  })

  it.each([
    ["an artifact missing its source", { id: "a1", filename: "chart.png" }],
    ["a negative artifact size", { ...artifact, sizeBytes: -1 }],
    ["an unknown artifact source", { ...artifact, source: { type: "magic" } }],
  ])("drops %s", (_label, value) => {
    expect(translate([published(value)]).outbound).toEqual([])
  })

  const accepted = (
    requestId: string,
    text: string,
    delivery: "queued" | "steered" = "steered"
  ): TurnEvent => ({
    kind: TurnEventKind.SteerAccepted,
    requestId,
    text,
    delivery,
  })

  it("forwards an accepted steer", () => {
    expect(
      translate([accepted("s1", "also check the logs", "queued")]).outbound
    ).toEqual([
      {
        kind: "steer-accepted",
        turnId: "run-1",
        requestId: "s1",
        text: "also check the logs",
        delivery: "queued",
      },
    ])
  })

  it("drops the acceptances the replayed history already carried", () => {
    const replay = translate(
      [accepted("s1", "first"), accepted("s2", "second")],
      undefined,
      { ...initialTranslateState, replayedCorrections: 2 }
    )

    expect(replay.outbound).toEqual([])
    expect(replay.state.replayedCorrections).toBe(0)
    expect(
      translate([accepted("s3", "third")], undefined, replay.state).outbound
    ).toEqual([
      {
        kind: "steer-accepted",
        turnId: "run-1",
        requestId: "s3",
        text: "third",
        delivery: "steered",
      },
    ])
  })
})

describe("provider facts", () => {
  const turn = { sequence: 7, turnId: "run-1" }

  function toolStarted(
    fields: Partial<TurnEventOf<typeof TurnEventKind.ToolCallStarted>> = {}
  ): TurnEvent {
    return {
      kind: TurnEventKind.ToolCallStarted,
      toolCallId: "c1",
      title: "Read README.md",
      parentMessageId: "m1",
      ...fields,
    }
  }

  function toolFinished(
    fields: Partial<TurnEventOf<typeof TurnEventKind.ToolCallFinished>> = {}
  ): TurnEvent {
    return {
      kind: TurnEventKind.ToolCallFinished,
      toolCallId: "c1",
      output: "done",
      failed: false,
      ...fields,
    }
  }

  function terminal(
    fields: Partial<TurnEventOf<typeof TurnEventKind.TerminalOutput>> = {}
  ): TurnEvent {
    return {
      kind: TurnEventKind.TerminalOutput,
      terminalId: "term-1",
      toolCallId: "c1",
      ...fields,
    }
  }

  function lastUpdate(events: TurnEvent[]) {
    return updatesOf(translate(events).outbound).at(-1)!
  }

  it("spells every stop reason in ACP's words", () => {
    const spelled = {
      [StopReason.EndTurn]: "end_turn",
      [StopReason.MaxTokens]: "max_tokens",
      [StopReason.MaxTurnRequests]: "max_turn_requests",
      [StopReason.Refusal]: "refusal",
      [StopReason.Cancelled]: "cancelled",
    }
    for (const [stopReason, acp] of Object.entries(spelled))
      expect(
        lastUpdate([
          {
            kind: TurnEventKind.TurnEnded,
            stopReason: stopReason as StopReason,
          },
        ])
      ).toMatchObject({ sessionUpdate: "state_update", stopReason: acp })
  })

  it("lets the provider's stop reason win over an acknowledged Stop", () => {
    const update = updatesOf(
      translate(
        [{ kind: TurnEventKind.TurnEnded, stopReason: StopReason.MaxTokens }],
        { stopping: true }
      ).outbound
    )[0]
    expect(update).toMatchObject({ stopReason: "max_tokens" })
  })

  it("sums the turn's provider calls into one ACP usage", () => {
    const update = lastUpdate([
      {
        kind: TurnEventKind.TurnEnded,
        usage: [
          {
            provider: "a",
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 2,
            cachedInputTokens: 4,
          },
          {
            provider: "b",
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            cachedWriteTokens: 3,
          },
        ],
      },
    ])
    expect(update).toMatchObject({
      usage: {
        inputTokens: 11,
        outputTokens: 6,
        totalTokens: 2,
        thoughtTokens: 2,
        cachedReadTokens: 4,
        cachedWriteTokens: 3,
      },
    })
  })

  it("derives the total from input and output when nobody reported one", () => {
    expect(
      lastUpdate([
        {
          kind: TurnEventKind.TurnEnded,
          usage: [{ inputTokens: 3, outputTokens: 4 }],
        },
      ])
    ).toMatchObject({
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    })
  })

  it("reports no usage rather than zeros when input or output is unknown", () => {
    expect(
      lastUpdate([
        { kind: TurnEventKind.TurnEnded, usage: [{ totalTokens: 12 }] },
      ])
    ).not.toHaveProperty("usage")
  })

  it("carries the turn's cost in the state meta", () => {
    const update = lastUpdate([
      {
        kind: TurnEventKind.TurnEnded,
        cost: { amount: 0.25, currency: "USD" },
      },
    ])
    expect(AosStateMetaSchema.parse(aosMeta(update)).cost).toEqual({
      amount: 0.25,
      currency: "USD",
    })
  })

  it("names the provider and model a failure ran on", () => {
    const update = lastUpdate([
      {
        kind: TurnEventKind.TurnFailed,
        code: "AOS_PROVIDER_ERROR",
        message: "overloaded",
        provider: "anthropic",
        model: "claude",
      },
    ])
    expect(AosStateMetaSchema.parse(aosMeta(update))).toMatchObject({
      provider: "anthropic",
      model: "claude",
    })
  })

  it("puts a call's name, kind, and locations in ACP's own fields", () => {
    const update = lastUpdate([
      toolStarted({
        name: "read_file",
        toolKind: ToolKind.Read,
        locations: [{ path: "/repo/README.md", line: 3 }],
        startedAt: "2026-09-22T10:00:01.000Z",
      }),
    ])
    expect(update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      title: "Read README.md",
      name: "read_file",
      kind: "read",
      status: "in_progress",
      locations: [{ path: "/repo/README.md", line: 3 }],
    })
    expect(AosToolCallMetaSchema.parse(aosMeta(update))).toEqual({
      ...turn,
      messageId: "m1",
      startedAt: "2026-09-22T10:00:01.000Z",
    })
  })

  it("attributes a subagent's chunks and calls to the call that spawned it", () => {
    const updates = updatesOf(
      translate([
        toolStarted({
          name: "delegate_task",
          subagent: { id: "sub-1", goal: "audit", depth: 1 },
        }),
        {
          kind: TurnEventKind.MessageChunk,
          messageId: "m1",
          text: "child prose",
          subagentId: "sub-1",
        },
        toolStarted({ toolCallId: "c2", subagentId: "sub-1" }),
      ]).outbound
    )
    expect(AosToolCallMetaSchema.parse(aosMeta(updates[0]!)).subagent).toEqual({
      id: "sub-1",
      goal: "audit",
      depth: 1,
    })
    expect(AosChunkMetaSchema.parse(aosMeta(updates[1]!))).toEqual({
      ...turn,
      subagentId: "sub-1",
      parentToolCallId: "c1",
    })
    expect(AosToolCallMetaSchema.parse(aosMeta(updates[2]!))).toMatchObject({
      subagentId: "sub-1",
      parentToolCallId: "c1",
    })
  })

  it("names a subagent without a parent it never saw spawned", () => {
    const update = lastUpdate([
      {
        kind: TurnEventKind.ThoughtChunk,
        messageId: "m1",
        text: "child thought",
        subagentId: "sub-9",
      },
    ])
    expect(AosChunkMetaSchema.parse(aosMeta(update))).toEqual({
      ...turn,
      subagentId: "sub-9",
    })
  })

  it("appends streamed tool output as call content", () => {
    const update = lastUpdate([
      toolStarted(),
      {
        kind: TurnEventKind.ToolCallOutputChunk,
        toolCallId: "c1",
        text: "line 1",
      },
    ])
    expect(update).toMatchObject({
      sessionUpdate: "tool_call_content_chunk",
      toolCallId: "c1",
      content: { type: "content", content: { type: "text", text: "line 1" } },
    })
    expect(AosToolCallMetaSchema.parse(aosMeta(update))).toEqual({
      ...turn,
      messageId: "m1",
    })
  })

  it("settles a call with its diffs, locations, and timing", () => {
    const update = lastUpdate([
      toolStarted(),
      toolFinished({
        diffs: [
          {
            changes: [
              { operation: DiffOperation.Modify, path: "/repo/a.ts" },
              {
                operation: DiffOperation.Move,
                oldPath: "/repo/b.ts",
                path: "/repo/c.ts",
              },
            ],
            patch: "diff --git a/a.ts b/a.ts",
          },
          { changes: [{ operation: DiffOperation.Add, path: "/repo/d.ts" }] },
        ],
        locations: [{ path: "/repo/a.ts" }],
        completedAt: "2026-09-22T10:00:02.000Z",
        durationMs: 1000,
      }),
    ])
    expect(update).toMatchObject({
      status: "completed",
      locations: [{ path: "/repo/a.ts" }],
      content: [
        { type: "content", content: { type: "text", text: "done" } },
        {
          type: "diff",
          changes: [
            { operation: "modify", path: "/repo/a.ts" },
            { operation: "move", oldPath: "/repo/b.ts", path: "/repo/c.ts" },
          ],
          patch: { format: "git_patch", text: "diff --git a/a.ts b/a.ts" },
        },
        { type: "diff", changes: [{ operation: "add", path: "/repo/d.ts" }] },
      ],
    })
    expect(update).not.toHaveProperty("content.2.patch")
    expect(AosToolCallMetaSchema.parse(aosMeta(update))).toMatchObject({
      completedAt: "2026-09-22T10:00:02.000Z",
      durationMs: 1000,
    })
  })

  it("announces a terminal once and streams its output as base64", () => {
    const updates = updatesOf(
      translate([
        toolStarted(),
        terminal({ command: "ls", cwd: "/repo", data: "a.txt\n" }),
        terminal({ data: "שלום" }),
        terminal({ exit: { exitCode: 0 } }),
      ]).outbound
    )
    expect(updates.slice(1)).toMatchObject([
      {
        sessionUpdate: "terminal_update",
        terminalId: "term-1",
        command: "ls",
        cwd: "/repo",
      },
      {
        sessionUpdate: "tool_call_content_chunk",
        toolCallId: "c1",
        content: { type: "terminal", terminalId: "term-1" },
      },
      {
        sessionUpdate: "terminal_output_chunk",
        terminalId: "term-1",
        data: Buffer.from("a.txt\n").toString("base64"),
      },
      {
        sessionUpdate: "terminal_output_chunk",
        data: Buffer.from("שלום", "utf8").toString("base64"),
      },
      { sessionUpdate: "terminal_update", exitStatus: { exitCode: 0 } },
    ])
    expect(updates).toHaveLength(6)
    expect(AosTurnMetaSchema.parse(aosMeta(updates[1]!))).toEqual(turn)
  })

  it("restates a call's terminals when the call settles", () => {
    const update = lastUpdate([
      toolStarted(),
      terminal({ command: "ls" }),
      toolFinished(),
    ])
    expect(update).toMatchObject({
      content: [
        { type: "content" },
        { type: "terminal", terminalId: "term-1" },
      ],
    })
  })

  it("keeps a compaction's summary and error to the status ACP allows them on", () => {
    function compaction(status: CompactionStatus) {
      return lastUpdate([
        {
          kind: TurnEventKind.CompactionUpdated,
          compactionId: "k1",
          status,
          summary: "so far",
          error: "timed out",
        },
      ])
    }
    expect(compaction(CompactionStatus.Started)).toEqual({
      sessionUpdate: "compaction_update",
      compactionId: "k1",
      status: "in_progress",
      _meta: { [AOS_META_KEY]: turn },
    })
    expect(compaction(CompactionStatus.Completed)).toMatchObject({
      status: "completed",
      summary: [{ type: "text", text: "so far" }],
    })
    expect(compaction(CompactionStatus.Completed)).not.toHaveProperty("error")
    expect(compaction(CompactionStatus.Failed)).toMatchObject({
      status: "failed",
      error: "timed out",
    })
    expect(compaction(CompactionStatus.Failed)).not.toHaveProperty("summary")
  })

  it("hands a model change to the attachment", () => {
    expect(
      translate([{ kind: TurnEventKind.ModelChanged, modelId: "claude" }])
        .outbound
    ).toEqual([{ kind: "model-changed", modelId: "claude" }])
  })

  it("patches a subagent onto the call that spawned it", () => {
    const update = lastUpdate([
      toolStarted(),
      {
        kind: TurnEventKind.SubagentUpdated,
        toolCallId: "c1",
        subagent: {
          id: "sub-1",
          status: SubagentStatus.Completed,
          summary: "done",
        },
      },
    ])
    expect(update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
    })
    expect(AosToolCallMetaSchema.parse(aosMeta(update)).subagent).toEqual({
      id: "sub-1",
      status: "completed",
      summary: "done",
    })
  })

  it("drops a subagent patch the wire contract refuses", () => {
    expect(
      translate([
        {
          kind: TurnEventKind.SubagentUpdated,
          toolCallId: "c1",
          subagent: { id: "" },
        },
      ]).outbound
    ).toEqual([])
  })
})
