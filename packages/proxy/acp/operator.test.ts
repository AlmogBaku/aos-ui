import {
  ElicitationPropertySchema,
  methods,
} from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { type SessionHistoryResponse } from "../../protocol"
import {
  AOS_METHODS,
  AOS_META_KEY,
  AOS_PLAN_ID,
  AosActivityNotificationSchema,
  AosElicitationMetaSchema,
  AosPlanMetaSchema,
  AosPromptResponseMetaSchema,
  AosSessionResumeResponseMetaSchema,
} from "../../protocol/acp"
import {
  PendingRequestKind,
  RepliesTurnInputSchema,
  TurnEventKind,
  type TurnEvent,
} from "../core/events"
import { createActivityFeed } from "./activity-feed"
import { createReadState } from "./read-state"
import {
  AGENT,
  CAPABILITIES as HARNESS_CAPABILITIES,
  CREATED,
  EventSource,
  NOW,
  SESSION,
  harness as acpHarness,
  sessionRow,
  turnStarted,
  updates,
  type HarnessOptions as AcpHarnessOptions,
  type Recorder,
} from "./test-harness"
import * as translators from "./translate"

/**
 * The operator lane end to end in process: the real translators, the real ACP
 * agent, and the real Session coordinator, read state, Session rows, and
 * activity feed, composed exactly as `createOperatorAcpService` composes one
 * accepted connection, against a fake provider engine and an SDK client.
 */

const CLARIFY = "clarify-1"

/** The shared harness's provider, with a Todo projection and a deny choice. */
const CAPABILITIES = {
  ...HARNESS_CAPABILITIES,
  workspace: {
    ...HARNESS_CAPABILITIES.workspace,
    todos: {
      status: "available",
      scope: "session",
      mode: "read-only-projection",
      source: "latest-completed-todo-tool-result",
    },
  },
  interactions: {
    ...HARNESS_CAPABILITIES.interactions,
    approvals: {
      ...HARNESS_CAPABILITIES.interactions.approvals,
      choices: [
        { value: "once", scope: "request" },
        { value: "deny", scope: "request" },
      ],
    },
  },
}

const HISTORY: SessionHistoryResponse = {
  sessionId: SESSION,
  messages: [
    {
      id: "message-user",
      role: "user",
      content: [{ type: "text", text: "Summarize the notes" }],
      createdAt: NOW,
    },
    {
      id: "message-agent",
      role: "assistant",
      content: [{ type: "text", text: "Here they are" }],
      createdAt: NOW,
    },
  ],
  total: 2,
  limit: 500,
  offset: 0,
  nextOffset: 0,
}

/**
 * A clock and a manual scheduler: the read-state debounce runs only when the
 * test advances past it, so exposure never depends on wall time.
 */
function createClock(startMs: number) {
  const tasks = new Map<number, { at: number; run: () => void }>()
  let current = startMs
  let handles = 0
  return {
    now: () => current,
    pending: () => tasks.size,
    schedule(run: () => void, delayMs: number) {
      handles += 1
      tasks.set(handles, { at: current + delayMs, run })
      // Read state only hands the handle back to `cancel`, never to a timer.
      return handles as unknown as ReturnType<typeof setTimeout>
    },
    cancel(handle: ReturnType<typeof setTimeout>) {
      tasks.delete(handle as unknown as number)
    },
    advance(byMs: number) {
      current += byMs
      const due = [...tasks].sort(([, left], [, right]) => left.at - right.at)
      for (const [handle, task] of due)
        if (task.at <= current) {
          tasks.delete(handle)
          task.run()
        }
    },
  }
}

type HarnessOptions = Pick<
  AcpHarnessOptions,
  "rows" | "maxSubscriberEvents" | "permission" | "question"
> & { history?: SessionHistoryResponse }

async function harness({ history, ...options }: HarnessOptions = {}) {
  const clock = createClock(Date.parse(NOW))
  const test = await acpHarness({
    ...options,
    capabilities: CAPABILITIES,
    history: (history ?? HISTORY).messages,
    translators,
    now: clock.now,
    pagesHistory: false,
    // An operator who never answers declines, which the lane cancels.
    question: options.question ?? (async () => ({ action: "decline" })),
    compose: ({ runtimeInstance, sessionRows }) => ({
      readState: createReadState({
        runtimeInstance,
        sessionRows,
        lane: "operator",
        now: clock.now,
        schedule: clock.schedule,
        cancel: clock.cancel,
        onUnreadChanged: () => undefined,
      }),
      activityFeed: createActivityFeed({
        runtimeInstance,
        sessionRows,
        now: clock.now,
      }),
    }),
  })
  return {
    ...test,
    clock,
    prompt: (text: string) =>
      test.agent.request(methods.agent.session.prompt, {
        sessionId: CREATED,
        prompt: [{ type: "text", text }],
        _meta: { [AOS_META_KEY]: {} },
      }),
  }
}

