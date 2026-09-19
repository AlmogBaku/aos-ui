import { describe, expect, it } from "vitest"

import {
  PendingRequestSchema,
  RequestReplySchema,
  RunEventKind,
  RunEventSchema,
  TurnInputSchema,
} from "./events"

/**
 * The proxy owns its run vocabulary, so this file is where that vocabulary is
 * pinned: one fixture per kind in the wire shape the adapters emit, and an
 * explicit table of the fields each kind cannot do without. Nothing here is
 * derived from another library at runtime — a table entry changes only when the
 * wire shape deliberately changes, so drift shows up here rather than as a
 * rejected provider event in production.
 */

const pendingRequest = {
  id: "interrupt-1",
  reason: "approval",
  message: "Apply the patch?",
  toolCallId: "call-1",
  responseSchema: { type: "object" },
  expiresAt: "2026-01-01T00:00:00Z",
  metadata: { origin: "provider" },
  subagentRunId: "subagent-1",
}

const requestReply = {
  interruptId: "interrupt-1",
  status: "resolved",
  payload: { answer: "yes" },
  metadata: { via: "acp" },
}

const turnInput = {
  threadId: "session-1",
  runId: "run-1",
  parentRunId: "run-0",
  state: {},
  messages: [{ id: "message-1", role: "user", content: "Hello" }],
  tools: [
    {
      name: "read",
      description: "Read a file",
      parameters: { type: "object" },
      metadata: { source: "native" },
    },
  ],
  context: [{ description: "cwd", value: "/workspace" }],
  forwardedProps: {},
  resume: [requestReply],
}

const tokenUsage = {
  provider: "anthropic",
  model: "claude",
  inputTokens: 11,
  outputTokens: 22,
  totalTokens: 33,
  reasoningTokens: 44,
  cachedInputTokens: 55,
}

/** Fields every kind carries, spelled out so dropping one is a real test. */
const base = {
  timestamp: 1_767_225_600_000,
  rawEvent: { provider: "native" },
  metadata: { native: { source: "provider" } },
}
const attributed = { ...base, subagentRunId: "subagent-1" }

const eventFixtures: Record<RunEventKind, Record<string, unknown>> = {
  [RunEventKind.RUN_STARTED]: {
    ...base,
    type: RunEventKind.RUN_STARTED,
    threadId: "session-1",
    runId: "run-1",
    parentRunId: "run-0",
    input: turnInput,
  },
  [RunEventKind.RUN_FINISHED]: {
    ...base,
    type: RunEventKind.RUN_FINISHED,
    threadId: "session-1",
    runId: "run-1",
    result: { ok: true },
    outcome: { type: "interrupt", interrupts: [pendingRequest] },
    usage: [tokenUsage],
  },
  [RunEventKind.RUN_ERROR]: {
    ...base,
    type: RunEventKind.RUN_ERROR,
    message: "the provider refused",
    code: "AOS_SEND_UNCERTAIN",
    usage: [tokenUsage],
  },
  [RunEventKind.TEXT_MESSAGE_START]: {
    ...attributed,
    type: RunEventKind.TEXT_MESSAGE_START,
    messageId: "message-1",
    role: "assistant",
    name: "Claude",
  },
  [RunEventKind.TEXT_MESSAGE_CONTENT]: {
    ...attributed,
    type: RunEventKind.TEXT_MESSAGE_CONTENT,
    messageId: "message-1",
    delta: "hello",
  },
  [RunEventKind.TEXT_MESSAGE_END]: {
    ...attributed,
    type: RunEventKind.TEXT_MESSAGE_END,
    messageId: "message-1",
  },
  [RunEventKind.REASONING_START]: {
    ...attributed,
    type: RunEventKind.REASONING_START,
    messageId: "message-1",
  },
  [RunEventKind.REASONING_END]: {
    ...attributed,
    type: RunEventKind.REASONING_END,
    messageId: "message-1",
  },
  [RunEventKind.REASONING_MESSAGE_START]: {
    ...attributed,
    type: RunEventKind.REASONING_MESSAGE_START,
    messageId: "message-1:reasoning",
    role: "reasoning",
  },
  [RunEventKind.REASONING_MESSAGE_CONTENT]: {
    ...attributed,
    type: RunEventKind.REASONING_MESSAGE_CONTENT,
    messageId: "message-1:reasoning",
    delta: "thinking",
  },
  [RunEventKind.REASONING_MESSAGE_END]: {
    ...attributed,
    type: RunEventKind.REASONING_MESSAGE_END,
    messageId: "message-1:reasoning",
  },
  [RunEventKind.TOOL_CALL_START]: {
    ...attributed,
    type: RunEventKind.TOOL_CALL_START,
    toolCallId: "call-1",
    toolCallName: "read",
    parentMessageId: "message-1",
  },
  [RunEventKind.TOOL_CALL_ARGS]: {
    ...attributed,
    type: RunEventKind.TOOL_CALL_ARGS,
    toolCallId: "call-1",
    delta: '{"path":"README.md"}',
  },
  [RunEventKind.TOOL_CALL_END]: {
    ...attributed,
    type: RunEventKind.TOOL_CALL_END,
    toolCallId: "call-1",
  },
  [RunEventKind.TOOL_CALL_RESULT]: {
    ...attributed,
    type: RunEventKind.TOOL_CALL_RESULT,
    messageId: "message-2",
    toolCallId: "call-1",
    content: "file contents",
    role: "tool",
  },
  [RunEventKind.ACTIVITY_SNAPSHOT]: {
    ...attributed,
    type: RunEventKind.ACTIVITY_SNAPSHOT,
    messageId: "activity-1",
    activityType: "PLAN",
    content: { todos: [{ content: "ship", status: "pending" }] },
    replace: true,
  },
  [RunEventKind.ACTIVITY_DELTA]: {
    ...attributed,
    type: RunEventKind.ACTIVITY_DELTA,
    messageId: "activity-1",
    activityType: "PLAN",
    patch: [{ op: "add", path: "/todos/0", value: { content: "ship" } }],
  },
  [RunEventKind.CUSTOM]: {
    ...attributed,
    type: RunEventKind.CUSTOM,
    name: "aos.artifact",
    value: { kind: "chart" },
  },
}

