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
} from "../../../protocol/acp"
import { RunEventKind, type RunEvent, type RunEventOf } from "../../core/events"
import {
  initialTranslateState,
  type AcpOutbound,
  type TranslateContext,
  type TranslateState,
} from "../types"
import { translateRunEvent } from "./run-events"

/** The moment every state update in this suite stamps itself with. */
const AT = "2026-09-22T10:00:00.000Z"

const context: TranslateContext = {
  runId: "run-1",
  sequence: 7,
  lane: "operator",
  stopping: false,
  now: () => Date.parse(AT),
}

function translate(
  events: RunEvent[],
  overrides?: Partial<TranslateContext>,
  initial: TranslateState = initialTranslateState
) {
  let state = initial
  const outbound: AcpOutbound[] = []
  for (const event of events) {
    const step = translateRunEvent(state, event, { ...context, ...overrides })
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

const started: RunEvent = {
  type: RunEventKind.RUN_STARTED,
  threadId: "session-1",
  runId: "run-1",
}

function finished(
  extra?: Partial<RunEventOf<typeof RunEventKind.RUN_FINISHED>>
): RunEvent {
  return {
    type: RunEventKind.RUN_FINISHED,
    threadId: "session-1",
    runId: "run-1",
    ...extra,
  }
}

function planSnapshot(todos: unknown, activityType = "PLAN"): RunEvent {
  return {
    type: RunEventKind.ACTIVITY_SNAPSHOT,
    messageId: "aos-plan:session-1",
    activityType,
    content: { todos },
    replace: true,
  }
}

function planDelta(patch: unknown[]): RunEvent {
  return {
    type: RunEventKind.ACTIVITY_DELTA,
    messageId: "aos-plan:session-1",
    activityType: "PLAN",
    patch,
  }
}

const todo = { id: "t1", label: "Ship it", status: "active" as const }

describe("translateRunEvent lifecycle", () => {
  it("reports a started run as running with parseable run metadata", () => {
    const [update] = updatesOf(translate([started]).outbound)

    expect(update).toMatchObject({
      sessionUpdate: "state_update",
      state: "running",
    })
    expect(AosStateMetaSchema.parse(aosMeta(update!))).toEqual({
      sequence: 7,
      runId: "run-1",
      at: AT,
    })
  })

  it.each([
    ["end_turn", false],
    ["cancelled", true],
  ])("settles an uninterrupted run as idle %s", (stopReason, stopping) => {
    const { state, outbound } = translate([finished()], { stopping })

    expect(updatesOf(outbound)).toEqual([
      {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason,
        _meta: { [AOS_META_KEY]: { sequence: 7, runId: "run-1", at: AT } },
      },
    ])
    expect(state).toEqual(initialTranslateState)
  })

  it("emits a composer prefill before the idle state", () => {
    const { outbound } = translate([
      finished({ result: { "aos.composerPrefill": "retry this" } }),
    ])

    expect(outbound[0]).toEqual({
      kind: "composer-prefill",
      runId: "run-1",
      text: "retry this",
    })
    expect(outbound[1]).toMatchObject({ kind: "update" })
  })

  it("requires action and forwards every pending request of the segment", () => {
    const { outbound } = translate([
      finished({
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "i1",
              reason: "approval",
              responseSchema: { enum: ["once"] },
            },
            { id: "i2", reason: "question", message: "Which one?" },
          ],
        },
      }),
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
      { type: RunEventKind.RUN_ERROR, message: "provider refused", code },
    ])
    const [update] = updatesOf(outbound)

    expect(update).toMatchObject({ state: "idle", stopReason })
    expect(AosStateMetaSchema.parse(aosMeta(update!))).toEqual({
      sequence: 7,
      runId: "run-1",
      at: AT,
      code,
      message: "provider refused",
    })
    expect(state).toEqual(initialTranslateState)
  })

  it("reports a failure awaiting Stop as a running state that keeps the segment", () => {
    const { state: streaming } = translate([
      {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      },
    ])
    const { state, outbound } = translate(
      [
        {
          type: RunEventKind.RUN_ERROR,
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
      runId: "run-1",
      at: AT,
      code: "AOS_INTERACTION_LOST",
      message: "question lost",
    })
    expect(state).toBe(streaming)
  })
})

