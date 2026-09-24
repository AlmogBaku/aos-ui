import { describe, expect, it } from "vitest"

import { guestErrorDescription } from "../../auth/guest-projection"
import {
  CompactionStatus,
  PendingRequestKind,
  StopReason,
  TurnEventKind,
  TurnEventSchema,
  type TurnEvent,
} from "../../core/events"
import { runEvents, type MemberEvent } from "../../core/member"
import { createTurnProjector, createTurnsMiddleware } from "./turns"

/** One guest member's projector. */
const projectorOf = () => createTurnProjector()

/** One turn event, validated the way the projector validates it. */
const project = (event: TurnEvent) =>
  projectorOf()(TurnEventSchema.parse(event))

describe("guest turn projection", () => {
  it("keeps the stop reason, the prefill, and the saved ids but drops usage and cost", () => {
    const saved = {
      user: { messageId: "user-1", savedId: "hermes-row-7" },
      replyId: "hermes-row-8",
    }
    expect(
      project({
        kind: TurnEventKind.TurnEnded,
        stopReason: StopReason.Refusal,
        usage: [{ provider: "private", totalTokens: 12 }],
        cost: { amount: 0.5, currency: "USD" },
        composerPrefill: "Try again with",
        saved,
      })
    ).toEqual({
      kind: TurnEventKind.TurnEnded,
      stopReason: StopReason.Refusal,
      composerPrefill: "Try again with",
      saved,
    })
    expect(
      project({
        kind: TurnEventKind.TurnStarted,
        startedAt: "2026-01-01T00:00:00.000Z",
      })
    ).toEqual({
      kind: TurnEventKind.TurnStarted,
      startedAt: "2026-01-01T00:00:00.000Z",
    })
  })

  it("passes assistant prose whole under its runtime id and drops reasoning and tool calls", () => {
    const text = "x".repeat(80_000)

    expect(
      project({
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text,
      })
    ).toEqual({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text,
    })
    expect(
      project({
        kind: TurnEventKind.ThoughtChunk,
        messageId: "assistant-1",
        text: "private reasoning",
      })
    ).toBeUndefined()
    expect(
      project({
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "tool-1",
        title: "terminal",
      })
    ).toBeUndefined()
  })

  it("drops a subagent's prose and every tool, terminal, compaction, and model fact", () => {
    const hidden: TurnEvent[] = [
      {
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "child prose",
        subagentId: "sub-1",
      },
      { kind: TurnEventKind.ToolCallOutputChunk, toolCallId: "t", text: "ls" },
      {
        kind: TurnEventKind.TerminalOutput,
        terminalId: "term-1",
        toolCallId: "t",
        command: "ls",
        data: "secret.txt",
      },
      {
        kind: TurnEventKind.CompactionUpdated,
        compactionId: "c1",
        status: CompactionStatus.Completed,
        summary: "private context",
      },
      { kind: TurnEventKind.ModelChanged, modelId: "private-model" },
      {
        kind: TurnEventKind.SubagentUpdated,
        toolCallId: "t",
        subagent: { id: "sub-1", goal: "private goal" },
      },
    ]

    for (const event of hidden)
      expect(project(event), event.kind).toBeUndefined()
  })

  it("passes an MCP App call's card to a guest and hides any other tool call", () => {
    const projector = projectorOf()
    const projectOne = (event: TurnEvent) =>
      projector(TurnEventSchema.parse(event))

    expect(
      projectOne({
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "chart-1",
        title: "Render chart",
        name: "render_chart",
        parentMessageId: "assistant-native",
        app: true,
      })
    ).toEqual({
      kind: TurnEventKind.ToolCallStarted,
      toolCallId: "chart-1",
      title: "render_chart",
      name: "render_chart",
      app: true,
    })
    expect(
      projectOne({
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "chart-1",
        output: "private data",
        failed: false,
        app: true,
      })
    ).toEqual({
      kind: TurnEventKind.ToolCallFinished,
      toolCallId: "chart-1",
      output: "",
      failed: false,
      app: true,
    })
    expect(
      projectOne({
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "read-1",
        title: "read_file",
      })
    ).toBeUndefined()
    expect(
      projectOne({
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "read-1",
        output: "private file",
        failed: false,
      })
    ).toBeUndefined()
  })

  it("passes a steer's acknowledgement and drops a kind it does not know", () => {
    const accepted: TurnEvent = {
      kind: TurnEventKind.SteerAccepted,
      requestId: "steer-1",
      text: "Shorter, please",
      delivery: "steered",
    }
    expect(project(accepted)).toEqual(accepted)
    expect(
      projectorOf()({ kind: "forged", text: "private" } as unknown as TurnEvent)
    ).toBeUndefined()
  })

  it("keeps a failure's provider and model from guests", () => {
    expect(
      project({
        kind: TurnEventKind.TurnFailed,
        code: "AOS_PROVIDER_ERROR",
        message: "private",
        provider: "private-provider",
        model: "private-model",
      })
    ).not.toMatchObject({ provider: expect.anything() })
  })

  it("passes a pending question whole", () => {
    const event: TurnEvent = {
      kind: TurnEventKind.TurnRequiresAction,
      requests: [
        {
          requestId: "question-1",
          kind: PendingRequestKind.Elicitation,
          message: "Which folder? Not /srv/aos/repo.",
          questions: [
            {
              label: "Folder under /srv/aos",
              choices: ["/home/operator/exports", "later"],
              multiple: false,
              custom: true,
            },
          ],
        },
      ],
    }

    expect(project(event)).toEqual(event)
  })

  it("preserves the normalized Todo list", () => {
    const todos = [{ id: "todo-1", label: "Review", status: "active" as const }]

    expect(project({ kind: TurnEventKind.PlanUpdated, todos })).toEqual({
      kind: TurnEventKind.PlanUpdated,
      todos,
    })
  })

  it("preserves a provider-held artifact and drops inline data", () => {
    expect(
      project({
        kind: TurnEventKind.ArtifactPublished,
        artifact: {
          id: "report-1",
          filename: "report.md",
          mimeType: "text/markdown",
          sizeBytes: 42,
          source: { type: "provider", reference: "report-1" },
        },
      })
    ).toEqual({
      kind: TurnEventKind.ArtifactPublished,
      artifact: {
        id: "report-1",
        filename: "report.md",
        mimeType: "text/markdown",
        sizeBytes: 42,
        source: { type: "provider", reference: "report-1" },
      },
    })
    expect(
      project({
        kind: TurnEventKind.ArtifactPublished,
        artifact: {
          id: "report-2",
          filename: "report.md",
          source: { type: "inline", encoding: "utf8", data: "private" },
        },
      })
    ).toBeUndefined()
    expect(
      project({
        kind: TurnEventKind.ArtifactPublished,
        artifact: {
          id: "report-3",
          filename: "report.md",
          source: { type: "provider", reference: "/private/report.md" },
        },
      })
    ).toBeUndefined()
  })

  it.each([
    ["AOS_CONNECTION_INTERRUPTED", "AOS_CONNECTION_INTERRUPTED"],
    ["AOS_SEND_UNCERTAIN", "AOS_SEND_UNCERTAIN"],
    ["AOS_INTERACTION_UNCERTAIN", "AOS_INTERACTION_UNCERTAIN"],
    ["AOS_STOP_UNCERTAIN", "AOS_STOP_UNCERTAIN"],
    ["AOS_RESET_REQUIRED", "temporarily_unavailable"],
    ["AOS_STREAM_OVERFLOW", "temporarily_unavailable"],
    ["AOS_PROVIDER_RETRYABLE_FAILURE", "temporarily_unavailable"],
    ["AOS_PROVIDER_AGENT_UNAVAILABLE", "temporarily_unavailable"],
    ["AOS_SESSION_BUSY", "rate_limited"],
    ["AOS_SESSION_LIMIT", "rate_limited"],
    ["AOS_PROVIDER_RUN_FAILED", "request_failed"],
    ["AOS_PROVIDER_BILLING_FAILED", "request_failed"],
    ["AOS_INTERACTION_EXPIRED", "request_failed"],
    ["AOS_INTERACTION_LOST", "request_failed"],
    ["AOS_SESSION_IN_USE", "request_failed"],
    ["AOS_UNKNOWN_TO_THIS_BUILD", "request_failed"],
    ["constructor", "request_failed"],
    ["toString", "request_failed"],
  ])("projects the run error code %s as %s", (code, expected) => {
    const projected = project({
      kind: TurnEventKind.TurnFailed,
      code,
      message: "Hermes said something private about /private/path",
    })

    expect(projected).toMatchObject({
      kind: TurnEventKind.TurnFailed,
      code: expected,
    })
    expect(String((projected as { message?: string })?.message)).not.toContain(
      "/private/path"
    )
  })

  it("never projects the provider detail of a run failure to a guest", () => {
    const projected = project({
      kind: TurnEventKind.TurnFailed,
      code: "AOS_PROVIDER_RETRYABLE_FAILURE",
      message:
        "Hermes' model provider returned an error for this turn. Retry, switch models with /model, or continue in a new Session.\nAn error occurred (ValidationException) when calling the InvokeModel operation",
    })

    expect(projected).toEqual({
      kind: TurnEventKind.TurnFailed,
      code: "temporarily_unavailable",
      message: guestErrorDescription("temporarily_unavailable"),
    })
    expect(JSON.stringify(projected)).not.toContain("ValidationException")
  })

  it("keeps a guest run whose failure awaits Stop stoppable", () => {
    expect(
      project({
        kind: TurnEventKind.TurnFailed,
        code: "AOS_INTERACTION_LOST",
        message: "Hermes lost the question",
        awaitingStop: true,
      })
    ).toEqual({
      kind: TurnEventKind.TurnFailed,
      code: "request_failed",
      message: guestErrorDescription("request_failed"),
      awaitingStop: true,
    })
  })
})

