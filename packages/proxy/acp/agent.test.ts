import {
  client,
  methods,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import {
  INTERACTION_PROTOCOL,
  SESSION_CATALOG_MAX_WINDOW,
  type RuntimeInfo,
  type Session,
  type SessionModelsResponse,
} from "../../protocol"
import {
  ACP_PROTOCOL_VERSION,
  AOS_EXTENSION_VERSION,
  AOS_JSONRPC_ERRORS,
  AOS_METHODS,
  AOS_META_KEY,
  AOS_STOP_REASONS,
  type AosActivityNotification,
} from "../../protocol/acp"
import {
  PendingRequestKind,
  TurnEventKind,
  type PendingRequest,
  type TurnEvent,
} from "../core/events"
import type {
  RuntimeInstance,
  ServerTurnEngine,
  ServerTurnHandle,
  ServerRuntime,
  SessionPatch,
  SessionScope,
} from "../core/runtime"
import { AttachmentStageRegistry } from "../core/attachment-stages"
import { SessionCoordinator } from "../core/session-coordinator"
import { createSessionRows } from "../core/session-rows"
import { createAosAcpAgent } from "./agent"
import type {
  AcpConnectionContext,
  AcpOutbound,
  GuestPolicy,
  Translators,
} from "./types"

const AGENT = "researcher"
const PRINCIPAL = "operator"
const CONNECTION = "connection-1"
const SESSION = "session-1"
const CREATED = "session-created"
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
    sessionPin: AVAILABLE,
    sessionDeletion: AVAILABLE,
    sessionTurn: AVAILABLE,
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
    todos: { status: "unavailable", reason: "todos-unavailable" },
    activity: { status: "unavailable", reason: "activity-unavailable" },
  },
  interactions: {
    steering: {
      status: "available",
      scope: "active-turn",
      semantics: "visible-user-message",
      input: "text",
      fallback: "provider-queue",
    },
    approvals: {
      status: "available",
      protocol: INTERACTION_PROTOCOL,
      scope: "turn",
      choices: [{ value: "once", scope: "request" }],
      maxPending: 1,
    },
    questions: {
      status: "available",
      protocol: INTERACTION_PROTOCOL,
      scope: "turn",
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
  breakdown: { systemTokens: 300, toolTokens: 400, messageTokens: 500 },
}

/** One provider run segment the test drives event by event. */
class EventSource implements ServerTurnHandle {
  readonly #values: TurnEvent[] = []
  readonly #waiters: Array<(value: IteratorResult<TurnEvent>) => void> = []
  readonly stop = vi.fn(async () => "stopping" as const)
  readonly steer = vi.fn(async () => "steered" as const)
  readonly settled: Promise<void>
  #resolveSettled!: () => void
  #closed = false

  constructor() {
    this.settled = new Promise((resolve) => {
      this.#resolveSettled = resolve
    })
  }

  readonly events: AsyncIterable<TurnEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const value = this.#values.shift()
        if (value) return Promise.resolve({ done: false, value })
        if (this.#closed)
          return Promise.resolve({ done: true, value: undefined })
        return new Promise<IteratorResult<TurnEvent>>((resolve) =>
          this.#waiters.push(resolve)
        )
      },
    }),
  }

  emit(event: TurnEvent) {
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

type RequestOutbound = Extract<
  AcpOutbound,
  { kind: "request-permission" | "elicitation" }
>

function permissionOutbound(request: PendingRequest): RequestOutbound {
  return {
    kind: "request-permission",
    requestId: request.requestId,
    request: {
      title: request.message ?? "",
      options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
      _meta: { [AOS_META_KEY]: { requestId: request.requestId } },
    },
  }
}

/** Deterministic stand-ins for the translator lane's pure projections. */
const translators: Translators = {
  translateTurnEvent(state, event, context) {
    const meta = {
      _meta: {
        [AOS_META_KEY]: { sequence: context.sequence, turnId: context.turnId },
      },
    }
    if (event.kind === TurnEventKind.TurnStarted)
      return {
        state,
        outbound: [
          {
            kind: "update",
            update: {
              sessionUpdate: "state_update",
              state: "running",
              ...meta,
            },
          },
        ],
      }
    if (event.kind === TurnEventKind.MessageChunk)
      return {
        state: { ...state, messageId: event.messageId },
        outbound: [
          {
            kind: "update",
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: event.messageId,
              content: { type: "text", text: event.text },
              ...meta,
            },
          },
        ],
      }
    if (event.kind === TurnEventKind.TurnFailed)
      return {
        state,
        outbound: [
          {
            kind: "update",
            update: {
              sessionUpdate: "state_update",
              state: "idle",
              stopReason: AOS_STOP_REASONS.uncertain,
              // As the real translator does, the failure itself travels with
              // the state it settled, which is what the attachment logs.
              _meta: {
                [AOS_META_KEY]: {
                  ...meta._meta[AOS_META_KEY],
                  ...(event.code ? { code: event.code } : {}),
                  message: event.message,
                },
              },
            },
          },
        ],
      }
    if (event.kind === TurnEventKind.TurnRequiresAction)
      return { state, outbound: event.requests.map(permissionOutbound) }
    if (event.kind === TurnEventKind.TurnEnded)
      return {
        state,
        outbound: [
          {
            kind: "update",
            update: {
              sessionUpdate: "state_update",
              state: "idle",
              stopReason: context.stopping ? "cancelled" : "end_turn",
              ...meta,
            },
          },
        ],
      }
    if (event.kind === TurnEventKind.SteerAccepted)
      return {
        state,
        outbound: [
          {
            kind: "steer-accepted",
            turnId: context.turnId,
            requestId: event.requestId,
            text: event.text,
            delivery: event.delivery,
          },
        ],
      }
    return { state, outbound: [] }
  },
  // The from-start resume paths read this count; this harness replays none.
  persistedCorrections: () => 0,
  translateHistory: (history) =>
    history.messages.map((message) => ({
      kind: "update",
      update: {
        sessionUpdate: "agent_message",
        messageId: message.id,
        content: [{ type: "text", text: `replay:${message.id}` }],
      },
    })),
  pendingRequestToOutbound: (request) => permissionOutbound(request),
  replyFromPermission: (request, response) => ({
    requestId: request.requestId,
    status: "resolved",
    payload: response.outcome,
  }),
  replyFromElicitation: (request) => ({
    requestId: request.requestId,
    status: "resolved",
  }),
  configOptionsOf: (models) => [
    {
      type: "select",
      configId: "model",
      name: "Model",
      currentValue: models.selectedId,
      options: models.options.map(({ id, label }) => ({
        value: id,
        name: label,
      })),
    },
  ],
  configWriteOf: (configId, value) =>
    configId === "model" && typeof value === "string"
      ? { selectedId: value }
      : undefined,
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

const unsupported = () => {
  throw new Error("The ACP agent test does not exercise this operation")
}

const PatchSchema = z.object({
  title: z.string().optional(),
  archived: z.boolean().optional(),
  unread: z.boolean().optional(),
  pinned: z.boolean().optional(),
})

const ModelPatchSchema = z.object({
  selectedId: z.string().optional(),
  effortId: z.string().optional(),
})

/** A redeemed-invitation lane with nothing granted, for the guest guards. */
const GUEST_POLICY: GuestPolicy = {
  authenticate: async () => undefined,
  grant: () => undefined,
  project: {
    access: (base) => base,
    history: (value) => value,
    capabilities: (value) => value,
    permissionReply: (_request, reply) => reply,
  },
  expire: () => () => undefined,
}

type HarnessOptions = {
  rows?: Session[]
  /** Runs the connection on the guest lane instead of the operator lane. */
  guest?: boolean
  total?: number
  activity?: AosActivityNotification[]
  permission?: (params: unknown) => Promise<RequestPermissionResponse>
  discover?: ServerTurnEngine["discover"]
  /** Defaults to a readable window; a rejection stands for one that is not. */
  context?: ServerRuntime["context"]
  /** Runs before each model catalog read; a slow one stands for a real provider. */
  beforeModels?: () => Promise<void>
}

async function harness(options: HarnessOptions = {}) {
  const sources: EventSource[] = []
  const start = vi.fn(async () => {
    const source = new EventSource()
    sources.push(source)
    return source
  })
  const recover = vi.fn(async () => sources.at(-1) ?? new EventSource())
  const discover = vi.fn(options.discover ?? (async () => undefined))
  const engine: ServerTurnEngine = { start, recover, discover }
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
  let models: SessionModelsResponse = MODELS

  const listAllSessions = vi.fn(async (limit: number, offset: number) => ({
    sessions: [...rows.values()],
    total: options.total ?? rows.size,
    limit,
    offset,
  }))
  const getSession = vi.fn(async (_agentId: string, sessionId: string) => {
    const row = rows.get(sessionId)
    if (!row) throw new Error("not found")
    return row
  })
  const updateSession = vi.fn(
    async (_agentId: string, sessionId: string, patch: SessionPatch) => {
      const current = rows.get(sessionId)
      if (current)
        rows.set(sessionId, { ...current, ...PatchSchema.parse(patch) })
    }
  )
  const deleteSession = vi.fn(async (_agentId: string, sessionId: string) => {
    rows.delete(sessionId)
  })
  const updateModel = vi.fn(
    async (_agentId: string, _sessionId: string, patch: unknown) => {
      models = { ...models, ...ModelPatchSchema.parse(patch) }
      return { selectedId: models.selectedId }
    }
  )
  const history = vi.fn(async (_agentId: string, sessionId: string) => ({
    sessionId,
    messages: [
      {
        id: "message-1",
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "Earlier" }],
        createdAt: NOW,
      },
    ],
    total: 1,
    limit: 500,
    offset: 0,
    nextOffset: 0,
  }))

  const runtime: ServerRuntime = {
    turns: engine,
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
    updateSession,
    deleteSession,
    workspaceCapabilities: async () => CAPABILITIES,
    models: async () => {
      await options.beforeModels?.()
      return models
    },
    updateModel,
    context: options.context ?? (async () => USAGE),
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

  const readState = {
    focus: vi.fn(),
    blur: vi.fn(),
    onExecution: vi.fn(),
    markRead: vi.fn(async () => undefined),
    close: vi.fn(),
  }
  const presence = {
    set: vi.fn(),
    clear: vi.fn(),
    present: vi.fn(() => false),
    exposed: vi.fn(() => false),
    lastPresentAt: vi.fn(() => undefined),
  }
  const activityListeners = new Set<(event: AosActivityNotification) => void>()
  const activityFeed = {
    snapshot: () => options.activity ?? [],
    subscribe: (listener: (event: AosActivityNotification) => void) => {
      activityListeners.add(listener)
      return () => activityListeners.delete(listener)
    },
    close: vi.fn(),
  }

  const logger = { info: vi.fn(), error: vi.fn() }
  const context: AcpConnectionContext = {
    connectionId: CONNECTION,
    principalId: PRINCIPAL,
    lane: options.guest ? "guest" : "operator",
    runtimeInstance,
    sessionRows: createSessionRows(),
    readState,
    activityFeed,
    translators,
    attachmentStages: new AttachmentStageRegistry(),
    presence,
    logger,
    ...(options.guest ? { guest: GUEST_POLICY } : {}),
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

  const scope: SessionScope = {
    agentId: AGENT,
    sessionId: SESSION,
    threadId: SESSION,
  }

  return {
    agent: connection.agent,
    close: () => connection.close(),
    initialize,
    recorder,
    coordinator,
    scope,
    sources,
    start,
    discover,
    updateSession,
    deleteSession,
    updateModel,
    listAllSessions,
    readState,
    presence,
    rows,
    logger,
    /** Every structured line the connection wrote, whatever its level. */
    logged: () =>
      [...logger.info.mock.calls, ...logger.error.mock.calls].map(
        ([value]) => value
      ),
    /** Registers the Agent that owns the seeded Sessions, as a roster read does. */
    list: () => connection.agent.request(methods.agent.session.list, {}),
    create: () =>
      connection.agent.request(methods.agent.session.new, {
        cwd: "/",
        _meta: {
          [AOS_META_KEY]: { agentId: AGENT },
        },
      }),
    publishActivity(event: AosActivityNotification) {
      for (const listener of activityListeners) listener(event)
    },
  }
}

function turnStarted(): TurnEvent {
  return { kind: TurnEventKind.TurnStarted }
}

function updates(recorder: ReturnType<typeof createRecorder>) {
  return recorder.of(methods.client.session.update).map((entry) => entry.params)
}

/** Every catalog relist this connection has asked the client for. */
function relists(recorder: ReturnType<typeof createRecorder>) {
  return recorder.of(AOS_METHODS.notify.catalogInvalidated)
}

/** Every context reading this connection has pushed, newest last. */
function usages(recorder: ReturnType<typeof createRecorder>) {
  return updates(recorder).filter((update) =>
    JSON.stringify(update).includes("usage_update")
  )
}

/** The newest reading, once the connection has pushed `count` of them. */
async function usageOf(
  test: { recorder: ReturnType<typeof createRecorder> },
  count = 1
) {
  await test.recorder.wait(() => usages(test.recorder).length >= count)
  return usages(test.recorder).at(-1)
}

/**
 * A provider whose window only becomes readable on the given attempt, which is
 * how a cold Session answers while its agent is still being built. `Infinity`
 * stands for one that never becomes readable.
 */
function coldWindow(readableAttempt: number): ServerRuntime["context"] {
  let attempts = 0
  return async () => {
    attempts += 1
    if (attempts < readableAttempt) throw new Error("no window")
    return USAGE
  }
}

/**
 * Fakes only the timers a deferred usage report uses, so the in-process ACP
 * connection and the test runner keep their own clocks.
 */
function useUsageTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
}

