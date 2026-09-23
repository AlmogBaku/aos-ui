import { describe, expect, it } from "vitest"

import {
  aggregateTokenUsage,
  CompactionStatus,
  DiffOperation,
  isAwaitingStopFailure,
  isRedialableFailure,
  isRepliesTurn,
  isTurnEvent,
  isUncertainFailure,
  pendingRequestsOf,
  PendingRequestKind,
  PendingRequestSchema,
  ReplyStatus,
  RequestReplySchema,
  StopReason,
  SubagentStatus,
  sumTokenCounts,
  ToolKind,
  TurnEventKind,
  TurnEventSchema,
  TurnInputSchema,
  type TurnEvent,
} from "./events"

/**
 * The proxy owns its turn vocabulary, so this file is where that vocabulary is
 * pinned: one fixture per kind carrying every field it may carry, and an
 * explicit table of the fields each kind cannot do without. A table entry
 * changes only when the vocabulary deliberately changes, so drift shows up here
 * rather than as a rejected adapter event in production.
 */

const pendingRequest = {
  requestId: "request-1",
  kind: PendingRequestKind.Permission,
  message: "Apply the patch?",
  toolCallId: "call-1",
  responseSchema: { type: "string", enum: ["once", "deny"] },
  expiresAt: "2026-01-01T00:00:00Z",
}

const requestReply = {
  requestId: "request-1",
  status: ReplyStatus.Resolved,
  payload: { answer: "yes" },
}

const promptTurn = {
  turnId: "turn-1",
  messageId: "message-1",
  prompt: "Hello",
  rewindSourceId: "message-0",
}

const repliesTurn = { turnId: "turn-2", replies: [requestReply] }

const tokenUsage = {
  provider: "anthropic",
  model: "claude",
  inputTokens: 11,
  outputTokens: 22,
  totalTokens: 33,
  reasoningTokens: 44,
  cachedInputTokens: 55,
  cachedWriteTokens: 66,
}

const subagent = {
  id: "subagent-1",
  goal: "audit the tests",
  model: "claude",
  depth: 1,
  status: SubagentStatus.Completed,
  tokens: 1200,
  filesRead: ["/repo/a.ts"],
  filesWritten: ["/repo/b.ts"],
  durationMs: 4200,
  childSessionId: "session-2",
  summary: "two tests were missing",
}

const location = { path: "/repo/README.md", line: 3 }

const eventFixtures: Record<TurnEventKind, Record<string, unknown>> = {
  [TurnEventKind.TurnStarted]: { kind: TurnEventKind.TurnStarted },
  [TurnEventKind.TurnEnded]: {
    kind: TurnEventKind.TurnEnded,
    stopReason: StopReason.MaxTokens,
    usage: [tokenUsage],
    cost: { amount: 0.25, currency: "USD" },
    composerPrefill: "/retry",
  },
  [TurnEventKind.TurnRequiresAction]: {
    kind: TurnEventKind.TurnRequiresAction,
    requests: [pendingRequest],
  },
  [TurnEventKind.TurnFailed]: {
    kind: TurnEventKind.TurnFailed,
    code: "AOS_SEND_UNCERTAIN",
    message: "the provider refused",
    awaitingStop: true,
    provider: "anthropic",
    model: "claude",
  },
  [TurnEventKind.MessageChunk]: {
    kind: TurnEventKind.MessageChunk,
    messageId: "message-1",
    text: "hello",
    subagentId: "subagent-1",
  },
  [TurnEventKind.ThoughtChunk]: {
    kind: TurnEventKind.ThoughtChunk,
    messageId: "message-1",
    text: "thinking",
    subagentId: "subagent-1",
  },
  [TurnEventKind.ToolCallStarted]: {
    kind: TurnEventKind.ToolCallStarted,
    toolCallId: "call-1",
    title: "read",
    name: "read_file",
    toolKind: ToolKind.Read,
    locations: [location],
    startedAt: "2026-01-01T00:00:00.000Z",
    parentMessageId: "message-1",
    subagent,
    subagentId: "subagent-0",
  },
  [TurnEventKind.ToolCallInputChunk]: {
    kind: TurnEventKind.ToolCallInputChunk,
    toolCallId: "call-1",
    delta: '{"path":"README.md"}',
  },
  [TurnEventKind.ToolCallInputEnded]: {
    kind: TurnEventKind.ToolCallInputEnded,
    toolCallId: "call-1",
  },
  [TurnEventKind.ToolCallFinished]: {
    kind: TurnEventKind.ToolCallFinished,
    toolCallId: "call-1",
    output: "file contents",
    failed: false,
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
        patch: "diff --git a/a.ts b/a.ts\n",
      },
    ],
    locations: [location],
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
  },
  [TurnEventKind.ToolCallOutputChunk]: {
    kind: TurnEventKind.ToolCallOutputChunk,
    toolCallId: "call-1",
    text: "partial output",
  },
  [TurnEventKind.TerminalOutput]: {
    kind: TurnEventKind.TerminalOutput,
    terminalId: "terminal-1",
    toolCallId: "call-1",
    command: "ls",
    cwd: "/repo",
    data: "README.md\n",
    exit: { exitCode: 0, signal: "SIGTERM" },
  },
  [TurnEventKind.CompactionUpdated]: {
    kind: TurnEventKind.CompactionUpdated,
    compactionId: "compaction-1",
    status: CompactionStatus.Failed,
    summary: "the story so far",
    error: "the summarizer timed out",
  },
  [TurnEventKind.ModelChanged]: {
    kind: TurnEventKind.ModelChanged,
    modelId: "claude",
  },
  [TurnEventKind.SubagentUpdated]: {
    kind: TurnEventKind.SubagentUpdated,
    toolCallId: "call-1",
    subagent,
  },
  [TurnEventKind.PlanUpdated]: {
    kind: TurnEventKind.PlanUpdated,
    todos: [{ id: "todo-1", label: "ship", status: "pending" }],
  },
  [TurnEventKind.ArtifactPublished]: {
    kind: TurnEventKind.ArtifactPublished,
    artifact: {
      id: "artifact-1",
      filename: "report.md",
      mimeType: "text/markdown",
      sizeBytes: 12,
      source: { type: "provider", reference: "artifact-1" },
    },
  },
  [TurnEventKind.SteerAccepted]: {
    kind: TurnEventKind.SteerAccepted,
    requestId: "steer-1",
    text: "also check the tests",
    delivery: "steered",
  },
}