describe("a tool call flagged an MCP App only at its finish", () => {
  /** A hidden start, then its finish, through one guest's projector. */
  const settled = (app: boolean) => {
    const projector = projectorOf()
    const projectOne = (event: TurnEvent) =>
      projector(TurnEventSchema.parse(event))
    const started = projectOne({
      kind: TurnEventKind.ToolCallStarted,
      toolCallId: "chart-2",
      title: "Render private chart",
      name: "render_chart",
      parentMessageId: "assistant-native",
      locations: [{ path: "/srv/private" }],
    })
    const input = projectOne({
      kind: TurnEventKind.ToolCallInputChunk,
      toolCallId: "chart-2",
      delta: '{"title":"private input"}',
    })
    const finished = projectOne({
      kind: TurnEventKind.ToolCallFinished,
      toolCallId: "chart-2",
      output: "private data",
      failed: true,
      ...(app ? { app: true as const } : {}),
    })
    return { started, input, finished }
  }

  it("reaches the guest at its finish as a settled card under its name alone", () => {
    expect(settled(true)).toEqual({
      started: undefined,
      input: undefined,
      finished: {
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "chart-2",
        name: "render_chart",
        output: "",
        failed: true,
        app: true,
      },
    })
  })

  it("stays hidden when its finish is not flagged either", () => {
    expect(settled(false).finished).toBeUndefined()
  })

  it.each([
    [
      "a failure it recovers from",
      {
        kind: TurnEventKind.TurnFailed,
        code: "AOS_CONNECTION_INTERRUPTED",
        message: "The connection dropped.",
      },
    ],
    [
      "a failure still awaiting Stop",
      {
        kind: TurnEventKind.TurnFailed,
        code: "AOS_PROVIDER_RUN_FAILED",
        message: "The run failed.",
        awaitingStop: true,
      },
    ],
    [
      "a pause for an answer",
      {
        kind: TurnEventKind.TurnRequiresAction,
        requests: [
          {
            requestId: "question-2",
            kind: PendingRequestKind.Elicitation,
            message: "Which chart?",
            questions: [
              {
                label: "Chart",
                choices: ["bar", "line"],
                multiple: false,
                custom: false,
              },
            ],
          },
        ],
      },
    ],
  ] as [string, TurnEvent][])(
    "still reaches the guest under its name after %s",
    (_, between) => {
      const projector = projectorOf()
      const projectOne = (event: TurnEvent) =>
        projector(TurnEventSchema.parse(event))
      projectOne({
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "chart-4",
        title: "Render chart",
        name: "render_chart",
      })
      projectOne(between)

      expect(
        projectOne({
          kind: TurnEventKind.ToolCallFinished,
          toolCallId: "chart-4",
          output: "",
          failed: false,
          app: true,
        })
      ).toMatchObject({
        toolCallId: "chart-4",
        name: "render_chart",
        app: true,
      })
    }
  )

  it("stays hidden when it finishes after its turn ended or failed", () => {
    for (const done of [
      { kind: TurnEventKind.TurnEnded },
      {
        kind: TurnEventKind.TurnFailed,
        code: "AOS_PROVIDER_RUN_FAILED",
        message: "The run failed.",
      },
    ] as TurnEvent[]) {
      const projector = projectorOf()
      const projectOne = (event: TurnEvent) =>
        projector(TurnEventSchema.parse(event))
      projectOne({
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "chart-3",
        title: "render_chart",
      })
      projectOne(done)

      expect(
        projectOne({
          kind: TurnEventKind.ToolCallFinished,
          toolCallId: "chart-3",
          output: "",
          failed: false,
          app: true,
        }),
        done.kind
      ).toBeUndefined()
    }
  })
})