describe("AOS ACP agent", () => {
  it("reports the AOS extension contract on initialize", async () => {
    const test = await harness()

    expect(test.initialize).toMatchObject({
      protocolVersion: ACP_PROTOCOL_VERSION,
      info: { name: "aos-proxy", title: "Hermes" },
      capabilities: { session: { delete: {}, prompt: { image: {} } } },
      authMethods: [],
      _meta: {
        [AOS_META_KEY]: {
          version: AOS_EXTENSION_VERSION,
          lane: "operator",
          extensions: { steer: true, focus: true, guestProjection: false },
        },
      },
    })
    test.close()
  })

  it("creates a Session and pushes its commands and context usage", async () => {
    const test = await harness()

    const created = await test.create()

    expect(created).toMatchObject({
      sessionId: CREATED,
      configOptions: [{ configId: "model", currentValue: "sonnet" }],
      _meta: {
        [AOS_META_KEY]: {
          session: { agentId: AGENT, status: "idle", archived: false },
          capabilities: {
            workspace: { slashCommands: { commands: [{ name: "plan" }] } },
          },
        },
      },
    })
    await test.recorder.wait(
      (entry) =>
        entry.method === methods.client.session.update &&
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
        update: {
          sessionUpdate: "usage_update",
          used: 1_200,
          size: 20_000,
          // ACP carries the counts; the provider's attribution of them and how
          // it arrived at them travel in the AOS extension's own meta.
          _meta: {
            [AOS_META_KEY]: {
              source: "provider-usage",
              breakdown: {
                systemTokens: 300,
                toolTokens: 400,
                messageTokens: 500,
              },
            },
          },
        },
      },
    ])
    test.close()
  })

  it("pages the Session list with an opaque cursor", async () => {
    const test = await harness({
      rows: [sessionRow(), sessionRow({ id: "session-2", unread: true })],
      total: 5,
    })

    const page = await test.list()

    expect(page).toMatchObject({
      sessions: [
        {
          sessionId: SESSION,
          cwd: "/",
          title: "Notes",
          _meta: { [AOS_META_KEY]: { agentId: AGENT, status: "idle" } },
        },
        {
          sessionId: "session-2",
          _meta: { [AOS_META_KEY]: { unread: true } },
        },
      ],
      nextCursor: expect.any(String) as string,
    })
    const cursor = z.object({ nextCursor: z.string() }).parse(page).nextCursor
    await test.agent.request(methods.agent.session.list, { cursor })
    expect(test.listAllSessions).toHaveBeenLastCalledWith(50, 2)
    test.close()
  })

  it("replays history, attaches the live run, and reports its state", async () => {
    const test = await harness()
    await test.list()
    // A run this connection did not start: the coordinator owns it already.
    await test.coordinator.start(
      test.scope,
      { turnId: "run-live", messageId: "message-0", prompt: "Go" },
      {
        subscriberId: "rest",
        controllerId: "operator",
        lane: "operator",
        canControl: true,
      }
    )
    test.sources[0]?.emit(turnStarted())

    const resumed = await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
    })

    expect(resumed).toMatchObject({
      configOptions: [{ configId: "model" }],
      _meta: {
        [AOS_META_KEY]: {
          session: { agentId: AGENT, status: "running" },
          execution: { status: "running", turnId: "run-live" },
        },
      },
    })
    expect(updates(test.recorder)[0]).toMatchObject({
      sessionId: SESSION,
      update: { sessionUpdate: "agent_message", messageId: "message-1" },
    })
    const running = await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes('"state":"running"')
    )
    expect(running.params).toMatchObject({
      sessionId: SESSION,
      update: {
        sessionUpdate: "state_update",
        state: "running",
        _meta: { [AOS_META_KEY]: { turnId: "run-live" } },
      },
    })
    test.sources[0]?.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "Live",
    })
    const streamed = await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes("Live")
    )
    expect(streamed.params).toMatchObject({
      sessionId: SESSION,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "Live" },
      },
    })
    test.close()
  })

  it("acknowledges a prompt before the turn starts and streams it to idle", async () => {
    const test = await harness()
    await test.create()

    const accepted = await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Summarize" }],
      _meta: { [AOS_META_KEY]: {} },
    })

    const messageId = z
      .object({ _meta: z.object({ aos: z.object({ messageId: z.string() }) }) })
      .parse(accepted)._meta.aos.messageId
    expect(messageId).toHaveLength(36)
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    expect(test.start.mock.calls[0]?.[0]).toMatchObject({ threadId: CREATED })
    expect(test.start.mock.calls[0]?.[1]).toMatchObject({
      messageId,
      prompt: "Summarize",
    })
    const source = test.sources[0]
    source?.emit(turnStarted())
    source?.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "Done",
    })
    source?.emit({ kind: TurnEventKind.TurnEnded })

    await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes("end_turn")
    )
    // `session/new` and the settled turn each push usage out of band: the turn
    // grew the window, so the composer is owed the reading it left behind.
    await usageOf(test, 2)
    expect(
      updates(test.recorder).filter(
        (update) => !JSON.stringify(update).includes("usage_update")
      )
    ).toMatchObject([
      { update: { sessionUpdate: "available_commands_update" } },
      {
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
          content: { text: "Done" },
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
    test.close()
  })

  it("answers a permission request and starts the reply segment", async () => {
    const test = await harness()
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Delete it" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    const source = test.sources[0]
    source?.emit(turnStarted())
    source?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [
        {
          requestId: "approval-1",
          kind: PendingRequestKind.Permission,
          message: "permission-required",
        },
      ],
    })
    source?.finish()

    const asked = await test.recorder.wait(
      (entry) => entry.method === methods.client.session.requestPermission
    )

    expect(asked.params).toMatchObject({
      sessionId: CREATED,
      title: "permission-required",
      options: [{ optionId: "once", kind: "allow_once" }],
      _meta: { [AOS_META_KEY]: { requestId: "approval-1" } },
    })
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    expect(test.start.mock.calls[1]?.[1]).toMatchObject({
      replies: [
        {
          requestId: "approval-1",
          status: "resolved",
          payload: { outcome: "selected", optionId: "once" },
        },
      ],
    })
    test.close()
  })

  it("reports a stop the provider has not settled, then the cancelled turn", async () => {
    const test = await harness()
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Long job" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    const source = test.sources[0]
    source?.emit(turnStarted())
    await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes('"state":"running"')
    )

    await test.agent.notify(methods.agent.session.cancel, {
      sessionId: CREATED,
    })

    const stopping = await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes("stopping")
    )
    expect(stopping.params).toMatchObject({
      sessionId: CREATED,
      update: {
        sessionUpdate: "state_update",
        state: "running",
        _meta: { [AOS_META_KEY]: { execution: "stopping" } },
      },
    })
    expect(source?.stop).toHaveBeenCalledTimes(1)
    source?.emit({ kind: TurnEventKind.TurnEnded })
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

  it("writes the Session model a config option selects", async () => {
    const test = await harness()
    await test.list()

    const written = await test.agent.request(
      methods.agent.session.setConfigOption,
      { sessionId: SESSION, configId: "model", type: "id", value: "opus" }
    )

    expect(test.updateModel).toHaveBeenCalledWith(AGENT, SESSION, {
      selectedId: "opus",
    })
    expect(written).toMatchObject({
      configOptions: [{ configId: "model", currentValue: "opus" }],
    })
    test.close()
  })

  it("restates context usage after a config option changes the model", async () => {
    const test = await harness()
    await test.list()
    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
    })
    await usageOf(test)

    await test.agent.request(methods.agent.session.setConfigOption, {
      sessionId: SESSION,
      configId: "model",
      type: "id",
      value: "opus",
    })

    // The window's size belongs to the model, so a switch owes a fresh reading.
    await usageOf(test, 2)
    test.close()
  })

  it("reports context usage on resume so a returning composer has a window", async () => {
    const test = await harness()
    await test.list()

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
    })

    expect(await usageOf(test)).toMatchObject({
      sessionId: SESSION,
      update: {
        sessionUpdate: "usage_update",
        used: 1_200,
        size: 20_000,
        _meta: { [AOS_META_KEY]: { source: "provider-usage" } },
      },
    })
    test.close()
  })

  it("writes the resume response before the usage it pushes, however slow the provider reads", async () => {
    // A real provider answers the model catalog in its own time. The browser
    // starts listening for a Session's updates only once the resume response
    // arrives, so a reading that overtakes the response is simply lost.
    const test = await harness({
      beforeModels: () => new Promise((resolve) => setTimeout(resolve, 50)),
    })
    await test.list()

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
    })
    test.recorder.add({ method: "resume-resolved", params: undefined })

    await usageOf(test)
    const order = test.recorder.entries.map((entry) =>
      entry.method === "resume-resolved"
        ? entry.method
        : JSON.stringify(entry.params).includes("usage_update")
          ? "usage_update"
          : undefined
    )
    expect(order.filter(Boolean)).toEqual(["resume-resolved", "usage_update"])
    test.close()
  })

  it("defers the reading a resumed Session cannot take yet", async () => {
    const test = await harness({ context: coldWindow(3) })
    await test.list()
    useUsageTimers()
    try {
      await test.agent.request(methods.agent.session.resume, {
        sessionId: SESSION,
        cwd: "/",
      })

      // The first two reads find a provider still building its agent; the
      // backoff waits 1s and then 2s before the third one succeeds.
      await vi.advanceTimersByTimeAsync(2_999)
      expect(usages(test.recorder)).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
      expect(usages(test.recorder)).toMatchObject([
        {
          sessionId: SESSION,
          update: { sessionUpdate: "usage_update", used: 1_200, size: 20_000 },
        },
      ])

      // One reading settles the report: nothing is pending and nothing repeats.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(usages(test.recorder)).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
      test.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("leaves the last reading standing when the provider cannot report usage", async () => {
    const test = await harness({ context: coldWindow(Infinity) })
    await test.list()
    useUsageTimers()
    try {
      await test.agent.request(methods.agent.session.resume, {
        sessionId: SESSION,
        cwd: "/",
      })
      await vi.advanceTimersByTimeAsync(60_000)

      // An unreadable window is not an outcome the operator is owed a notice
      // about, and no reading is sent rather than one claiming an empty context.
      // The backoff gives up after its budget instead of retrying forever.
      expect(usages(test.recorder)).toEqual([])
      expect(
        test.recorder.of(AOS_METHODS.notify.error).map((entry) => entry.params)
      ).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
      test.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("drops a deferred reading once the client closes the Session", async () => {
    const test = await harness({ context: coldWindow(2) })
    await test.list()
    useUsageTimers()
    try {
      await test.agent.request(methods.agent.session.resume, {
        sessionId: SESSION,
        cwd: "/",
      })
      await vi.advanceTimersByTimeAsync(0)

      await test.agent.request(methods.agent.session.close, {
        sessionId: SESSION,
      })

      // A detached attachment has no client to report a window to, so closing
      // the Session cancels the deferred attempt instead of leaving it pending.
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(usages(test.recorder)).toEqual([])
      test.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("replaces a deferred reading with the one a later trigger takes", async () => {
    const test = await harness({ context: coldWindow(2) })
    await test.list()
    useUsageTimers()
    try {
      await test.agent.request(methods.agent.session.resume, {
        sessionId: SESSION,
        cwd: "/",
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(usages(test.recorder)).toEqual([])

      await test.agent.request(methods.agent.session.setConfigOption, {
        sessionId: SESSION,
        configId: "model",
        type: "id",
        value: "opus",
      })
      await vi.advanceTimersByTimeAsync(0)

      // The model switch takes the reading the resume was still waiting for, so
      // the deferred attempt is cancelled rather than left to report a second.
      expect(usages(test.recorder)).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(usages(test.recorder)).toHaveLength(1)
      test.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("renames a Session and reports the new row", async () => {
    const test = await harness()
    await test.list()

    await test.agent.request(AOS_METHODS.session.update, {
      sessionId: SESSION,
      title: "Renamed",
    })

    expect(test.updateSession).toHaveBeenCalledWith(AGENT, SESSION, {
      title: "Renamed",
    })
    expect(updates(test.recorder)).toMatchObject([
      {
        sessionId: SESSION,
        update: {
          sessionUpdate: "session_info_update",
          title: "Renamed",
          _meta: { [AOS_META_KEY]: { agentId: AGENT, status: "idle" } },
        },
      },
    ])
    test.close()
  })

  it("pins a Session and asks the acting client to relist", async () => {
    const test = await harness()
    await test.list()

    await test.agent.request(AOS_METHODS.session.update, {
      sessionId: SESSION,
      pinned: true,
    })

    expect(test.updateSession).toHaveBeenCalledWith(AGENT, SESSION, {
      pinned: true,
    })
    expect(updates(test.recorder)).toMatchObject([
      {
        sessionId: SESSION,
        update: {
          sessionUpdate: "session_info_update",
          _meta: { [AOS_META_KEY]: { agentId: AGENT, pinned: true } },
        },
      },
    ])
    expect(relists(test.recorder)).toHaveLength(1)
    test.close()
  })

  it("asks for a relist after archiving a Session but not after renaming one", async () => {
    const test = await harness()
    await test.list()

    await test.agent.request(AOS_METHODS.session.update, {
      sessionId: SESSION,
      archived: true,
    })

    expect(test.updateSession).toHaveBeenCalledWith(AGENT, SESSION, {
      archived: true,
    })
    expect(relists(test.recorder)).toHaveLength(1)

    await test.agent.request(AOS_METHODS.session.update, {
      sessionId: SESSION,
      title: "Renamed",
    })

    // A title leaves the catalog's membership and order alone.
    expect(relists(test.recorder)).toHaveLength(1)
    test.close()
  })

  it("marks a Session read through the connection's read state", async () => {
    const test = await harness()
    await test.list()

    await test.agent.request(AOS_METHODS.session.update, {
      sessionId: SESSION,
      unread: false,
    })

    expect(test.readState.markRead).toHaveBeenCalledWith(AGENT, SESSION)
    expect(test.updateSession).not.toHaveBeenCalled()
    test.close()
  })

  it("steers the active run and reports the delivery", async () => {
    const test = await harness()
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Start" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    await vi.waitFor(() =>
      expect(
        test.coordinator.state({ agentId: AGENT, sessionId: CREATED })
      ).toBe("running")
    )

    const steered = await test.agent.request(AOS_METHODS.session.steer, {
      sessionId: CREATED,
      requestId: "steer-1",
      text: "Also check the tests",
    })

    expect(steered).toEqual({ status: "steered" })
    const accepted = await test.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.steerAccepted
    )
    expect(accepted.params).toMatchObject({
      sessionId: CREATED,
      requestId: "steer-1",
      text: "Also check the tests",
      delivery: "steered",
    })
    test.close()
  })

  it("reports Session focus and blur to read state", async () => {
    const test = await harness()
    await test.list()

    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: SESSION })
    await vi.waitFor(() =>
      expect(test.readState.focus).toHaveBeenCalledWith(AGENT, SESSION)
    )
    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: null })
    await vi.waitFor(() => expect(test.readState.blur).toHaveBeenCalled())
    test.close()
  })

  it("records the presence an exposed Session implies", async () => {
    const test = await harness()
    await test.list()

    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: SESSION })

    await vi.waitFor(() =>
      expect(test.presence.set).toHaveBeenCalledWith(PRINCIPAL, CONNECTION, {
        sessionId: SESSION,
        foreground: true,
        idle: false,
      })
    )
    test.close()
  })

  it("records a reported background or idle workspace as reported", async () => {
    const test = await harness()
    await test.list()

    await test.agent.notify(AOS_METHODS.session.focus, {
      sessionId: SESSION,
      foreground: false,
      idle: true,
    })

    await vi.waitFor(() =>
      expect(test.presence.set).toHaveBeenCalledWith(PRINCIPAL, CONNECTION, {
        sessionId: SESSION,
        foreground: false,
        idle: true,
      })
    )
    test.close()
  })

  it("records a foreground workspace showing no Session, and still blurs", async () => {
    const test = await harness()
    await test.list()

    await test.agent.notify(AOS_METHODS.session.focus, {
      sessionId: null,
      foreground: true,
    })

    await vi.waitFor(() =>
      expect(test.presence.set).toHaveBeenCalledWith(PRINCIPAL, CONNECTION, {
        sessionId: null,
        foreground: true,
        idle: false,
      })
    )
    expect(test.readState.blur).toHaveBeenCalled()
    test.close()
  })

  it("acknowledges an exposure once, however often its heartbeat repeats it", async () => {
    const test = await harness()
    await test.list()

    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: SESSION })
    await vi.waitFor(() =>
      expect(test.readState.focus).toHaveBeenCalledWith(AGENT, SESSION)
    )
    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: SESSION })
    await test.agent.notify(AOS_METHODS.session.focus, {
      sessionId: SESSION,
      foreground: true,
      idle: false,
    })

    await vi.waitFor(() => expect(test.presence.set).toHaveBeenCalledTimes(3))
    expect(test.readState.focus).toHaveBeenCalledTimes(1)
    test.close()
  })

  it("forgets this connection's presence when it closes", async () => {
    const test = await harness()
    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: SESSION })
    await vi.waitFor(() => expect(test.presence.set).toHaveBeenCalled())

    test.close()

    await vi.waitFor(() =>
      expect(test.presence.clear).toHaveBeenCalledWith(PRINCIPAL, CONNECTION)
    )
  })

  it("keeps a guest's exposure out of presence and read state", async () => {
    const test = await harness({ guest: true })

    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: SESSION })
    // One round trip after the notification proves the lane has handled it.
    await expect(
      test.agent.request(methods.agent.session.close, { sessionId: SESSION })
    ).rejects.toThrow()

    expect(test.presence.set).not.toHaveBeenCalled()
    expect(test.readState.focus).not.toHaveBeenCalled()
    test.close()
  })

  it("hydrates the connection with the activity snapshot", async () => {
    const event: AosActivityNotification = {
      type: "turn-started",
      agentId: AGENT,
      sessionId: SESSION,
      occurredAt: NOW,
      turnId: "lifecycle-1",
    }
    const test = await harness({ activity: [event] })

    const hydrated = await test.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.activity
    )

    expect(hydrated.params).toEqual(event)
    test.publishActivity({ ...event, turnId: "lifecycle-2" })
    await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes("lifecycle-2")
    )
    test.close()
  })

  it("refuses a prompt while a turn is in progress", async () => {
    const test = await harness()
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "First" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))

    await expect(
      test.agent.request(methods.agent.session.prompt, {
        sessionId: CREATED,
        prompt: [{ type: "text", text: "Second" }],
        _meta: { [AOS_META_KEY]: {} },
      })
    ).rejects.toMatchObject({ code: AOS_JSONRPC_ERRORS.turnInProgress })
    expect(test.start).toHaveBeenCalledTimes(1)
    test.close()
  })

  it("drops a reply for a request the provider no longer holds", async () => {
    const answer = Promise.withResolvers<RequestPermissionResponse>()
    const test = await harness({ permission: () => answer.promise })
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Delete it" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    const source = test.sources[0]
    source?.emit(turnStarted())
    source?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [
        {
          requestId: "approval-1",
          kind: PendingRequestKind.Permission,
          message: "permission-required",
        },
      ],
    })
    source?.finish()
    await test.recorder.wait(
      (entry) => entry.method === methods.client.session.requestPermission
    )

    // The provider authoritatively clears the recovered wait.
    await test.agent.request(methods.agent.session.resume, {
      sessionId: CREATED,
      cwd: "/",
    })
    expect(test.discover).toHaveBeenCalled()
    answer.resolve({ outcome: { outcome: "selected", optionId: "once" } })

    const failed = await test.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.error
    )
    expect(failed.params).toMatchObject({
      sessionId: CREATED,
      code: "stale_request",
    })
    expect(test.logged()).toContainEqual({
      event: "acp.error",
      connectionId: "connection-1",
      sessionId: CREATED,
      errorCode: "stale_request",
      message: "stale_request",
    })
    expect(test.start).toHaveBeenCalledTimes(1)
    test.close()
  })

  it("reports nothing for a browser that left with a request outstanding", async () => {
    // A server→client request the operator never answered rejects when the tab
    // carrying it closes. That is the operator moving on, not a failure this
    // deployment has to answer for, and reporting it as one buries the failures
    // that are real.
    const answer = Promise.withResolvers<RequestPermissionResponse>()
    const test = await harness({ permission: () => answer.promise })
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Delete it" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    const source = test.sources[0]
    source?.emit(turnStarted())
    source?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [
        {
          requestId: "approval-1",
          kind: PendingRequestKind.Permission,
          message: "permission-required",
        },
      ],
    })
    source?.finish()
    await test.recorder.wait(
      (entry) => entry.method === methods.client.session.requestPermission
    )

    test.close()
    // Long enough for the abandoned request to reject and settle its handlers.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(test.logged()).not.toContainEqual(
      expect.objectContaining({ event: "acp.error" })
    )
  })

  it("logs the connection, the Stop it received, and the reply it settled", async () => {
    const test = await harness()
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Delete it" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    const source = test.sources[0]
    source?.emit(turnStarted())
    source?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [
        {
          requestId: "approval-1",
          kind: PendingRequestKind.Permission,
          message: "permission-required",
        },
      ],
    })
    source?.finish()
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))

    await test.agent.notify(methods.agent.session.cancel, {
      sessionId: CREATED,
    })
    await vi.waitFor(() =>
      expect(test.logged()).toContainEqual({
        event: "acp.turn.cancel",
        connectionId: "connection-1",
        lane: "operator",
        sessionId: CREATED,
      })
    )

    expect(test.logged()).toContainEqual({
      event: "acp.connection.opened",
      connectionId: "connection-1",
      lane: "operator",
    })
    expect(test.logged()).toContainEqual({
      event: "acp.request.answered",
      connectionId: "connection-1",
      sessionId: CREATED,
      requestId: "approval-1",
      status: "resolved",
    })

    test.close()
    await vi.waitFor(() =>
      expect(test.logged()).toContainEqual({
        event: "acp.connection.closed",
        connectionId: "connection-1",
        lane: "operator",
      })
    )
  })

  it("logs the code and message a failed run reported, not only its class", async () => {
    const test = await harness()
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Long job" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    const source = test.sources[0]
    source?.emit(turnStarted())
    source?.emit({
      kind: TurnEventKind.TurnFailed,
      message: "the transport dropped",
      code: "AOS_CONNECTION_INTERRUPTED",
    })
    source?.finish()

    // The proxy mints the run id the browser sees, so the line reports that one.
    await vi.waitFor(() =>
      expect(test.logged()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "acp.turn.failed",
            connectionId: "connection-1",
            sessionId: CREATED,
            stopReason: AOS_STOP_REASONS.uncertain,
            errorCode: "AOS_CONNECTION_INTERRUPTED",
            message: "the transport dropped",
            turnId: expect.any(String),
          }),
        ])
      )
    )
    test.close()
  })
})