/** The fields each kind must carry beyond the `kind` discriminator. */
const requiredFields: Record<TurnEventKind, readonly string[]> = {
  [TurnEventKind.TurnStarted]: [],
  [TurnEventKind.TurnEnded]: [],
  [TurnEventKind.TurnRequiresAction]: ["requests"],
  [TurnEventKind.TurnFailed]: ["message"],
  [TurnEventKind.MessageChunk]: ["messageId", "text"],
  [TurnEventKind.ThoughtChunk]: ["messageId", "text"],
  [TurnEventKind.ToolCallStarted]: ["toolCallId", "title"],
  [TurnEventKind.ToolCallInputChunk]: ["toolCallId", "delta"],
  [TurnEventKind.ToolCallInputEnded]: ["toolCallId"],
  [TurnEventKind.ToolCallFinished]: ["toolCallId", "output", "failed"],
  [TurnEventKind.ToolCallOutputChunk]: ["toolCallId", "text"],
  [TurnEventKind.TerminalOutput]: ["terminalId", "toolCallId"],
  [TurnEventKind.CompactionUpdated]: ["compactionId", "status"],
  [TurnEventKind.ModelChanged]: ["modelId"],
  [TurnEventKind.SubagentUpdated]: ["toolCallId", "subagent"],
  [TurnEventKind.PlanUpdated]: ["todos"],
  [TurnEventKind.ArtifactPublished]: ["artifact"],
  [TurnEventKind.SteerAccepted]: ["requestId", "text", "delivery"],
}

const fixtures = Object.entries(eventFixtures)

function without(fixture: Record<string, unknown>, key: string) {
  return Object.fromEntries(
    Object.entries(fixture).filter(([name]) => name !== key)
  )
}

