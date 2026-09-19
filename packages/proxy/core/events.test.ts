import {
  EventSchemas,
  InterruptSchema,
  ResumeEntrySchema,
  RunAgentInputSchema,
} from "@ag-ui/core"
import { describe, expect, it } from "vitest"

import {
  PendingRequestSchema,
  RequestReplySchema,
  RunEventKind,
  RunEventSchema,
  TurnInputSchema,
} from "./events"

/**
 * The proxy owns its run vocabulary, but the bytes on the wire are AG-UI
 * 0.0.59's. This file is the only place in `core/` allowed to import
 * `@ag-ui/core`: it pins every shape against the declarations the adapters
 * emitted before the vocabulary moved, so a drift shows up here rather than as
 * a rejected provider event in production.
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
  metadata: { "ag-ui": { source: "native" } },
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

const fixtures = Object.entries(eventFixtures)

function without(fixture: Record<string, unknown>, key: string) {
  return Object.fromEntries(
    Object.entries(fixture).filter(([name]) => name !== key)
  )
}

describe("run event parity with the AG-UI wire", () => {
  it("covers every kind the proxy carries", () => {
    expect(Object.keys(eventFixtures).sort()).toEqual(
      Object.values(RunEventKind).sort()
    )
  })

  it.each(fixtures)("parses %s as AG-UI parses it", (_kind, fixture) => {
    const own = RunEventSchema.safeParse(fixture)
    const agui = EventSchemas.safeParse(fixture)

    expect(own.success).toBe(true)
    expect(agui.success).toBe(true)
    expect(own.data).toEqual(agui.data)
    expect(Object.keys(own.data ?? {}).sort()).toEqual(
      Object.keys(agui.data ?? {}).sort()
    )
  })

  it.each(fixtures)(
    "keeps an unknown top-level field on %s, as AG-UI does",
    (_kind, fixture) => {
      const candidate = { ...fixture, providerOnlyField: "kept" }
      const own = RunEventSchema.safeParse(candidate)
      const agui = EventSchemas.safeParse(candidate)

      expect(own.success).toBe(true)
      expect(agui.success).toBe(true)
      expect(own.data).toEqual(agui.data)
      expect(own.data).toMatchObject({ providerOnlyField: "kept" })
    }
  )

  it("agrees with AG-UI on which field of which kind may be omitted", () => {
    for (const [kind, fixture] of fixtures)
      for (const key of Object.keys(fixture)) {
        const candidate = without(fixture, key)
        const own = RunEventSchema.safeParse(candidate)
        const agui = EventSchemas.safeParse(candidate)
        expect(own.success, `${kind} without ${key}`).toBe(agui.success)
        if (own.success && agui.success)
          expect(own.data, `${kind} without ${key}`).toEqual(agui.data)
      }
  })

  it("normalizes the nulls released producers still send", () => {
    const toolCall = {
      type: RunEventKind.TOOL_CALL_START,
      toolCallId: "call-1",
      toolCallName: "read",
      parentMessageId: null,
    }
    const finished = {
      type: RunEventKind.RUN_FINISHED,
      threadId: "session-1",
      runId: "run-1",
      outcome: null,
    }

    for (const candidate of [toolCall, finished]) {
      const own = RunEventSchema.parse(candidate)
      const agui = EventSchemas.parse(candidate)
      expect(own).toEqual(agui)
      expect(Object.keys(own).sort()).toEqual(Object.keys(agui).sort())
    }
    expect(RunEventSchema.parse(toolCall).parentMessageId).toBeUndefined()
    expect(RunEventSchema.parse(finished).outcome).toBeUndefined()
  })

  it("rejects a kind outside the proxy vocabulary that AG-UI still accepts", () => {
    const stepStarted = { type: "STEP_STARTED", stepName: "one" }

    expect(RunEventSchema.safeParse(stepStarted).success).toBe(false)
    expect(EventSchemas.safeParse(stepStarted).success).toBe(true)
  })

  it("rejects a token count beyond the safe integer range", () => {
    const candidate = {
      type: RunEventKind.RUN_ERROR,
      message: "the provider refused",
      usage: [{ inputTokens: 1e100 }],
    }

    // The one known divergence: Zod 4's integer check also bounds the value at
    // Number.MAX_SAFE_INTEGER, where AG-UI's Zod 3 check only asks for an
    // integer. No provider can report such a count, and a value that large
    // cannot survive a round trip through JSON anyway.
    expect(RunEventSchema.safeParse(candidate).success).toBe(false)
    expect(EventSchemas.safeParse(candidate).success).toBe(true)
  })
})

describe("pending request parity with the AG-UI wire", () => {
  it("parses a pending request as AG-UI parses an interrupt", () => {
    expect(PendingRequestSchema.parse(pendingRequest)).toEqual(
      InterruptSchema.parse(pendingRequest)
    )
  })

  it("agrees on which pending request fields may be omitted", () => {
    for (const key of Object.keys(pendingRequest)) {
      const candidate = without(pendingRequest, key)
      const own = PendingRequestSchema.safeParse(candidate)
      const agui = InterruptSchema.safeParse(candidate)
      expect(own.success, `without ${key}`).toBe(agui.success)
      if (own.success && agui.success)
        expect(own.data, `without ${key}`).toEqual(agui.data)
    }
  })
})

describe("request reply parity with the AG-UI wire", () => {
  it("parses a reply as AG-UI parses a resume entry", () => {
    expect(RequestReplySchema.parse(requestReply)).toEqual(
      ResumeEntrySchema.parse(requestReply)
    )
  })

  it("agrees on which reply fields may be omitted", () => {
    for (const key of Object.keys(requestReply)) {
      const candidate = without(requestReply, key)
      const own = RequestReplySchema.safeParse(candidate)
      const agui = ResumeEntrySchema.safeParse(candidate)
      expect(own.success, `without ${key}`).toBe(agui.success)
      if (own.success && agui.success)
        expect(own.data, `without ${key}`).toEqual(agui.data)
    }
  })

  it("admits only the two statuses AG-UI admits", () => {
    for (const status of ["resolved", "cancelled", "pending"]) {
      const candidate = { interruptId: "interrupt-1", status }
      expect(RequestReplySchema.safeParse(candidate).success, status).toBe(
        ResumeEntrySchema.safeParse(candidate).success
      )
    }
  })
})

describe("turn input parity with the AG-UI wire", () => {
  it("parses an admitted turn as AG-UI parses a run input", () => {
    expect(TurnInputSchema.parse(turnInput)).toEqual(
      RunAgentInputSchema.parse(turnInput)
    )
  })

  it("agrees on which turn input fields may be omitted", () => {
    for (const key of Object.keys(turnInput)) {
      const candidate = without(turnInput, key)
      const own = TurnInputSchema.safeParse(candidate)
      const agui = RunAgentInputSchema.safeParse(candidate)
      expect(own.success, `without ${key}`).toBe(agui.success)
      if (own.success && agui.success)
        expect(own.data, `without ${key}`).toEqual(agui.data)
    }
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

    expect(TurnInputSchema.parse(candidate)).toEqual(
      RunAgentInputSchema.parse(candidate)
    )
  })

  it("drops an unknown top-level field, as AG-UI does", () => {
    const candidate = { ...turnInput, callerOnlyField: "dropped" }

    expect(TurnInputSchema.parse(candidate)).toEqual(
      RunAgentInputSchema.parse(candidate)
    )
    expect("callerOnlyField" in TurnInputSchema.parse(candidate)).toBe(false)
  })

  it("admits only the user turn the proxy builds", () => {
    const candidate = {
      ...turnInput,
      messages: [{ id: "message-1", role: "assistant", content: "Hello" }],
    }

    // Narrower than AG-UI on purpose: the proxy never builds or forwards any
    // other message, so a provider-shaped history cannot reach a runtime here.
    expect(TurnInputSchema.safeParse(candidate).success).toBe(false)
    expect(RunAgentInputSchema.safeParse(candidate).success).toBe(true)
  })
})