type Harness = Awaited<ReturnType<typeof harness>>

/** Creates a Session, admits one turn, and returns the segment the engine opened. */
async function runningTurn(test: Harness, text: string) {
  await test.create()
  const accepted = await test.prompt(text)
  await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
  const source = test.sources[0]
  if (!source) throw new Error("The engine opened no run segment")
  return {
    source,
    messageId: AosPromptResponseMetaSchema.parse(aosMetaOf(accepted)).messageId,
  }
}

/**
 * The one `elicitation/create` request the client received. An elicitation the
 * SDK rejects never arrives at all: the attachment reports the rejection as
 * `_aos/error`, so this waits for whichever came first and names it.
 */
async function askedElicitation(test: Harness) {
  const asked = await test.recorder.wait(
    (entry) =>
      entry.method === methods.client.elicitation.create ||
      entry.method === AOS_METHODS.notify.error,
    "the question or the error rejecting it"
  )
  expect(asked.method).toBe(methods.client.elicitation.create)
  return asked
}

/** The `_meta.aos` payload an ACP response, request, or update carries. */
function aosMetaOf(value: unknown): unknown {
  return z
    .object({ _meta: z.object({ [AOS_META_KEY]: z.unknown() }) })
    .parse(value)._meta[AOS_META_KEY]
}

/** The `_meta.aos` of the update inside one `session/update` notification. */
function updateMetaOf(params: unknown): unknown {
  return aosMetaOf(z.object({ update: z.unknown() }).parse(params).update)
}

/** The form fields one `elicitation/create` request asks the operator for. */
function formFieldsOf(params: unknown) {
  const Schema = z.object({
    requestedSchema: z.object({
      properties: z.record(z.string(), z.custom<ElicitationPropertySchema>()),
    }),
  })
  return Schema.parse(params).requestedSchema.properties
}

/** Run-stream updates only: `session/new` pushes commands and usage out of band. */
function turnUpdates(recorder: Recorder) {
  return updates(recorder).filter((update) => {
    const text = JSON.stringify(update)
    return (
      !text.includes("available_commands_update") &&
      !text.includes("usage_update")
    )
  })
}

/** The window readings the browser received; only a settled turn owes it one. */
function usageUpdates(recorder: Recorder) {
  return updates(recorder).filter((update) =>
    JSON.stringify(update).includes("usage_update")
  )
}

function unreadChanges(recorder: Recorder) {
  return recorder.of(AOS_METHODS.notify.activity).flatMap(({ params }) => {
    const parsed = AosActivityNotificationSchema.safeParse(params)
    return parsed.success && parsed.data.type === "unread-changed"
      ? [parsed.data]
      : []
  })
}

/** The Session the seeded row names, as the coordinator and the routes see it. */
const SCOPE = { agentId: AGENT, sessionId: SESSION, threadId: SESSION }

/**
 * A steered run this connection does not own: the coordinator holds it for a
 * REST subscriber, so a later resume replays its journal from the first event.
 * Each accepted steer publishes the `aos.steer.accepted` the browser owes.
 */
async function steeredRun(test: Harness, corrections: readonly string[]) {
  await test.coordinator.start(
    SCOPE,
    {
      turnId: "run-live",
      messageId: "message-user",
      prompt: "Summarize the notes",
    },
    {
      subscriberId: "rest",
      controllerId: "operator",
      lane: "operator",
      canControl: true,
    }
  )
  const source = test.sources[0]
  if (!source) throw new Error("The engine opened no run segment")
  source.emit(turnStarted())
  await vi.waitFor(() => expect(test.coordinator.state(SCOPE)).toBe("running"))
  for (const [index, text] of corrections.entries())
    await test.coordinator.steer(
      SCOPE,
      { requestId: `steer-${index + 1}`, expectedTurnId: "run-live", text },
      "operator"
    )
  return source
}

/** History whose last user turn is the correction Hermes persisted mid-turn. */
function correctedHistory(text: string): SessionHistoryResponse {
  return {
    ...HISTORY,
    messages: [
      HISTORY.messages[0]!,
      {
        id: "message-correction",
        role: "user",
        content: [{ type: "text", text }],
        createdAt: NOW,
        metadata: { custom: { correction: true } },
      },
    ],
  }
}