describe("the proxy-owned turn vocabulary", () => {
  it("covers every kind the proxy carries", () => {
    expect(Object.keys(eventFixtures).sort()).toEqual(
      Object.values(TurnEventKind).sort()
    )
    expect(Object.keys(requiredFields).sort()).toEqual(
      Object.values(TurnEventKind).sort()
    )
  })

  it.each(fixtures)("parses a full %s unchanged", (_kind, fixture) => {
    expect(TurnEventSchema.parse(fixture)).toEqual(fixture)
    expect(isTurnEvent(fixture)).toBe(true)
  })

  it.each(fixtures)("rejects an unknown field on %s", (_kind, fixture) => {
    expect(isTurnEvent({ ...fixture, rawEvent: { provider: "native" } })).toBe(
      false
    )
  })

  it.each(fixtures)("requires the %s discriminator", (_kind, fixture) => {
    expect(isTurnEvent(without(fixture, "kind"))).toBe(false)
  })

  it.each(fixtures)(
    "rejects a %s missing a required field and accepts every other omission",
    (kind, fixture) => {
      const required = requiredFields[kind as TurnEventKind]
      expect(
        required.filter((field) => field in fixture),
        `${kind} fixture covers its required fields`
      ).toEqual(required)

      for (const key of Object.keys(fixture)) {
        if (key === "kind") continue
        expect(
          isTurnEvent(without(fixture, key)),
          `${kind} without ${key}`
        ).toBe(!required.includes(key))
      }
    }
  )

  it("rejects a kind outside the proxy vocabulary", () => {
    expect(isTurnEvent({ kind: "STEP_STARTED", stepName: "one" })).toBe(false)
  })

  it("pauses a turn only on at least one request", () => {
    expect(
      isTurnEvent({ kind: TurnEventKind.TurnRequiresAction, requests: [] })
    ).toBe(false)
  })

  it("marks a turn awaiting Stop only with true", () => {
    expect(
      isTurnEvent({
        kind: TurnEventKind.TurnFailed,
        message: "failed",
        awaitingStop: false,
      })
    ).toBe(false)
  })

  it("rejects a token count beyond the safe integer range", () => {
    // No provider can report such a count, and a value that large cannot
    // survive a round trip through JSON anyway.
    expect(
      isTurnEvent({
        kind: TurnEventKind.TurnEnded,
        usage: [{ inputTokens: 1e100 }],
      })
    ).toBe(false)
  })
})

describe("the provider facts a turn event carries", () => {
  function toolFinished(fields: Record<string, unknown>) {
    return {
      kind: TurnEventKind.ToolCallFinished,
      toolCallId: "call-1",
      output: "",
      failed: false,
      ...fields,
    }
  }

  it("admits only the stop reasons the vocabulary names", () => {
    for (const stopReason of Object.values(StopReason))
      expect(isTurnEvent({ kind: TurnEventKind.TurnEnded, stopReason })).toBe(
        true
      )
    expect(
      isTurnEvent({ kind: TurnEventKind.TurnEnded, stopReason: "end_turn" })
    ).toBe(false)
  })

  it("names where a move or copy came from and nothing else does", () => {
    const moved = { operation: DiffOperation.Move, path: "/repo/b.ts" }
    expect(isTurnEvent(toolFinished({ diffs: [{ changes: [moved] }] }))).toBe(
      false
    )
    expect(
      isTurnEvent(
        toolFinished({
          diffs: [
            {
              changes: [
                {
                  operation: DiffOperation.Add,
                  oldPath: "/repo/a.ts",
                  path: "/repo/b.ts",
                },
              ],
            },
          ],
        })
      )
    ).toBe(false)
  })

  it("carries a diff only when it changed at least one file", () => {
    expect(isTurnEvent(toolFinished({ diffs: [{ changes: [] }] }))).toBe(false)
  })

  it("takes timestamps only as UTC ISO 8601", () => {
    expect(isTurnEvent(toolFinished({ completedAt: "yesterday" }))).toBe(false)
    expect(
      isTurnEvent(toolFinished({ completedAt: "2026-01-01T02:00:00+02:00" }))
    ).toBe(false)
  })

  it("admits only the subagent statuses the vocabulary names", () => {
    expect(
      isTurnEvent({
        kind: TurnEventKind.SubagentUpdated,
        toolCallId: "call-1",
        subagent: { id: "subagent-1", status: "timeout" },
      })
    ).toBe(false)
  })
})

describe("a pending request", () => {
  it("parses every field a request may carry", () => {
    expect(PendingRequestSchema.parse(pendingRequest)).toEqual(pendingRequest)
  })

  it("requires only the identifier and the kind", () => {
    const required = ["requestId", "kind"]

    for (const key of Object.keys(pendingRequest))
      expect(
        PendingRequestSchema.safeParse(without(pendingRequest, key)).success,
        `without ${key}`
      ).toBe(!required.includes(key))
  })

  it("admits a permission or an elicitation and nothing else", () => {
    for (const kind of Object.values(PendingRequestKind))
      expect(
        PendingRequestSchema.safeParse({ requestId: "request-1", kind })
          .success,
        kind
      ).toBe(true)
    expect(
      PendingRequestSchema.safeParse({
        requestId: "request-1",
        kind: "question",
      }).success
    ).toBe(false)
  })

  it("rejects provider metadata", () => {
    expect(
      PendingRequestSchema.safeParse({
        ...pendingRequest,
        metadata: { origin: "provider" },
      }).success
    ).toBe(false)
  })
})

