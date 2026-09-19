import {
  client,
  ElicitationPropertySchema,
  methods,
  type CreateElicitationResponse,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import {
  INTERACTION_PROTOCOL,
  SESSION_CATALOG_MAX_WINDOW,
  type RuntimeInfo,
  type Session,
  type SessionHistoryResponse,
  type SessionModelsResponse,
} from "../../protocol"
import {
  ACP_PROTOCOL_VERSION,
  AOS_METHODS,
  AOS_META_KEY,
  AOS_PLAN_ID,
  AosActivityNotificationSchema,
  AosArtifactNotificationSchema,
  AosElicitationMetaSchema,
  AosInitializeMetaSchema,
  AosPermissionMetaSchema,
  AosPlanMetaSchema,
  AosPromptResponseMetaSchema,
  AosSessionNewResponseMetaSchema,
  AosSessionResumeResponseMetaSchema,
} from "../../protocol/acp"
import { AttachmentStageRegistry } from "../core/attachment-stages"
import { RunEventKind, type RunEvent } from "../core/events"
import type {
  RuntimeInstance,
  ServerRunEngine,
  ServerRunHandle,
  ServerRuntime,
} from "../core/runtime"
import { SessionCoordinator } from "../core/session-coordinator"
import { createSessionRows } from "../core/session-rows"
import { createActivityFeed } from "./activity-feed"
import { createAosAcpAgent } from "./agent"
import { createReadState } from "./read-state"
import * as translators from "./translate"
import type { AcpConnectionContext } from "./types"

/**
 * The operator lane end to end in process: the real translators, the real ACP
 * agent, and the real Session coordinator, read state, Session rows, and
 * activity feed, composed exactly as `createOperatorAcpService` composes one
 * accepted connection, against a fake provider engine and an SDK client.
 */

const AGENT = "researcher"
const SESSION = "session-1"
const CREATED = "session-created"
const CLARIFY = "clarify-1"
const NOW = "2026-01-01T00:00:00.000Z"

function sessionRow(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION,
    agentId: AGENT,
    title: "Notes",
    archived: false,
    updatedAt: NOW,
    status: "idle",
    ...overrides,
  }
}

const MODELS: SessionModelsResponse = {
  selectedId: "sonnet",
  options: [
    { id: "sonnet", label: "Sonnet", group: "Anthropic" },
    { id: "opus", label: "Opus", group: "Anthropic" },
  ],
}

const AVAILABLE = { status: "available" } as const

const RUNTIME_INFO: RuntimeInfo = {
  runtime: { id: "hermes", name: "Hermes" },
  status: "ready",
  capabilities: {
    agentCatalog: AVAILABLE,
    agentVisibility: AVAILABLE,
    sessionCatalog: {
      status: "available",
      scope: "workspace",
      order: "recent",
      defaultPageSize: 50,
      maxPageSize: 100,
      maxWindow: SESSION_CATALOG_MAX_WINDOW,
    },
    sessionHistory: {
      status: "available",
      order: "chronological",
      compacted: true,
      loading: "on-open",
      defaultPageSize: 200,
      maxPageSize: 500,
    },
    sessionDetail: AVAILABLE,
    sessionCreation: AVAILABLE,
    sessionTitle: AVAILABLE,
    sessionArchival: AVAILABLE,
    sessionDeletion: AVAILABLE,
    sessionRun: AVAILABLE,
    sessionStop: AVAILABLE,
    sessionSteer: AVAILABLE,
    sessionReadState: AVAILABLE,
  },
}