describe("translateRunEvent messages", () => {
  it("streams assistant prose as message chunks and keeps the message id", () => {
    const { state, outbound } = translate([
      {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      },
      { type: RunEventKind.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "he" },
      { type: RunEventKind.TEXT_MESSAGE_END, messageId: "m1" },
    ])
    const [update] = updatesOf(outbound)

    expect(updatesOf(outbound)).toHaveLength(1)
    expect(update).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: "he" },
    })
    expect(AosChunkMetaSchema.parse(aosMeta(update!))).toEqual({
      sequence: 7,
      runId: "run-1",
    })
    expect(state.messageId).toBe("m1")
  })

  it("collapses a reasoning-first segment onto one assistant message", () => {
    const { state, outbound } = translate([
      { type: RunEventKind.REASONING_START, messageId: "m1:reasoning" },
      {
        type: RunEventKind.REASONING_MESSAGE_START,
        messageId: "m1:reasoning",
        role: "reasoning",
      },
      {
        type: RunEventKind.REASONING_MESSAGE_CONTENT,
        messageId: "m1:reasoning",
        delta: "think",
      },
      { type: RunEventKind.REASONING_MESSAGE_END, messageId: "m1:reasoning" },
      { type: RunEventKind.REASONING_END, messageId: "m1:reasoning" },
      {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      },
      { type: RunEventKind.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "he" },
      {
        type: RunEventKind.TOOL_CALL_START,
        toolCallId: "c1",
        toolCallName: "read_file",
      },
    ])

    expect(updatesOf(outbound)).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "m1",
        content: { type: "text", text: "think" },
        _meta: { [AOS_META_KEY]: { sequence: 7, runId: "run-1" } },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: { type: "text", text: "he" },
        _meta: { [AOS_META_KEY]: { sequence: 7, runId: "run-1" } },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        title: "read_file",
        status: "in_progress",
        _meta: {
          [AOS_META_KEY]: { sequence: 7, runId: "run-1", messageId: "m1" },
        },
      },
    ])
    expect(state.messageId).toBe("m1")
  })

  it("streams reasoning under the message id the prose opened", () => {
    const { outbound } = translate([
      {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      },
      { type: RunEventKind.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "he" },
      {
        type: RunEventKind.REASONING_MESSAGE_START,
        messageId: "m1:reasoning",
        role: "reasoning",
      },
      {
        type: RunEventKind.REASONING_MESSAGE_CONTENT,
        messageId: "m1:reasoning",
        delta: "think",
      },
    ])

    expect(updatesOf(outbound)[1]).toEqual({
      sessionUpdate: "agent_thought_chunk",
      messageId: "m1",
      content: { type: "text", text: "think" },
      _meta: { [AOS_META_KEY]: { sequence: 7, runId: "run-1" } },
    })
  })

  it("keeps one message id across the segment's later message boundaries", () => {
    const { outbound } = translate([
      {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      },
      { type: RunEventKind.TEXT_MESSAGE_END, messageId: "m1" },
      {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "m2",
        role: "assistant",
      },
      {
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "m2",
        delta: "more",
      },
    ])

    expect(updatesOf(outbound)).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: { type: "text", text: "more" },
        _meta: { [AOS_META_KEY]: { sequence: 7, runId: "run-1" } },
      },
    ])
  })

  it.each<[string, RunEvent]>([
    [
      "a text message boundary",
      { type: RunEventKind.TEXT_MESSAGE_END, messageId: "m1" },
    ],
    [
      "a reasoning boundary",
      { type: RunEventKind.REASONING_START, messageId: "m1" },
    ],
    [
      "a reasoning message boundary",
      { type: RunEventKind.REASONING_MESSAGE_END, messageId: "m1" },
    ],
    [
      "an unrelated custom event",
      { type: RunEventKind.CUSTOM, name: "aos.other", value: {} },
    ],
    [
      "non-plan activity",
      {
        type: RunEventKind.ACTIVITY_SNAPSHOT,
        messageId: "a1",
        activityType: "PROGRESS",
        content: {},
        replace: true,
      },
    ],
  ])("drops %s", (_label, event) => {
    expect(translate([event]).outbound).toEqual([])
  })
})