describe("guest turns layer", () => {
  /** One event through a guest's turns layer. */
  const shown = (event: MemberEvent) =>
    runEvents([createTurnsMiddleware()], event, { decline: () => undefined })

  it("drops the answer to a question asked by a call the guest was not shown", () => {
    const layer = [createTurnsMiddleware()]
    const act = { decline: () => undefined }
    const answered = (toolCallId: string) =>
      runEvents(
        layer,
        {
          sessionId: "ref",
          kind: "question-answered",
          request: {
            requestId: `question-${toolCallId}`,
            kind: PendingRequestKind.Elicitation,
            message: "Which?",
            toolCallId,
          },
          answers: [["yes"]],
        } as MemberEvent,
        act
      )
    runEvents(
      layer,
      {
        sessionId: "ref",
        kind: "turn",
        stream: { turnId: "turn-1", replayedCorrections: 0, dropped: false },
        sequence: 1,
        stopping: false,
        event: {
          kind: TurnEventKind.ToolCallStarted,
          toolCallId: "app-call",
          title: "render_chart",
          name: "render_chart",
          app: true,
        },
      } as MemberEvent,
      act
    )

    expect(answered("hidden-call")).toBeUndefined()
    expect(answered("app-call")).toMatchObject({
      kind: "question-answered",
      request: { toolCallId: "app-call" },
    })
  })

  it("drops a command list, which only an operator's feed emits", () => {
    expect(
      shown({
        sessionId: "ref",
        kind: "commands",
        capabilities: {},
      } as MemberEvent)
    ).toBeUndefined()
  })
})