/** Waits for the live delta that follows the replay, so a drop is observable. */
async function drainedReplay(test: Harness, source: EventSource) {
  source.emit({
    kind: TurnEventKind.MessageChunk,
    messageId: "assistant-live",
    text: "Live",
  })
  await test.recorder.wait(
    (entry) => JSON.stringify(entry.params).includes("Live"),
    "an update carrying Live"
  )
}

function steerAccepted(recorder: Recorder) {
  return recorder
    .of(AOS_METHODS.notify.steerAccepted)
    .map(({ params }) => params)
}

function turnEnded(): TurnEvent {
  return { kind: TurnEventKind.TurnEnded }
}

/**
 * The clarification Hermes raises: one question interrupt asking a single
 * choice, a multi-select, and a free-text question. An adapter that knows which
 * tool call is asking names it.
 */
function turnQuestioned(toolCallId?: string): TurnEvent {
  return {
    kind: TurnEventKind.TurnRequiresAction,
    requests: [
      {
        requestId: CLARIFY,
        kind: PendingRequestKind.Elicitation,
        message: "3 questions require answers",
        ...(toolCallId === undefined ? {} : { toolCallId }),
        questions: [
          {
            text: "Which environment?",
            choices: ["staging", "production"],
            multiple: false,
            custom: true,
          },
          {
            text: "Which services?",
            choices: ["api", "worker", "web"],
            multiple: true,
            custom: true,
          },
          {
            text: "Anything else to watch?",
            choices: [],
            multiple: true,
            custom: true,
          },
        ],
      },
    ],
  }
}