describe("translateRunEvent tool calls", () => {
  const lifecycle: RunEvent[] = [
    {
      type: RunEventKind.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "assistant",
    },
    {
      type: RunEventKind.TOOL_CALL_START,
      toolCallId: "c1",
      toolCallName: "read_file",
    },
    { type: RunEventKind.TOOL_CALL_ARGS, toolCallId: "c1", delta: '{"p":' },
    { type: RunEventKind.TOOL_CALL_ARGS, toolCallId: "c1", delta: '"a"}' },
    { type: RunEventKind.TOOL_CALL_END, toolCallId: "c1" },
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
      runId: "run-1",
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
      const events: RunEvent[] = [
        ...(messageId
          ? [
              {
                type: RunEventKind.TEXT_MESSAGE_START,
                messageId,
                role: "assistant",
              } satisfies RunEvent,
            ]
          : []),
        {
          type: RunEventKind.TOOL_CALL_START,
          toolCallId: "c1",
          toolCallName: "read_file",
          parentMessageId,
        },
      ]

      const [update] = updatesOf(translate(events).outbound)

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
      {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      },
      {
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "Checking.",
      },
      { type: RunEventKind.TEXT_MESSAGE_END, messageId: "m1" },
      {
        type: RunEventKind.TOOL_CALL_START,
        toolCallId: "c1",
        toolCallName: "terminal",
        parentMessageId: "run-1:assistant:2",
      },
      { type: RunEventKind.TOOL_CALL_END, toolCallId: "c1" },
      {
        type: RunEventKind.TOOL_CALL_RESULT,
        messageId: "run-1:assistant:2:tool:c1",
        toolCallId: "c1",
        content: "ok",
        role: "tool",
      },
      {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "run-1:assistant:3",
        role: "assistant",
      },
      {
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "run-1:assistant:3",
        delta: "Done.",
      },
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
        type: RunEventKind.TOOL_CALL_START,
        toolCallId: "c1",
        toolCallName: "read_file",
        parentMessageId: "m9",
      },
      {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      },
      {
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "Read.",
      },
    ])

    const [call, chunk] = updatesOf(outbound)
    expect(AosToolCallMetaSchema.parse(aosMeta(call!)).messageId).toBe("m9")
    expect(chunk).toMatchObject({ messageId: "m9" })
  })

  it("lets a guest's App card that opens the segment name it for the text after", () => {
    const { outbound } = translate(
      [
        {
          type: RunEventKind.TOOL_CALL_RESULT,
          messageId: "result-1",
          toolCallId: "c1",
          toolCallName: "mcp__demo__open_demo",
          content: "",
          app: true,
        },
        {
          type: RunEventKind.TEXT_MESSAGE_START,
          messageId: "m1",
          role: "assistant",
        },
        {
          type: RunEventKind.TEXT_MESSAGE_CONTENT,
          messageId: "m1",
          delta: "Opened.",
        },
      ],
      { lane: "guest" }
    )

    const [card, chunk] = updatesOf(outbound)
    expect(AosToolCallMetaSchema.parse(aosMeta(card!)).messageId).toBe("run-1")
    expect(chunk).toMatchObject({ messageId: "run-1" })
  })

  it("keeps unparseable streamed arguments as text", () => {
    const { outbound } = translate([
      {
        type: RunEventKind.TOOL_CALL_START,
        toolCallId: "c1",
        toolCallName: "read_file",
      },
      { type: RunEventKind.TOOL_CALL_ARGS, toolCallId: "c1", delta: "{oops" },
      { type: RunEventKind.TOOL_CALL_END, toolCallId: "c1" },
    ])

    expect(updatesOf(outbound)[2]).toMatchObject({
      rawInput: { text: "{oops" },
    })
  })

  it.each([
    ['{"status":"failed"}', "failed"],
    ['{"status":"error"}', "failed"],
    ['{"isError":true,"status":"completed"}', "failed"],
    ['{"status":"completed"}', "completed"],
    ["plain provider text", "completed"],
  ])("settles the result %s as %s", (content, status) => {
    const [update] = updatesOf(
      translate([
        {
          type: RunEventKind.TOOL_CALL_RESULT,
          messageId: "m1:tool:c1",
          toolCallId: "c1",
          content,
          role: "tool",
        },
      ]).outbound
    )

    expect(update).toMatchObject({
      toolCallId: "c1",
      status,
      content: [{ type: "content", content: { type: "text", text: content } }],
    })
  })
})