describe("a request reply", () => {
  it("parses every field the operator's answer may carry", () => {
    expect(RequestReplySchema.parse(requestReply)).toEqual(requestReply)
  })

  it("requires only the request it answers and its status", () => {
    const required = ["requestId", "status"]

    for (const key of Object.keys(requestReply))
      expect(
        RequestReplySchema.safeParse(without(requestReply, key)).success,
        `without ${key}`
      ).toBe(!required.includes(key))
  })

  it("admits a resolved or cancelled reply and nothing else", () => {
    for (const status of Object.values(ReplyStatus))
      expect(
        RequestReplySchema.safeParse({ requestId: "request-1", status })
          .success,
        status
      ).toBe(true)
    expect(
      RequestReplySchema.safeParse({
        requestId: "request-1",
        status: "pending",
      }).success
    ).toBe(false)
  })
})

describe("a turn input", () => {
  it("parses a prompt turn and a replies turn unchanged", () => {
    expect(TurnInputSchema.parse(promptTurn)).toEqual(promptTurn)
    expect(TurnInputSchema.parse(repliesTurn)).toEqual(repliesTurn)
  })

  it("requires the turn, the message, and the prompt of a prompt turn", () => {
    const required = ["turnId", "messageId", "prompt"]

    for (const key of Object.keys(promptTurn))
      expect(
        TurnInputSchema.safeParse(without(promptTurn, key)).success,
        `without ${key}`
      ).toBe(!required.includes(key))
  })

  it("resumes only on at least one reply", () => {
    expect(
      TurnInputSchema.safeParse({ turnId: "turn-2", replies: [] }).success
    ).toBe(false)
  })

  it("admits a prompt turn or a replies turn, never a mix", () => {
    expect(
      TurnInputSchema.safeParse({ ...promptTurn, replies: [requestReply] })
        .success
    ).toBe(false)
    expect(
      TurnInputSchema.safeParse({ ...promptTurn, callerOnlyField: "x" }).success
    ).toBe(false)
  })

  it("tells a replies turn from a prompt turn", () => {
    expect(isRepliesTurn(repliesTurn)).toBe(true)
    expect(isRepliesTurn(promptTurn)).toBe(false)
  })
})

describe("turn event helpers", () => {
  const failed = (code?: string, awaitingStop?: true): TurnEvent => ({
    kind: TurnEventKind.TurnFailed,
    message: "failed",
    ...(code === undefined ? {} : { code }),
    ...(awaitingStop ? { awaitingStop } : {}),
  })

  it("names the failures after which nothing may be retried", () => {
    expect(isUncertainFailure(failed("AOS_SEND_UNCERTAIN"))).toBe(true)
    expect(isUncertainFailure(failed("AOS_RESET_REQUIRED"))).toBe(true)
    expect(isUncertainFailure(failed("AOS_PROVIDER_RUN_FAILED"))).toBe(false)
    expect(isUncertainFailure(failed())).toBe(false)
    expect(isUncertainFailure({ kind: TurnEventKind.TurnEnded })).toBe(false)
  })

  it("redials every uncertain failure except a reset", () => {
    expect(isRedialableFailure(failed("AOS_CONNECTION_INTERRUPTED"))).toBe(true)
    expect(isRedialableFailure(failed("AOS_RESET_REQUIRED"))).toBe(false)
    expect(isRedialableFailure(failed())).toBe(false)
  })

  it("recognizes a failure that awaits Stop", () => {
    expect(isAwaitingStopFailure(failed(undefined, true))).toBe(true)
    expect(isAwaitingStopFailure(failed())).toBe(false)
  })

  it("reads the requests only a paused turn leaves waiting", () => {
    expect(
      pendingRequestsOf({
        kind: TurnEventKind.TurnRequiresAction,
        requests: [pendingRequest],
      })
    ).toEqual([pendingRequest])
    expect(pendingRequestsOf({ kind: TurnEventKind.TurnEnded })).toEqual([])
  })
})

describe("sumTokenCounts", () => {
  it("sums every entry and keeps a count nobody reported absent", () => {
    expect(
      sumTokenCounts([
        { provider: "a", inputTokens: 1, outputTokens: 2 },
        { provider: "b", inputTokens: 3, cachedWriteTokens: 4 },
      ])
    ).toEqual({ inputTokens: 4, outputTokens: 2, cachedWriteTokens: 4 })
  })
})

describe("aggregateTokenUsage", () => {
  it("sums counts per provider and model and keeps omitted counts absent", () => {
    expect(
      aggregateTokenUsage([
        { provider: "a", model: "m", inputTokens: 1, outputTokens: 2 },
        { provider: "a", model: "m", inputTokens: 3 },
        { provider: "b", totalTokens: 5 },
      ])
    ).toEqual([
      { provider: "a", model: "m", inputTokens: 4, outputTokens: 2 },
      { provider: "b", totalTokens: 5 },
    ])
  })
})