/**
 * The fields each kind must carry beyond the `type` discriminator, which every
 * kind requires. This table is the wire shape the adapters emit: every other
 * field in a fixture above is optional or defaulted, and a kind gaining or
 * losing a required field is a deliberate protocol change that belongs here
 * before it belongs in an adapter.
 */
const requiredFields: Record<RunEventKind, readonly string[]> = {
  [RunEventKind.RUN_STARTED]: ["threadId", "runId"],
  [RunEventKind.RUN_FINISHED]: ["threadId", "runId"],
  [RunEventKind.RUN_ERROR]: ["message"],
  [RunEventKind.TEXT_MESSAGE_START]: ["messageId"],
  [RunEventKind.TEXT_MESSAGE_CONTENT]: ["messageId", "delta"],
  [RunEventKind.TEXT_MESSAGE_END]: ["messageId"],
  [RunEventKind.REASONING_START]: ["messageId"],
  [RunEventKind.REASONING_END]: ["messageId"],
  [RunEventKind.REASONING_MESSAGE_START]: ["messageId", "role"],
  [RunEventKind.REASONING_MESSAGE_CONTENT]: ["messageId", "delta"],
  [RunEventKind.REASONING_MESSAGE_END]: ["messageId"],
  [RunEventKind.TOOL_CALL_START]: ["toolCallId", "toolCallName"],
  [RunEventKind.TOOL_CALL_ARGS]: ["toolCallId", "delta"],
  [RunEventKind.TOOL_CALL_END]: ["toolCallId"],
  [RunEventKind.TOOL_CALL_RESULT]: ["messageId", "toolCallId", "content"],
  [RunEventKind.ACTIVITY_SNAPSHOT]: ["messageId", "activityType", "content"],
  [RunEventKind.ACTIVITY_DELTA]: ["messageId", "activityType", "patch"],
  [RunEventKind.CUSTOM]: ["name"],
}

const fixtures = Object.entries(eventFixtures)

function without(fixture: Record<string, unknown>, key: string) {
  return Object.fromEntries(
    Object.entries(fixture).filter(([name]) => name !== key)
  )
}