describe("translateRunEvent plans", () => {
  it.each([
    ["pending", "pending"],
    ["active", "in_progress"],
    ["completed", "completed"],
    ["failed", "_failed"],
  ])("maps the %s Todo to the %s plan entry", (todoStatus, status) => {
    const [update] = updatesOf(
      translate([planSnapshot([{ ...todo, status: todoStatus }])]).outbound
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
    const [update] = updatesOf(translate([planSnapshot([todo])]).outbound)

    expect(AosPlanMetaSchema.parse(aosMeta(update!))).toEqual({
      sequence: 7,
      runId: "run-1",
      todos: [todo],
    })
  })

  it("treats the single replace of /todos as the whole list", () => {
    const [update] = updatesOf(
      translate([planDelta([{ op: "replace", path: "/todos", value: [todo] }])])
        .outbound
    )

    expect(AosPlanMetaSchema.parse(aosMeta(update!)).todos).toEqual([todo])
  })

  it.each([
    [
      "a patch of more than one operation",
      [
        { op: "replace", path: "/todos", value: [todo] },
        { op: "replace", path: "/todos", value: [] },
      ],
    ],
    ["another path", [{ op: "replace", path: "/other", value: [todo] }]],
    ["another operation", [{ op: "add", path: "/todos", value: [todo] }]],
    ["an unparseable list", [{ op: "replace", path: "/todos", value: [{}] }]],
  ])("drops %s", (_label, patch) => {
    expect(translate([planDelta(patch)]).outbound).toEqual([])
  })

  it("drops a snapshot whose Todos do not parse", () => {
    expect(translate([planSnapshot([{ id: "t1" }])]).outbound).toEqual([])
  })
})

describe("translateRunEvent extensions", () => {
  const artifact = {
    id: "a1",
    filename: "chart.png",
    mimeType: "image/png",
    source: { type: "provider", reference: "a1" },
  }

  it("links a validated artifact into the streaming message", () => {
    const { outbound } = translate([
      {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      },
      { type: RunEventKind.CUSTOM, name: "aos.artifact", value: artifact },
    ])

    expect(updatesOf(outbound)).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: {
          type: "resource_link",
          uri: "artifact://a1",
          name: "chart.png",
          mimeType: "image/png",
        },
        _meta: { [AOS_META_KEY]: { sequence: 7, runId: "run-1" } },
      },
    ])
  })

  it("links an artifact whose publisher knew a size but no media type", () => {
    const published = {
      id: "a2",
      filename: "report.md",
      sizeBytes: 4_096,
      source: { type: "provider", reference: "a2" },
    }

    const [link] = updatesOf(
      translate([
        { type: RunEventKind.CUSTOM, name: "aos.artifact", value: published },
      ]).outbound
    )

    // With nothing streamed yet, the link opens the run's segment itself.
    expect(link).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      messageId: "run-1",
      content: {
        type: "resource_link",
        uri: "artifact://a2",
        name: "report.md",
        size: 4_096,
      },
    })
  })

  it.each([
    ["an artifact missing its source", { id: "a1", filename: "chart.png" }],
    ["a negative artifact size", { ...artifact, sizeBytes: -1 }],
    ["an unknown artifact source", { ...artifact, source: { type: "magic" } }],
  ])("drops %s", (_label, value) => {
    expect(
      translate([{ type: RunEventKind.CUSTOM, name: "aos.artifact", value }])
        .outbound
    ).toEqual([])
  })

  it("forwards an accepted steer", () => {
    const value = {
      requestId: "s1",
      text: "also check the logs",
      delivery: "queued",
    }

    expect(
      translate([
        { type: RunEventKind.CUSTOM, name: "aos.steer.accepted", value },
      ]).outbound
    ).toEqual([{ kind: "steer-accepted", runId: "run-1", ...value }])
  })

  it("drops the acceptances the replayed history already carried", () => {
    const accepted = (requestId: string, text: string): RunEvent => ({
      type: RunEventKind.CUSTOM,
      name: "aos.steer.accepted",
      value: { requestId, text, delivery: "steered" },
    })

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
        runId: "run-1",
        requestId: "s3",
        text: "third",
        delivery: "steered",
      },
    ])
  })

  it("drops a steer acceptance with an unknown delivery", () => {
    expect(
      translate([
        {
          type: RunEventKind.CUSTOM,
          name: "aos.steer.accepted",
          value: { requestId: "s1", text: "hi", delivery: "maybe" },
        },
      ]).outbound
    ).toEqual([])
  })
})