const CAPABILITIES = {
  workspace: {
    slashCommands: {
      status: "available",
      scope: "attached-session",
      commands: [{ name: "plan", description: "Draft a plan" }],
    },
    models: {
      status: "available",
      scope: "attached-session",
      selection: "native-session",
      choices: "provider-reported",
    },
    context: {
      status: "available",
      scope: "attached-session",
      source: "provider-usage-or-estimate",
      breakdown: "provider-categories",
    },
    todos: {
      status: "available",
      scope: "session",
      mode: "read-only-projection",
      source: "latest-completed-todo-tool-result",
    },
    activity: { status: "unavailable", reason: "activity-unavailable" },
  },
  interactions: {
    steering: {
      status: "available",
      scope: "active-run",
      semantics: "visible-user-message",
      input: "text",
      fallback: "provider-queue",
    },
    approvals: {
      status: "available",
      protocol: INTERACTION_PROTOCOL,
      scope: "run",
      choices: [
        { value: "once", scope: "request" },
        { value: "deny", scope: "request" },
      ],
      maxPending: 1,
    },
    questions: {
      status: "available",
      protocol: INTERACTION_PROTOCOL,
      scope: "run",
      answerModes: ["single", "multiple", "free-text"],
      cancellation: "native-cancel",
      maxQuestions: 1,
      maxChoicesPerQuestion: 4,
      maxAnswerValuesPerQuestion: "complete-request",
      maxStringBytes: 4096,
    },
    reactions: { status: "unavailable", reason: "reactions-unavailable" },
  },
  content: {
    attachments: { status: "unavailable", reason: "attachments-unavailable" },
    artifacts: { status: "unavailable", reason: "artifacts-unavailable" },
    transcription: {
      status: "unavailable",
      reason: "transcription-unavailable",
    },
    speech: { status: "unavailable", reason: "speech-unavailable" },
  },
}

const USAGE = {
  usedTokens: 1_200,
  maxTokens: 20_000,
  source: "provider-usage" as const,
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

/** One provider run segment the test drives event by event. */
class EventSource implements ServerRunHandle {
  readonly #values: RunEvent[] = []
  readonly #waiters: Array<(value: IteratorResult<RunEvent>) => void> = []
  readonly stop = vi.fn(async () => "stopping" as const)
  readonly settled: Promise<void>
  #resolveSettled!: () => void
  #closed = false

  constructor() {
    this.settled = new Promise((resolve) => {
      this.#resolveSettled = resolve
    })
  }

  readonly events: AsyncIterable<RunEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const value = this.#values.shift()
        if (value) return Promise.resolve({ done: false, value })
        if (this.#closed)
          return Promise.resolve({ done: true, value: undefined })
        return new Promise<IteratorResult<RunEvent>>((resolve) =>
          this.#waiters.push(resolve)
        )
      },
    }),
  }

  emit(event: RunEvent) {
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ done: false, value: event })
    else this.#values.push(event)
  }

  finish() {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0))
      waiter({ done: true, value: undefined })
    this.#resolveSettled()
  }

  recoveryPosition() {
    return { epoch: "epoch-1", lastSeen: 0 }
  }
}

type Recorded = { method: string; params: unknown }

function createRecorder() {
  const entries: Recorded[] = []
  const waiters = new Set<() => void>()
  return {
    entries,
    of(method: string) {
      return entries.filter((entry) => entry.method === method)
    },
    add(entry: Recorded) {
      entries.push(entry)
      for (const resolve of [...waiters]) resolve()
    },
    async wait(predicate: (entry: Recorded) => boolean) {
      for (;;) {
        const found = entries.find(predicate)
        if (found) return found
        await new Promise<void>((resolve) => {
          const wake = () => {
            waiters.delete(wake)
            resolve()
          }
          waiters.add(wake)
        })
      }
    },
  }
}

type Recorder = ReturnType<typeof createRecorder>

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

const unsupported = () => {
  throw new Error("The operator ACP test does not exercise this operation")
}

const PatchSchema = z.object({
  title: z.string().optional(),
  archived: z.boolean().optional(),
  unread: z.boolean().optional(),
})

const TurnInputSchema = z.object({
  runId: z.string(),
  threadId: z.string(),
  messages: z.array(z.unknown()),
  resume: z
    .array(
      z.object({
        interruptId: z.string(),
        status: z.string(),
        // A cancelled reply answers with no payload at all.
        payload: z.unknown().optional(),
      })
    )
    .optional(),
})

type HarnessOptions = {
  rows?: Session[]
  history?: SessionHistoryResponse
  permission?: (params: unknown) => Promise<RequestPermissionResponse>
  elicitation?: (params: unknown) => Promise<CreateElicitationResponse>
}