describe("the proxy-owned run vocabulary", () => {
  it("covers every kind the proxy carries", () => {
    expect(Object.keys(eventFixtures).sort()).toEqual(
      Object.values(RunEventKind).sort()
    )
    expect(Object.keys(requiredFields).sort()).toEqual(
      Object.values(RunEventKind).sort()
    )
  })

  it.each(fixtures)("parses the %s wire shape unchanged", (_kind, fixture) => {
    expect(RunEventSchema.parse(fixture)).toEqual(fixture)
  })

  it.each(fixtures)(
    "keeps an unknown top-level field on %s",
    (_kind, fixture) => {
      const candidate = { ...fixture, providerOnlyField: "kept" }

      expect(RunEventSchema.parse(candidate)).toEqual(candidate)
    }
  )

  it.each(fixtures)("requires the %s discriminator", (_kind, fixture) => {
    expect(RunEventSchema.safeParse(without(fixture, "type")).success).toBe(
      false
    )
  })

  it.each(fixtures)(
    "rejects a %s missing a required field and accepts every other omission",
    (kind, fixture) => {
      const required = requiredFields[kind as RunEventKind]
      expect(
        required.filter((field) => field in fixture),
        `${kind} fixture covers its required fields`
      ).toEqual(required)

      for (const key of Object.keys(fixture)) {
        if (key === "type") continue
        expect(
          RunEventSchema.safeParse(without(fixture, key)).success,
          `${kind} without ${key}`
        ).toBe(!required.includes(key))
      }
    }
  )

  it("normalizes the nulls released producers still send", () => {
    const toolCall = RunEventSchema.parse({
      type: RunEventKind.TOOL_CALL_START,
      toolCallId: "call-1",
      toolCallName: "read",
      parentMessageId: null,
    })
    const finished = RunEventSchema.parse({
      type: RunEventKind.RUN_FINISHED,
      threadId: "session-1",
      runId: "run-1",
      outcome: null,
    })

    expect(toolCall).toEqual({
      type: RunEventKind.TOOL_CALL_START,
      toolCallId: "call-1",
      toolCallName: "read",
    })
    expect(toolCall.parentMessageId).toBeUndefined()
    expect(finished).toEqual({
      type: RunEventKind.RUN_FINISHED,
      threadId: "session-1",
      runId: "run-1",
    })
    expect(finished.outcome).toBeUndefined()
  })

  it("applies the defaults the adapters rely on", () => {
    expect(
      RunEventSchema.parse({
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "message-1",
      })
    ).toMatchObject({ role: "assistant" })
    expect(
      RunEventSchema.parse({
        type: RunEventKind.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
        activityType: "PLAN",
        content: {},
      })
    ).toMatchObject({ replace: true })
  })

  it("rejects a kind outside the proxy vocabulary", () => {
    expect(
      RunEventSchema.safeParse({ type: "STEP_STARTED", stepName: "one" })
        .success
    ).toBe(false)
  })

  it("rejects a token count beyond the safe integer range", () => {
    // No provider can report such a count, and a value that large cannot
    // survive a round trip through JSON anyway.
    expect(
      RunEventSchema.safeParse({
        type: RunEventKind.RUN_ERROR,
        message: "the provider refused",
        usage: [{ inputTokens: 1e100 }],
      }).success
    ).toBe(false)
  })
})

describe("a pending request", () => {
  it("parses the wire shape a provider interrupt carries", () => {
    expect(PendingRequestSchema.parse(pendingRequest)).toEqual(pendingRequest)
  })

  it("requires only the identifier and the reason", () => {
    const required = ["id", "reason"]

    for (const key of Object.keys(pendingRequest))
      expect(
        PendingRequestSchema.safeParse(without(pendingRequest, key)).success,
        `without ${key}`
      ).toBe(!required.includes(key))
  })
})

describe("a request reply", () => {
  it("parses the wire shape the operator's answer carries", () => {
    expect(RequestReplySchema.parse(requestReply)).toEqual(requestReply)
  })

  it("requires only the interrupt it answers and its status", () => {
    const required = ["interruptId", "status"]

    for (const key of Object.keys(requestReply))
      expect(
        RequestReplySchema.safeParse(without(requestReply, key)).success,
        `without ${key}`
      ).toBe(!required.includes(key))
  })

  it("admits a resolved or cancelled reply and nothing else", () => {
    for (const status of ["resolved", "cancelled"])
      expect(
        RequestReplySchema.safeParse({ interruptId: "interrupt-1", status })
          .success,
        status
      ).toBe(true)
    expect(
      RequestReplySchema.safeParse({
        interruptId: "interrupt-1",
        status: "pending",
      }).success
    ).toBe(false)
  })
})

describe("an admitted turn", () => {
  it("parses the wire shape the proxy builds", () => {
    expect(TurnInputSchema.parse(turnInput)).toEqual(turnInput)
  })

  it("requires the Session, the run, and the three turn collections", () => {
    const required = ["threadId", "runId", "messages", "tools", "context"]

    for (const key of Object.keys(turnInput))
      expect(
        TurnInputSchema.safeParse(without(turnInput, key)).success,
        `without ${key}`
      ).toBe(!required.includes(key))
  })

  it("accepts the text parts a user turn may carry", () => {
    const candidate = {
      ...turnInput,
      messages: [
        {
          id: "message-1",
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      ],
    }

    expect(TurnInputSchema.parse(candidate)).toEqual(candidate)
  })

  it("rejects unstaged multimodal parts instead of dropping them", () => {
    // Staged media must reach an adapter as text, never as inline bytes.
    const candidate = {
      ...turnInput,
      messages: [
        {
          id: "message-1",
          role: "user",
          content: [
            { type: "text", text: "Look" },
            {
              type: "image",
              source: {
                type: "data",
                mimeType: "image/png",
                value: "aGVsbG8=",
              },
            },
          ],
        },
      ],
    }

    expect(TurnInputSchema.safeParse(candidate).success).toBe(false)
  })

  it("drops an unknown top-level field", () => {
    const parsed = TurnInputSchema.parse({
      ...turnInput,
      callerOnlyField: "dropped",
    })

    expect(parsed).toEqual(turnInput)
    expect("callerOnlyField" in parsed).toBe(false)
  })

  it("admits only the user turn the proxy builds", () => {
    // The proxy never builds or forwards any other message, so a
    // provider-shaped history cannot reach a runtime through this schema.
    expect(
      TurnInputSchema.safeParse({
        ...turnInput,
        messages: [{ id: "message-1", role: "assistant", content: "Hello" }],
      }).success
    ).toBe(false)
  })
})