describe("operator ACP lane", () => {
  it("restates the model options when the provider switches the model mid-turn", async () => {
    const test = await harness()
    const { source } = await runningTurn(test, "Summarize")

    source.emit(turnStarted())
    source.emit({ kind: TurnEventKind.ModelChanged, modelId: "opus" })

    const reported = await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("config_option_update"),
      "an update carrying config_option_update"
    )
    expect(reported.params).toMatchObject({
      sessionId: CREATED,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [{ configId: "model", currentValue: "opus" }],
      },
    })
    test.close()
  })

  it("asks the browser to resync a run its stream was dropped from", async () => {
    // One event of queue, so the burst below outruns the send the pump awaits.
    const test = await harness({ maxSubscriberEvents: 1 })
    const { source } = await runningTurn(test, "Summarize")
    await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("usage_update"),
      "an update carrying usage_update"
    )

    source.emit(turnStarted())
    for (const delta of ["one", "two", "three", "four"])
      source.emit({
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: delta,
      })
    source.emit(turnEnded())

    const invalidated = await test.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.sessionInvalidated,
      "the Session invalidation"
    )
    expect(invalidated.params).toEqual({ sessionId: CREATED })
    // A dropped stream is not an outcome: the run failed nowhere, the turn this
    // browser half-saw never ends for it, and the window it did not read stays
    // at the one reading the Session opened with.
    expect(test.recorder.of(AOS_METHODS.notify.error)).toEqual([])
    expect(JSON.stringify(turnUpdates(test.recorder))).not.toContain("end_turn")
    expect(usageUpdates(test.recorder)).toHaveLength(1)
    test.close()
  })

  it("projects a PLAN activity snapshot as the Session's lossless Todo plan", async () => {
    const test = await harness()
    const { source } = await runningTurn(test, "Plan it")
    const todos = [
      { id: "todo-1", label: "Read the notes", status: "completed" as const },
      { id: "todo-2", label: "Draft the summary", status: "active" as const },
    ]

    source.emit(turnStarted())
    source.emit({
      kind: TurnEventKind.PlanUpdated,
      todos,
    })

    const planned = await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("plan_update"),
      "an update carrying plan_update"
    )
    expect(planned.params).toMatchObject({
      sessionId: CREATED,
      update: {
        sessionUpdate: "plan_update",
        plan: { type: "items", planId: AOS_PLAN_ID },
      },
    })
    expect(AosPlanMetaSchema.parse(updateMetaOf(planned.params)).todos).toEqual(
      todos
    )
    test.close()
  })

  it("delivers a multi-select question the SDK accepts", async () => {
    const test = await harness({
      question: async () => ({
        action: "accept",
        content: {
          q0: "production",
          q1: ["api", "the nightly billing job"],
          q2: "watch the queue depth",
        },
      }),
    })
    const { source } = await runningTurn(test, "Clarify it")

    source.emit(turnStarted())
    source.emit(turnQuestioned())
    source.finish()

    const asked = await askedElicitation(test)
    expect(asked.params).toMatchObject({
      sessionId: CREATED,
      mode: "form",
      message: "3 questions require answers",
      requestedSchema: {
        properties: {
          q0: { type: "string", description: "Which environment?" },
          q1: {
            type: "array",
            description: "Which services?",
            items: { type: "string", enum: ["api", "worker", "web"] },
          },
          q2: { type: "string", description: "Anything else to watch?" },
        },
        required: ["q0", "q1", "q2"],
      },
    })
    const fields = formFieldsOf(asked.params)
    expect(Object.keys(fields)).toEqual(["q0", "q1", "q2"])

    // `items.enum` is what the SDK validates a multi-select against: the same
    // field without it is no longer an ACP multi-select, and an elicitation
    // carrying it is rejected whole rather than delivered.
    const multiSelect = fields.q1!
    expect(ElicitationPropertySchema.isArray(multiSelect)).toBe(true)
    expect(
      ElicitationPropertySchema.isArray({
        ...multiSelect,
        items: { type: "string" },
      })
    ).toBe(false)

    const meta = AosElicitationMetaSchema.parse(aosMetaOf(asked.params))
    expect(meta.requestId).toBe(CLARIFY)
    expect(meta.questions).toMatchObject([
      { prompt: "Which environment?", multiple: false, custom: true },
      {
        prompt: "Which services?",
        multiple: true,
        custom: true,
        options: [{ label: "api" }, { label: "worker" }, { label: "web" }],
      },
      {
        prompt: "Anything else to watch?",
        multiple: true,
        custom: true,
        options: [],
      },
    ])

    // Every answer resumes the run, including the choice no question offered.
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    const resumed = RepliesTurnInputSchema.parse(test.start.mock.calls[1]?.[1])
    expect(resumed.replies).toEqual([
      {
        requestId: CLARIFY,
        status: "resolved",
        payload: {
          answers: [
            ["production"],
            ["api", "the nightly billing job"],
            ["watch the queue depth"],
          ],
        },
      },
    ])
    test.close()
  })

  it("records the answers on the tool call that asked them", async () => {
    const test = await harness({
      question: async () => ({
        action: "accept",
        content: { q0: "production", q1: ["api", "web"], q2: "the queue" },
      }),
    })
    const { source } = await runningTurn(test, "Clarify it")

    source.emit(turnStarted())
    source.emit(turnQuestioned("call-9"))
    source.finish()

    const recorded = await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("tool_call_update"),
      "an update carrying tool_call_update"
    )
    expect(recorded.params).toMatchObject({
      sessionId: CREATED,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-9",
        status: "completed",
        rawOutput: {
          status: "answered",
          responses: [
            { question: "Which environment?", answers: ["production"] },
            { question: "Which services?", answers: ["api", "web"] },
            { question: "Anything else to watch?", answers: ["the queue"] },
          ],
        },
      },
    })
    test.close()
  })

  it("cancels the request when the operator declines", async () => {
    const test = await harness({
      question: async () => ({ action: "decline" }),
    })
    const { source } = await runningTurn(test, "Clarify it")

    source.emit(turnStarted())
    source.emit(turnQuestioned())
    source.finish()

    await askedElicitation(test)

    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    const resumed = RepliesTurnInputSchema.parse(test.start.mock.calls[1]?.[1])
    expect(resumed.replies).toEqual([
      { requestId: CLARIFY, status: "cancelled" },
    ])
    test.close()
  })

  it("acknowledges the focused Session's read state once the debounce elapses", async () => {
    const test = await harness({ rows: [sessionRow({ unread: true })] })
    await test.list()
    await test.recorder.wait(
      () => unreadChanges(test.recorder).length > 0,
      "the Session's unread change"
    )
    expect(unreadChanges(test.recorder)).toMatchObject([{ unread: true }])

    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: SESSION })
    await vi.waitFor(() => expect(test.clock.pending()).toBe(1))
    test.clock.advance(500)

    await vi.waitFor(() =>
      expect(test.updateSession).toHaveBeenCalledWith(AGENT, SESSION, {
        unread: false,
      })
    )
    expect(test.updateSession).toHaveBeenCalledTimes(1)
    await test.recorder.wait(
      () => unreadChanges(test.recorder).length === 2,
      "the Session's read change"
    )
    expect(unreadChanges(test.recorder)[1]).toMatchObject({
      agentId: AGENT,
      sessionId: SESSION,
      type: "unread-changed",
      unread: false,
    })
    test.close()
  })

  it("replays history before answering a resume that reports an idle execution", async () => {
    const test = await harness()

    const resumed = await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
      _meta: { [AOS_META_KEY]: { agentId: AGENT } },
    })

    // The stored turn replays as the stream its run sent: the states that
    // bracket it, and its prose as the chunk it arrived as.
    expect(updates(test.recorder).slice(0, 4)).toMatchObject([
      {
        sessionId: SESSION,
        update: {
          sessionUpdate: "user_message",
          messageId: "message-user",
          content: [{ type: "text", text: "Summarize the notes" }],
        },
      },
      {
        sessionId: SESSION,
        update: { sessionUpdate: "state_update", state: "running" },
      },
      {
        sessionId: SESSION,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-agent",
          content: { type: "text", text: "Here they are" },
        },
      },
      {
        sessionId: SESSION,
        update: {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "end_turn",
        },
      },
    ])
    expect(
      AosSessionResumeResponseMetaSchema.parse(aosMetaOf(resumed)).execution
        .status
    ).toBe("idle")
    test.close()
  })

  it("announces a persisted correction once on a from-start resume", async () => {
    const test = await harness({ history: correctedHistory("Use the tables") })
    const source = await steeredRun(test, ["Use the tables"])

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
      _meta: { [AOS_META_KEY]: { agentId: AGENT } },
    })
    await drainedReplay(test, source)

    expect(
      turnUpdates(test.recorder).filter((update) =>
        JSON.stringify(update).includes("Use the tables")
      )
    ).toMatchObject([
      {
        sessionId: SESSION,
        update: {
          sessionUpdate: "user_message",
          messageId: "message-correction",
          content: [{ type: "text", text: "Use the tables" }],
        },
      },
    ])
    expect(steerAccepted(test.recorder)).toEqual([])
    test.close()
  })

  it("announces the correction history could not carry yet", async () => {
    const test = await harness({ history: correctedHistory("Use the tables") })
    const source = await steeredRun(test, ["Use the tables", "And the totals"])

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
      _meta: { [AOS_META_KEY]: { agentId: AGENT } },
    })
    await drainedReplay(test, source)

    expect(steerAccepted(test.recorder)).toMatchObject([
      {
        sessionId: SESSION,
        turnId: "run-live",
        requestId: "steer-2",
        text: "And the totals",
        delivery: "steered",
      },
    ])
    test.close()
  })

  it("forwards every acknowledgement to a cursor resume, which replays no history", async () => {
    const test = await harness({ history: correctedHistory("Use the tables") })
    const source = await steeredRun(test, ["Use the tables", "And the totals"])

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      _meta: {
        [AOS_META_KEY]: { agentId: AGENT, turnId: "run-live", after: 0 },
      },
    })
    await drainedReplay(test, source)

    expect(steerAccepted(test.recorder).map((params) => params)).toMatchObject([
      { requestId: "steer-1", text: "Use the tables" },
      { requestId: "steer-2", text: "And the totals" },
    ])
    test.close()
  })

  it("replays a stored artifact as a link chunk on its message", async () => {
    const artifact = {
      id: "artifact-1",
      filename: "Quarterly report",
      sizeBytes: 4_096,
      source: { type: "provider" as const, reference: "artifact-1" },
    }
    const test = await harness({
      history: {
        ...HISTORY,
        messages: [
          HISTORY.messages[0]!,
          {
            id: "message-agent",
            role: "assistant",
            content: [
              { type: "text", text: "Here they are" },
              { type: "data", name: "aos.artifact", data: artifact },
            ],
            createdAt: NOW,
          },
        ],
      },
    })

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
      _meta: { [AOS_META_KEY]: { agentId: AGENT } },
    })

    const linked = updates(test.recorder).filter(
      (params) =>
        "content" in params.update &&
        !Array.isArray(params.update.content) &&
        params.update.content?.type === "resource_link"
    )
    expect(linked).toHaveLength(1)
    expect(linked[0]).toMatchObject({
      sessionId: SESSION,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-agent",
      },
    })
    expect((linked[0]!.update as { content: unknown }).content).toEqual({
      type: "resource_link",
      uri: "artifact://artifact-1",
      name: "Quarterly report",
      size: 4_096,
    })
    test.close()
  })
})