async function harness(options: HarnessOptions = {}) {
  const clock = createClock(Date.parse(NOW))
  const sources: EventSource[] = []
  const start = vi.fn(async () => {
    const source = new EventSource()
    sources.push(source)
    return source
  })
  const recover = vi.fn(async () => sources.at(-1) ?? new EventSource())
  const engine: ServerRunEngine = { start, recover }
  const coordinator = new SessionCoordinator({
    engine,
    maxActiveExecutions: 8,
    maxGuestActiveExecutions: 2,
    maxSubscriberEvents: 64,
    maxSubscriberBytes: 256 * 1024,
    maxReplayEvents: 64,
    maxReplayBytes: 256 * 1024,
  })

  const rows = new Map(
    (options.rows ?? [sessionRow()]).map((row) => [row.id, row])
  )

  const listAllSessions = vi.fn(async (limit: number, offset: number) => ({
    sessions: [...rows.values()],
    total: rows.size,
    limit,
    offset,
  }))
  const getSession = vi.fn(async (_agentId: string, sessionId: string) => {
    const row = rows.get(sessionId)
    if (!row) throw new Error("not found")
    return row
  })
  const mutateSession = vi.fn(
    async (
      _agentId: string,
      sessionId: string,
      method: "PATCH" | "DELETE",
      body?: unknown
    ) => {
      const current = rows.get(sessionId)
      if (method === "DELETE") {
        rows.delete(sessionId)
        return
      }
      if (current)
        rows.set(sessionId, { ...current, ...PatchSchema.parse(body ?? {}) })
    }
  )
  const history = vi.fn(async () => options.history ?? HISTORY)

  const runtime: ServerRuntime = {
    runs: engine,
    resolveInvitedSession: unsupported,
    resolveSessionId: (_agentId, publicSessionId) => publicSessionId,
    publicError: () => undefined,
    authState: unsupported,
    runtimeInfo: async () => RUNTIME_INFO,
    listAgents: async () => ({ revision: "rev-1", agents: [] }),
    updateAgentVisibility: unsupported,
    listAllSessions,
    listSessions: async (_agentId, limit, offset) =>
      listAllSessions(limit, offset),
    history,
    getSession,
    createSession: async (agentId, title) => {
      rows.set(
        CREATED,
        sessionRow({ id: CREATED, agentId, title: title ?? "Untitled" })
      )
      return { session: { id: CREATED, agentId } }
    },
    mutateSession,
    workspaceCapabilities: async () => CAPABILITIES,
    models: async () => MODELS,
    updateModel: unsupported,
    context: async () => USAGE,
    subscribeSessionInvalidation: unsupported,
    subscribeCatalogChanges: async () => () => undefined,
    stageAttachments: unsupported,
    artifact: unsupported,
    transcribe: unsupported,
    speak: unsupported,
  }

  const runtimeInstance: RuntimeInstance = {
    id: "test",
    runtime,
    sessions: coordinator,
    close: async () => undefined,
  }

  // The same object `createOperatorAcpService`'s `connection(...)` builds, with
  // the injected clock this test drives instead of wall time.
  const lane = "operator" as const
  const sessionRows = createSessionRows({ now: clock.now })
  const context: AcpConnectionContext = {
    connectionId: "connection-1",
    principalId: "operator",
    lane,
    runtimeInstance,
    sessionRows,
    translators,
    attachmentStages: new AttachmentStageRegistry(),
    logger: { info: vi.fn(), error: vi.fn() },
    readState: createReadState({
      runtimeInstance,
      sessionRows,
      lane,
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
  }

  const recorder = createRecorder()
  const clientApp = client({ name: "aos-browser" })
    .onNotification(methods.client.session.update, ({ params }) => {
      recorder.add({ method: methods.client.session.update, params })
    })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      recorder.add({
        method: methods.client.session.requestPermission,
        params,
      })
      return (
        (await options.permission?.(params)) ?? {
          outcome: { outcome: "selected", optionId: "once" },
        }
      )
    })
    .onRequest(methods.client.elicitation.create, async ({ params }) => {
      recorder.add({ method: methods.client.elicitation.create, params })
      return (await options.elicitation?.(params)) ?? { action: "decline" }
    })
  for (const method of Object.values(AOS_METHODS.notify))
    clientApp.onNotification(
      method,
      (params) => params,
      ({ params }) => {
        recorder.add({ method, params })
      }
    )

  const connection = clientApp.connect(createAosAcpAgent(context))
  const initialize = await connection.agent.request(methods.agent.initialize, {
    protocolVersion: ACP_PROTOCOL_VERSION,
    info: { name: "aos-browser", version: "1" },
    capabilities: {},
  })

  return {
    agent: connection.agent,
    close: () => connection.close(),
    clock,
    initialize,
    recorder,
    sources,
    start,
    mutateSession,
    /** Registers the Agent that owns the seeded Session, as a roster read does. */
    list: () => connection.agent.request(methods.agent.session.list, {}),
    create: () =>
      connection.agent.request(methods.agent.session.new, {
        cwd: "/",
        _meta: { [AOS_META_KEY]: { agentId: AGENT } },
      }),
    prompt: (text: string) =>
      connection.agent.request(methods.agent.session.prompt, {
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
      entry.method === AOS_METHODS.notify.error
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

function updates(recorder: Recorder) {
  return recorder.of(methods.client.session.update).map((entry) => entry.params)
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

/** Every `_meta.aos.sequence` the recorded run-stream updates carry, in order. */
function sequencesOf(recorder: Recorder) {
  const Schema = z.object({
    update: z.object({
      _meta: z.object({ [AOS_META_KEY]: z.object({ sequence: z.number() }) }),
    }),
  })
  return updates(recorder).flatMap((params) => {
    const parsed = Schema.safeParse(params)
    return parsed.success
      ? [parsed.data.update._meta[AOS_META_KEY].sequence]
      : []
  })
}

function unreadChanges(recorder: Recorder) {
  return recorder.of(AOS_METHODS.notify.activity).flatMap(({ params }) => {
    const parsed = AosActivityNotificationSchema.safeParse(params)
    return parsed.success && parsed.data.type === "unread-changed"
      ? [parsed.data]
      : []
  })
}

function runStarted(runId: string, threadId: string): RunEvent {
  return { type: RunEventKind.RUN_STARTED, threadId, runId }
}

function runFinished(runId: string, threadId: string): RunEvent {
  return {
    type: RunEventKind.RUN_FINISHED,
    threadId,
    runId,
    outcome: { type: "success" },
  }
}

/**
 * The clarification Hermes raises: one question interrupt whose prefixed answer
 * schemas are a single choice, a multi-select, and a free-text question.
 */
function runQuestioned(runId: string, threadId: string): RunEvent {
  return {
    type: RunEventKind.RUN_FINISHED,
    threadId,
    runId,
    outcome: {
      type: "interrupt",
      interrupts: [
        {
          id: CLARIFY,
          reason: "question",
          message: "3 questions require answers",
          responseSchema: {
            type: "object",
            properties: {
              answers: {
                type: "array",
                prefixItems: [
                  {
                    type: "array",
                    title: "Which environment?",
                    items: { type: "string", enum: ["staging", "production"] },
                    minItems: 0,
                    maxItems: 1,
                  },
                  {
                    type: "array",
                    title: "Which services?",
                    items: { type: "string", enum: ["api", "worker", "web"] },
                    minItems: 0,
                    maxItems: 3,
                  },
                  {
                    type: "array",
                    title: "Anything else to watch?",
                    items: { type: "string", maxLength: 4096 },
                    minItems: 0,
                    maxItems: 64,
                  },
                ],
                minItems: 3,
                maxItems: 3,
              },
            },
            required: ["answers"],
            additionalProperties: false,
          },
        },
      ],
    },
  }
}

describe("operator ACP lane", () => {
  it("initializes protocol version 2 on the operator lane with no auth methods", async () => {
    const test = await harness()

    expect(test.initialize).toMatchObject({
      protocolVersion: ACP_PROTOCOL_VERSION,
      authMethods: [],
    })
    const meta = AosInitializeMetaSchema.parse(aosMetaOf(test.initialize))
    expect(meta.lane).toBe("operator")
    expect(meta.extensions.guestProjection).toBe(false)
    test.close()
  })

  it("creates a Session with a model config option and pushes its commands and usage", async () => {
    const test = await harness()

    const created = await test.create()

    expect(created).toMatchObject({
      sessionId: CREATED,
      configOptions: [
        {
          type: "select",
          configId: "model",
          category: "model",
          currentValue: "sonnet",
        },
      ],
    })
    expect(
      AosSessionNewResponseMetaSchema.parse(aosMetaOf(created)).session.agentId
    ).toBe(AGENT)
    await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes("usage_update")
    )
    expect(updates(test.recorder)).toMatchObject([
      {
        sessionId: CREATED,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "plan", description: "Draft a plan" }],
        },
      },
      {
        sessionId: CREATED,
        update: { sessionUpdate: "usage_update", used: 1_200, size: 20_000 },
      },
    ])
    test.close()
  })

  it("acknowledges a prompt then streams the turn from running to idle", async () => {
    const test = await harness()
    const { source, messageId } = await runningTurn(test, "Summarize")

    source.emit(runStarted("run-1", CREATED))
    source.emit({
      type: RunEventKind.TEXT_MESSAGE_START,
      messageId: "assistant-1",
      role: "assistant",
    })
    source.emit({
      type: RunEventKind.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "Hel",
    })
    source.emit({
      type: RunEventKind.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "lo",
    })
    source.emit({
      type: RunEventKind.TEXT_MESSAGE_END,
      messageId: "assistant-1",
    })
    source.emit(runFinished("run-1", CREATED))

    await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes("end_turn")
    )
    expect(turnUpdates(test.recorder)).toMatchObject([
      {
        sessionId: CREATED,
        update: {
          sessionUpdate: "user_message",
          messageId,
          content: [{ type: "text", text: "Summarize" }],
        },
      },
      { update: { sessionUpdate: "state_update", state: "running" } },
      {
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "assistant-1",
          content: { type: "text", text: "Hel" },
        },
      },
      {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "lo" },
        },
      },
      {
        update: {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "end_turn",
        },
      },
    ])
    // Only the proxy-minted user turn is unsequenced; the run stream is not.
    const sequences = sequencesOf(test.recorder)
    expect(sequences).toHaveLength(turnUpdates(test.recorder).length - 1)
    expect(sequences.every((value) => Number.isInteger(value))).toBe(true)
    expect([...sequences].sort((left, right) => left - right)).toEqual(
      sequences
    )
    test.close()
  })

  it("projects a PLAN activity snapshot as the Session's lossless Todo plan", async () => {
    const test = await harness()
    const { source } = await runningTurn(test, "Plan it")
    const todos = [
      { id: "todo-1", label: "Read the notes", status: "completed" as const },
      { id: "todo-2", label: "Draft the summary", status: "active" as const },
    ]

    source.emit(runStarted("run-1", CREATED))
    source.emit({
      type: RunEventKind.ACTIVITY_SNAPSHOT,
      messageId: `aos-plan:${CREATED}`,
      activityType: "PLAN",
      content: { todos },
      replace: true,
    })

    const planned = await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes("plan_update")
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

  it("requires action for an interrupt and resumes the run with the answer", async () => {
    const test = await harness()
    const { source } = await runningTurn(test, "Delete it")
    const admitted = TurnInputSchema.parse(test.start.mock.calls[0]?.[1])

    source.emit(runStarted("run-1", CREATED))
    source.emit({
      type: RunEventKind.RUN_FINISHED,
      threadId: CREATED,
      runId: "run-1",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "int-1",
            reason: "approval",
            message: "Run rm?",
            toolCallId: "tool-1",
            // Adapters carry the approval choices as the response schema's enum.
            responseSchema: { type: "string", enum: ["once", "deny"] },
          },
        ],
      },
    })
    source.finish()

    const asked = await test.recorder.wait(
      (entry) => entry.method === methods.client.session.requestPermission
    )

    // The wait is reported as state before the request that carries it.
    const requiresAction = test.recorder.entries.findIndex((entry) =>
      JSON.stringify(entry.params).includes("requires_action")
    )
    expect(requiresAction).toBeGreaterThanOrEqual(0)
    expect(requiresAction).toBeLessThan(test.recorder.entries.indexOf(asked))
    expect(asked.params).toMatchObject({
      sessionId: CREATED,
      title: "Run rm?",
      options: [
        { optionId: "once", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once" },
      ],
    })
    expect(
      AosPermissionMetaSchema.parse(aosMetaOf(asked.params)).interruptId
    ).toBe("int-1")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    const resumed = TurnInputSchema.parse(test.start.mock.calls[1]?.[1])
    expect(resumed.messages).toEqual([])
    expect(resumed.resume).toMatchObject([
      { interruptId: "int-1", status: "resolved" },
    ])
    expect(resumed.resume?.[0]?.payload).toBeDefined()
    expect(resumed.runId).not.toBe(admitted.runId)
    test.close()
  })

  it("delivers a multi-select question the SDK accepts", async () => {
    const test = await harness({
      elicitation: async () => ({
        action: "accept",
        content: {
          q0: "production",
          q1: ["api", "the nightly billing job"],
          q2: "watch the queue depth",
        },
      }),
    })
    const { source } = await runningTurn(test, "Clarify it")

    source.emit(runStarted("run-1", CREATED))
    source.emit(runQuestioned("run-1", CREATED))
    source.finish()

    const asked = await askedElicitation(test)
    expect(asked.params).toMatchObject({
      sessionId: CREATED,
      mode: "form",
      message: "3 questions require answers",
      requestedSchema: {
        properties: {
          q0: { type: "string", title: "Which environment?" },
          q1: {
            type: "array",
            title: "Which services?",
            items: { type: "string", enum: ["api", "worker", "web"] },
          },
          q2: { type: "string", title: "Anything else to watch?" },
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
    expect(meta.interruptId).toBe(CLARIFY)
    expect(meta.questions).toMatchObject([
      { header: "Which environment?", multiple: false, custom: true },
      {
        header: "Which services?",
        multiple: true,
        custom: true,
        options: [{ label: "api" }, { label: "worker" }, { label: "web" }],
      },
      {
        header: "Anything else to watch?",
        multiple: true,
        custom: true,
        options: [],
      },
    ])

    // Every answer resumes the run, including the choice no question offered.
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    const resumed = TurnInputSchema.parse(test.start.mock.calls[1]?.[1])
    expect(resumed.resume).toEqual([
      {
        interruptId: CLARIFY,
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

  it("cancels the interrupt when the operator declines", async () => {
    const test = await harness({
      elicitation: async () => ({ action: "decline" }),
    })
    const { source } = await runningTurn(test, "Clarify it")

    source.emit(runStarted("run-1", CREATED))
    source.emit(runQuestioned("run-1", CREATED))
    source.finish()

    await askedElicitation(test)

    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    const resumed = TurnInputSchema.parse(test.start.mock.calls[1]?.[1])
    expect(resumed.messages).toEqual([])
    expect(resumed.resume).toEqual([
      { interruptId: CLARIFY, status: "cancelled" },
    ])
    test.close()
  })

  it("stops a running turn at the provider and settles it as cancelled", async () => {
    const test = await harness()
    const { source } = await runningTurn(test, "Long job")
    source.emit(runStarted("run-1", CREATED))
    await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes('"state":"running"')
    )

    await test.agent.notify(methods.agent.session.cancel, {
      sessionId: CREATED,
    })

    await vi.waitFor(() => expect(source.stop).toHaveBeenCalledTimes(1))
    source.emit(runFinished("run-1", CREATED))
    const settled = await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes("cancelled")
    )
    expect(settled.params).toMatchObject({
      sessionId: CREATED,
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled",
      },
    })
    test.close()
  })

  it("acknowledges the focused Session's read state once the debounce elapses", async () => {
    const test = await harness({ rows: [sessionRow({ unread: true })] })
    await test.list()
    await vi.waitFor(() =>
      expect(unreadChanges(test.recorder)).toMatchObject([{ unread: true }])
    )

    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: SESSION })
    await vi.waitFor(() => expect(test.clock.pending()).toBe(1))
    test.clock.advance(500)

    await vi.waitFor(() =>
      expect(test.mutateSession).toHaveBeenCalledWith(AGENT, SESSION, "PATCH", {
        unread: false,
      })
    )
    expect(test.mutateSession).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(unreadChanges(test.recorder)).toHaveLength(2))
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

    expect(updates(test.recorder).slice(0, 2)).toMatchObject([
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
        update: {
          sessionUpdate: "agent_message",
          messageId: "message-agent",
          content: [{ type: "text", text: "Here they are" }],
        },
      },
    ])
    expect(
      AosSessionResumeResponseMetaSchema.parse(aosMetaOf(resumed)).execution
        .status
    ).toBe("idle")
    test.close()
  })

  it("replays a stored artifact as a notification naming its message", async () => {
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

    const granted = test.recorder.of(AOS_METHODS.notify.artifact)
    expect(granted).toHaveLength(1)
    expect(AosArtifactNotificationSchema.parse(granted[0]!.params)).toEqual({
      sessionId: SESSION,
      sequence: 0,
      runId: "history",
      messageId: "message-agent",
      artifact,
    })
    test.close()
  })
})
