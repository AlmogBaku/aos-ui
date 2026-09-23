import {
  client,
  methods,
  type ContentBlock,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
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
  AOS_EXTENSION_VERSION,
  AOS_ATTACHMENT_URI_SCHEME,
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
import { createSessionRooms } from "./session-rooms"
import type {
  AcpConnectionContext,
  AcpOutbound,
  GuestGrant,
  GuestPolicy,
  Translators,
} from "./types"
import { invalidRequest } from "./validation"

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
    mcpApps: { status: "unavailable", reason: "mcp-apps-unavailable" },
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
              // the state it settled, which is what the member logs.
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
    turn: () => undefined,
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
  /** Stands for a provider with no catalog change signal. */
  withoutCatalogChanges?: boolean
  /**
   * Runs as the provider admits each turn, before its handle returns: holding
   * it holds the admission, and throwing refuses the turn.
   */
  onStart?: (source: EventSource) => void | Promise<void>
  /** The replayed page's messages; defaults to one earlier assistant reply. */
  history?: SessionHistoryResponse["messages"]
  /** Gives provider Sessions ids of their own, as a real runtime does. */
  providerIds?: boolean
}

async function harness(options: HarnessOptions = {}) {
  const sources: EventSource[] = []
  const start = vi.fn(async () => {
    const source = new EventSource()
    sources.push(source)
    await options.onStart?.(source)
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
  // A provider id is the public one behind a prefix, so either maps to the other.
  const providerId = (publicId: string) =>
    options.providerIds ? `provider-${publicId}` : publicId
  const publicId = (sessionId: string) =>
    options.providerIds ? sessionId.replace(/^provider-/u, "") : sessionId
  let models: SessionModelsResponse = MODELS

  const listAllSessions = vi.fn(async (limit: number, offset: number) => ({
    sessions: [...rows.values()],
    total: options.total ?? rows.size,
    limit,
    offset,
  }))
  const getSession = vi.fn(async (_agentId: string, sessionId: string) => {
    const row = rows.get(publicId(sessionId))
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
    messages: options.history ?? [
      {
        id: "message-1",
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "Earlier" }],
        createdAt: NOW,
      },
    ],
    total: (options.history ?? [undefined]).length,
    limit: 500,
    offset: 0,
    nextOffset: 0,
  }))

  const runtime: ServerRuntime = {
    turns: engine,
    // Every invitation in this harness addresses the seeded Session.
    resolveInvitedSession: async () => ({
      sessionId: providerId(SESSION),
      created: false,
    }),
    resolveSessionId: (_agentId, publicSessionId) =>
      providerId(publicSessionId),
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
    ...(options.withoutCatalogChanges
      ? {}
      : { subscribeCatalogChanges: async () => () => undefined }),
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
  // One lane's connections share its row cache, as the operator lane's do.
  const sessionRows = createSessionRows()
  const rooms = createSessionRooms({
    snapshot: (roomScope) => coordinator.snapshot(roomScope),
  })

  /**
   * One browser connection to the proxy. Every connection shares the one
   * coordinator, engine, and room registry, as one deployment's lanes do.
   */
  async function connect(
    connectionId: string,
    lane: {
      guest?: GuestPolicy
      /** This browser's answer to a permission request, if not the harness's. */
      permission?: HarnessOptions["permission"]
    } = {}
  ) {
    const attachmentStages = new AttachmentStageRegistry()
    const permission = lane.permission ?? options.permission
    const context: AcpConnectionContext = {
      connectionId,
      principalId: PRINCIPAL,
      lane: lane.guest ? "guest" : "operator",
      runtimeInstance,
      sessionRows,
      readState,
      activityFeed,
      translators,
      attachmentStages,
      rooms,
      presence,
      logger,
      ...(lane.guest ? { guest: lane.guest } : {}),
    }

    const recorder = createRecorder()
    const clientApp = client({ name: "aos-browser" })
      .onNotification(methods.client.session.update, ({ params }) => {
        recorder.add({ method: methods.client.session.update, params })
      })
      .onRequest(
        methods.client.session.requestPermission,
        async ({ params }) => {
          recorder.add({
            method: methods.client.session.requestPermission,
            params,
          })
          return (
            (await permission?.(params)) ?? {
              outcome: { outcome: "selected", optionId: "once" },
            }
          )
        }
      )
    for (const method of Object.values(AOS_METHODS.notify))
      clientApp.onNotification(
        method,
        (params) => params,
        ({ params }) => {
          recorder.add({ method, params })
        }
      )

    const connection = clientApp.connect(createAosAcpAgent(context))
    const initialize = await connection.agent.request(
      methods.agent.initialize,
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        info: { name: "aos-browser", version: "1" },
        capabilities: {},
      }
    )
    return {
      agent: connection.agent,
      close: () => connection.close(),
      initialize,
      recorder,
      attachmentStages,
      /** Registers the Agent that owns the seeded Sessions, as a roster read does. */
      list: () => connection.agent.request(methods.agent.session.list, {}),
      create: () =>
        connection.agent.request(methods.agent.session.new, {
          cwd: "/",
          _meta: {
            [AOS_META_KEY]: { agentId: AGENT },
          },
        }),
    }
  }

  const primary = await connect(
    CONNECTION,
    options.guest ? { guest: GUEST_POLICY } : {}
  )

  const scope: SessionScope = {
    agentId: AGENT,
    sessionId: providerId(SESSION),
    threadId: SESSION,
  }

  return {
    ...primary,
    connect,
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
          extensions: {
            steer: true,
            focus: true,
            invalidation: true,
            guestProjection: false,
          },
        },
      },
    })
    test.close()
  })

  it("advertises no catalog invalidation for a runtime that cannot signal one", async () => {
    const test = await harness({ withoutCatalogChanges: true })

    expect(test.initialize).toMatchObject({
      _meta: {
        [AOS_META_KEY]: {
          extensions: { invalidation: false, steer: true, readState: true },
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

  it("offers no cursor past the catalog window", async () => {
    const test = await harness({ rows: [sessionRow()], total: 5_000 })

    const page = await test.agent.request(methods.agent.session.list, {
      cursor: Buffer.from("999").toString("base64url"),
    })

    expect(page).not.toHaveProperty("nextCursor")
    test.close()
  })

  it("replays history, joins the live run, and reports its state", async () => {
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

      // A left member has no client to report a window to, so closing
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

type Recorder = ReturnType<typeof createRecorder>
type Browser = Pick<Awaited<ReturnType<typeof harness>>, "agent" | "recorder">

/**
 * What one browser shows of a Session, in order: replayed rows, prompts, and
 * the turn stream. Usage, commands, and row updates are left out.
 */
function flow(recorder: Recorder, sessionId = SESSION, from = 0) {
  return recorder.entries.slice(from).flatMap(({ method, params }) => {
    if (method !== methods.client.session.update) return []
    const { sessionId: target, update } = params as {
      sessionId: string
      update: Record<string, unknown>
    }
    if (target !== sessionId) return []
    switch (update.sessionUpdate) {
      case "agent_message":
        return [`history ${String(update.messageId)}`]
      case "user_message":
        return [`prompt ${String(update.messageId)}`]
      case "state_update":
        return [`state ${String(update.state)}`]
      case "agent_message_chunk":
        return [`chunk ${(update.content as { text: string }).text}`]
      default:
        return []
    }
  })
}

/** The content of every `user_message` one browser received for a Session. */
function prompts(recorder: Recorder, sessionId = SESSION) {
  return updates(recorder).flatMap((params) => {
    const { sessionId: target, update } = params as {
      sessionId: string
      update: { sessionUpdate: string; content?: unknown }
    }
    return target === sessionId && update.sessionUpdate === "user_message"
      ? [update.content]
      : []
  })
}

/** Sends one prompt and returns the user message id the proxy minted. */
async function prompt(
  browser: Browser,
  content: string | ContentBlock[],
  sessionId = SESSION,
  meta: Record<string, unknown> = {}
) {
  const accepted = await browser.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt:
      typeof content === "string" ? [{ type: "text", text: content }] : content,
    _meta: { [AOS_META_KEY]: meta },
  })
  return z
    .object({ _meta: z.object({ aos: z.object({ messageId: z.string() }) }) })
    .parse(accepted)._meta.aos.messageId
}

/** Opens a Session and waits for the execution report its resume owes. */
async function open(
  browser: Browser,
  params: Partial<ResumeSessionRequest> = {}
) {
  const from = browser.recorder.entries.length
  await browser.agent.request(methods.agent.session.resume, {
    sessionId: SESSION,
    cwd: "/",
    ...params,
  })
  await browser.recorder.wait(
    (entry) =>
      browser.recorder.entries.indexOf(entry) >= from &&
      JSON.stringify(entry.params).includes("state_update")
  )
}

/** Streams one reply on a provider segment and ends its turn. */
function reply(source: EventSource | undefined, text: string) {
  source?.emit(turnStarted())
  source?.emit({
    kind: TurnEventKind.MessageChunk,
    messageId: "assistant-1",
    text,
  })
  source?.emit({ kind: TurnEventKind.TurnEnded })
}

/** Lets the follow-ups a response schedules for the next task run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 10))

/**
 * Streams one reply, ending its turn only once every watcher saw it live: a
 * browser the room brings in late must still find the turn running.
 */
async function replyWhileWatched(
  source: EventSource | undefined,
  text: string,
  watchers: readonly Browser[]
) {
  source?.emit(turnStarted())
  source?.emit({
    kind: TurnEventKind.MessageChunk,
    messageId: "assistant-1",
    text,
  })
  for (const { recorder } of watchers)
    await recorder.wait((entry) => JSON.stringify(entry.params).includes(text))
  source?.emit({ kind: TurnEventKind.TurnEnded })
  for (const { recorder } of watchers) await recorder.wait(endedTurn)
}

const endedTurn = (entry: Recorded) =>
  JSON.stringify(entry.params).includes("end_turn")

/** A held step a test releases when the scenario needs it to go on. */
function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { held: promise, release: () => resolve() }
}

const GUEST_REF = "guest-ref"

/** A redeemed invitation to the seeded Session, marking what it projects. */
function invitedGuest(denied?: string): GuestPolicy {
  const grant: GuestGrant = {
    agentId: AGENT,
    ref: GUEST_REF,
    principalId: "guest-1",
    expiresAt: Number.MAX_SAFE_INTEGER,
  }
  return {
    ...GUEST_POLICY,
    grant: () => grant,
    project: {
      ...GUEST_POLICY.project,
      // As the real guest projection does, a guest controls what it follows.
      access: (base) => ({ ...base, canControl: true }),
      turn: (text) => (text === denied ? undefined : `projected ${text}`),
    },
  }
}

const APPROVAL: PendingRequest = {
  requestId: "approval-1",
  kind: PendingRequestKind.Permission,
  message: "permission-required",
}

describe("Session rooms", () => {
  it("shows an open Session another browser's prompt, then its stream", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    const from = other.recorder.entries.length

    const messageId = await prompt(test, "Summarize")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    await replyWhileWatched(test.sources[0], "Done", [other, test])

    const turn = [
      `prompt ${messageId}`,
      "state running",
      "chunk Done",
      "state idle",
    ]
    expect(flow(other.recorder, SESSION, from)).toEqual(turn)
    expect(flow(test.recorder)).toEqual(turn)
    expect(prompts(other.recorder)).toEqual([
      [{ type: "text", text: "Summarize" }],
    ])
    test.close()
    other.close()
  })

  it("shows nobody a prompt the provider refused", async () => {
    const test = await harness({
      providerIds: true,
      onStart: () => {
        throw new Error("refused")
      },
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)

    await prompt(test, "Summarize")
    await test.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.error
    )
    const late = await test.connect("connection-3")
    await late.list()
    await open(late)

    expect(prompts(other.recorder)).toEqual([])
    expect(prompts(late.recorder)).toEqual([])
    test.close()
    other.close()
    late.close()
  })

  it("lets another operator browser stop the turn", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    await prompt(test, "Long job")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    await other.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes('"state":"running"')
    )

    await other.agent.notify(methods.agent.session.cancel, {
      sessionId: SESSION,
    })

    await vi.waitFor(() => expect(test.sources[0]?.stop).toHaveBeenCalledOnce())
    test.close()
    other.close()
  })

  it("asks every browser, takes the first answer, and streams the rest to all", async () => {
    const late = gate()
    const test = await harness({ providerIds: true })
    await test.list()
    const other = await test.connect("connection-2", {
      permission: async () => {
        await late.held
        return { outcome: { outcome: "selected", optionId: "once" } }
      },
    })
    await other.list()
    await open(other)
    await prompt(test, "Delete it")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [APPROVAL],
    })
    test.sources[0]?.finish()
    const asked = (entry: Recorded) =>
      entry.method === methods.client.session.requestPermission
    await other.recorder.wait(asked)
    await test.recorder.wait(asked)

    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    await replyWhileWatched(test.sources[1], "Resumed", [other])
    expect(flow(other.recorder)).toContain("chunk Resumed")

    late.release()
    const refused = await other.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.error
    )
    expect(refused.params).toMatchObject({ code: "stale_request" })
    expect(test.start).toHaveBeenCalledTimes(2)
    test.close()
    other.close()
  })

  it("refuses the second of two answers given at once as a turn conflict", async () => {
    const admission = gate()
    const test = await harness({
      providerIds: true,
      // The reply segment's admission is held until the losing answer lands.
      onStart: async () => {
        if (test.start.mock.calls.length > 1) await admission.held
      },
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    await prompt(test, "Delete it")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [APPROVAL],
    })
    test.sources[0]?.finish()

    const failed = (entry: Recorded) =>
      entry.method === AOS_METHODS.notify.error
    await Promise.race([
      test.recorder.wait(failed),
      other.recorder.wait(failed),
    ])
    admission.release()
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    await replyWhileWatched(test.sources[1], "Resumed", [test, other])

    const errors = [
      ...test.recorder.of(AOS_METHODS.notify.error),
      ...other.recorder.of(AOS_METHODS.notify.error),
    ].map(({ params }) => params)
    expect(errors).toEqual([
      expect.objectContaining({ code: "turn_in_progress" }),
    ])
    expect(flow(test.recorder)).toContain("chunk Resumed")
    expect(flow(other.recorder)).toContain("chunk Resumed")
    test.close()
    other.close()
  })

  it("joins a live turn with its history, then its prompt, then its stream", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const messageId = await prompt(test, "Summarize")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "Live",
    })
    await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes("Live")
    )

    const other = await test.connect("connection-2")
    await other.list()
    await open(other, { replayFrom: { type: "start" } })
    await other.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes("Live")
    )

    const seen = flow(other.recorder)
    expect(seen.slice(0, 3)).toEqual([
      "history message-1",
      `prompt ${messageId}`,
      "state running",
    ])
    expect(seen.filter((item) => item.startsWith("prompt"))).toHaveLength(1)
    expect(seen.filter((item) => item === "chunk Live")).toHaveLength(1)
    test.close()
    other.close()
  })

  it("adds no prompt a replayed history already ends with", async () => {
    const test = await harness({
      providerIds: true,
      history: [
        {
          id: "user-1",
          role: "user",
          content: [{ type: "text", text: " Summarize " }],
          createdAt: NOW,
        },
        {
          id: "assistant-0",
          role: "assistant",
          content: [{ type: "text", text: "Working" }],
          createdAt: NOW,
        },
      ],
    })
    await test.list()
    await prompt(test, "Summarize")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())

    const other = await test.connect("connection-2")
    await other.list()
    await open(other, { replayFrom: { type: "start" } })
    test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded })
    await other.recorder.wait(endedTurn)

    expect(prompts(other.recorder)).toEqual([])
    expect(flow(other.recorder).slice(0, 2)).toEqual([
      "history user-1",
      "history assistant-0",
    ])
    test.close()
    other.close()
  })

  it("adds no prompt to a resume whose cursor is inside the turn", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    await prompt(test, "Summarize")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes('"state":"running"')
    )
    const { turnId } = test.coordinator.snapshot(test.scope)

    const other = await test.connect("connection-2")
    await other.list()
    await open(other, { _meta: { [AOS_META_KEY]: { turnId, after: 1 } } })
    await replyWhileWatched(test.sources[0], "Done", [other])

    expect(prompts(other.recorder)).toEqual([])
    expect(flow(other.recorder)).toContain("chunk Done")
    test.close()
    other.close()
  })

  it("gives a reconnect without a cursor the prompt once, then the stream", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const messageId = await prompt(test, "Summarize")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())

    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    await replyWhileWatched(test.sources[0], "Done", [other])

    const seen = flow(other.recorder)
    expect(seen.slice(0, 2)).toEqual([`prompt ${messageId}`, "state running"])
    expect(seen.filter((item) => item.startsWith("prompt"))).toHaveLength(1)
    expect(seen).toContain("chunk Done")
    test.close()
    other.close()
  })

  it("invents no prompt for a discovered turn nobody here sent", async () => {
    // A follow without a journal reloads history instead of streaming.
    const test = await harness({
      providerIds: true,
      rows: [sessionRow({ status: "running" })],
      discover: async () => ({ handle: new EventSource(), state: "running" }),
    })
    await test.list()
    await open(test)
    const late = await test.connect("connection-3")
    await late.list()
    await open(late)

    expect(test.coordinator.state(test.scope)).toBe("running")
    expect(prompts(test.recorder)).toEqual([])
    expect(prompts(late.recorder)).toEqual([])
    test.close()
    late.close()
  })

  it("gives a browser that joins while the turn is admitted its prompt once, first", async () => {
    const admission = gate()
    const test = await harness({
      providerIds: true,
      onStart: () => admission.held,
    })
    await test.list()
    const messageId = await prompt(test, "Summarize")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))

    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    const from = other.recorder.entries.length
    admission.release()
    await replyWhileWatched(test.sources[0], "Done", [other])

    expect(flow(other.recorder, SESSION, from)).toEqual([
      `prompt ${messageId}`,
      "state running",
      "chunk Done",
      "state idle",
    ])
    test.close()
    other.close()
  })

  it("lets a losing prompt follow the winner it raced before admission", async () => {
    const admission = gate()
    const test = await harness({
      providerIds: true,
      onStart: () => admission.held,
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    const messageId = await prompt(test, "First")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))

    // The winner is still being admitted, so the loser passes the idle check
    // and loses at the coordinator.
    await prompt(other, "Second")
    const refused = await other.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.error
    )
    expect(refused.params).toMatchObject({ code: "turn_in_progress" })
    admission.release()
    await replyWhileWatched(test.sources[0], "Done", [other])

    const seen = flow(other.recorder)
    expect(seen.filter((item) => item === `prompt ${messageId}`)).toHaveLength(
      1
    )
    expect(seen.indexOf("chunk Done")).toBeGreaterThan(
      seen.indexOf(`prompt ${messageId}`)
    )
    expect(test.start).toHaveBeenCalledTimes(1)
    test.close()
    other.close()
  })

  it("lets a losing prompt follow the winner that was admitted first", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    // The loser passes the idle check, then waits on its staged attachment
    // while the winner is admitted and announced.
    const staged = gate()
    const appendTo = vi.fn(async (text: string) => {
      await staged.held
      return text
    })
    const stageId = other.attachmentStages.create(AGENT, SESSION, {
      public: [],
      appendTo,
      cleanup: async () => undefined,
    })
    const losing = prompt(other, "Second", SESSION, {
      attachmentStageId: stageId,
    })
    await vi.waitFor(() => expect(appendTo).toHaveBeenCalledOnce())
    const messageId = await prompt(test, "First")
    await vi.waitFor(() =>
      expect(test.coordinator.state(test.scope)).toBe("running")
    )

    staged.release()
    await losing
    const refused = await other.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.error
    )
    expect(refused.params).toMatchObject({ code: "turn_in_progress" })
    await replyWhileWatched(test.sources[0], "Done", [other])

    const seen = flow(other.recorder)
    expect(seen.filter((item) => item === `prompt ${messageId}`)).toHaveLength(
      1
    )
    expect(seen.indexOf("chunk Done")).toBeGreaterThan(
      seen.indexOf(`prompt ${messageId}`)
    )
    expect(test.start).toHaveBeenCalledTimes(1)
    test.close()
    other.close()
  })

  it.each([
    ["a browser the room brought in", "other"],
    ["the sender", "test"],
  ] as const)(
    "shows %s the prompt again when it reopens the Session from the start",
    async (_, who) => {
      const test = await harness({ providerIds: true })
      await test.list()
      const other = await test.connect("connection-2")
      await other.list()
      await open(other)
      const messageId = await prompt(test, "Summarize")
      await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
      test.sources[0]?.emit(turnStarted())
      test.sources[0]?.emit({
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "Live",
      })
      const reopening = who === "test" ? test : other
      await reopening.recorder.wait((entry) =>
        JSON.stringify(entry.params).includes("Live")
      )

      // The browser drops its transcript and replays a page that has not
      // persisted the in-flight prompt yet.
      const from = reopening.recorder.entries.length
      await open(reopening, { replayFrom: { type: "start" } })
      test.sources[0]?.emit({
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "More",
      })
      test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded })
      await reopening.recorder.wait(endedTurn)

      expect(flow(reopening.recorder, SESSION, from)).toEqual([
        "history message-1",
        `prompt ${messageId}`,
        "state running",
        "chunk More",
        "state idle",
      ])
      test.close()
      other.close()
    }
  )

  it("replays only history to a browser that joins after the turn ended", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    await prompt(test, "Summarize")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    reply(test.sources[0], "Done")
    await test.recorder.wait(endedTurn)
    await vi.waitFor(() =>
      expect(test.coordinator.state(test.scope)).toBe("idle")
    )

    const other = await test.connect("connection-2")
    await other.list()
    await open(other, { replayFrom: { type: "start" } })

    expect(flow(other.recorder)).toEqual(["history message-1", "state idle"])
    test.close()
    other.close()
  })

  it("brings a resume held on its model read into a turn that started meanwhile", async () => {
    const models = gate()
    const test = await harness({
      providerIds: true,
      beforeModels: () => models.held,
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    const resumed = other.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
    })
    await vi.waitFor(() =>
      expect(test.logged()).toContainEqual(
        expect.objectContaining({ connectionId: "connection-2" })
      )
    )

    const messageId = await prompt(test, "Summarize")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    await replyWhileWatched(test.sources[0], "Done", [other])
    models.release()
    await resumed

    const seen = flow(other.recorder)
    expect(seen.slice(0, 3)).toEqual([
      `prompt ${messageId}`,
      "state running",
      "chunk Done",
    ])
    expect(seen.filter((item) => item.startsWith("prompt"))).toHaveLength(1)
    test.close()
    other.close()
  })

  it("streams each event once to a browser that follows twice at once", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    await prompt(test, "Summarize")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())

    const other = await test.connect("connection-2")
    await other.list()
    await Promise.all([open(other), open(other)])
    await replyWhileWatched(test.sources[0], "Done", [other, test])

    const seen = flow(other.recorder)
    expect(seen.filter((item) => item === "chunk Done")).toHaveLength(1)
    expect(seen.filter((item) => item.startsWith("prompt"))).toHaveLength(1)
    expect(
      flow(test.recorder).filter((item) => item === "chunk Done")
    ).toHaveLength(1)
    test.close()
    other.close()
  })

  it("shows the sender its own prompt once after session/new", async () => {
    const test = await harness({ providerIds: true })
    await test.create()

    const messageId = await prompt(test, "Summarize", CREATED)
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    reply(test.sources[0], "Done")
    await test.recorder.wait(endedTurn)

    expect(flow(test.recorder, CREATED)).toEqual([
      `prompt ${messageId}`,
      "state running",
      "chunk Done",
      "state idle",
    ])
    test.close()
  })

  it("leaves another Session the same browser has open untouched", async () => {
    const test = await harness({
      providerIds: true,
      rows: [sessionRow(), sessionRow({ id: "session-2" })],
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    await open(other, { sessionId: "session-2" })
    const from = other.recorder.entries.length

    await prompt(test, "Summarize")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    await replyWhileWatched(test.sources[0], "Done", [other])

    expect(flow(other.recorder, "session-2", from)).toEqual([])
    expect(prompts(other.recorder)).toHaveLength(1)
    test.close()
    other.close()
  })

  it("shows a guest an operator's prompt as projected text, and lets it Stop", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const guest = await test.connect("guest-connection", {
      guest: invitedGuest(),
    })
    await open(guest, { sessionId: GUEST_REF })
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)

    const messageId = await prompt(test, [
      { type: "text", text: "Summarize" },
      {
        type: "resource_link",
        uri: `${AOS_ATTACHMENT_URI_SCHEME}stage/notes`,
        name: "notes.md",
        mimeType: "text/markdown",
      },
    ])
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "Live",
    })
    await guest.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes("Live")
    )

    expect(flow(guest.recorder, GUEST_REF)).toContain(`prompt ${messageId}`)
    expect(prompts(guest.recorder, GUEST_REF)).toEqual([
      [{ type: "text", text: "projected Summarize" }],
    ])
    expect(prompts(other.recorder)).toEqual([
      [
        { type: "text", text: "Summarize" },
        {
          type: "resource_link",
          uri: `${AOS_ATTACHMENT_URI_SCHEME}stage/notes`,
          name: "notes.md",
          mimeType: "text/markdown",
        },
      ],
    ])
    await guest.agent.notify(methods.agent.session.cancel, {
      sessionId: GUEST_REF,
    })
    await vi.waitFor(() => expect(test.sources[0]?.stop).toHaveBeenCalledOnce())
    test.close()
    guest.close()
    other.close()
  })

  it("streams a guest an operator's turn whose prompt it may not see", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const guest = await test.connect("guest-connection", {
      guest: invitedGuest("Private"),
    })
    await open(guest, { sessionId: GUEST_REF })

    await prompt(test, "Private")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    await replyWhileWatched(test.sources[0], "Done", [guest])

    expect(prompts(guest.recorder, GUEST_REF)).toEqual([])
    expect(flow(guest.recorder, GUEST_REF)).toContain("chunk Done")
    test.close()
    guest.close()
  })

  it.each([
    ["once", true],
    ["session", false],
    ["always", false],
  ])(
    "lets a guest answer an operator's approval %s only within its grant",
    async (optionId, accepted) => {
      const unanswered = gate()
      const test = await harness({
        providerIds: true,
        // The operator's own browser never answers, so the guest's answer decides.
        permission: async () => {
          await unanswered.held
          return { outcome: { outcome: "cancelled" } }
        },
      })
      await test.list()
      await open(test)
      const policy = invitedGuest()
      const guest = await test.connect("guest-connection", {
        guest: {
          ...policy,
          project: {
            ...policy.project,
            // As the real guest projection does, refuse a widened grant.
            permissionReply: (_request, reply) => {
              if (JSON.stringify(reply.payload).includes('"once"')) return reply
              throw invalidRequest()
            },
          },
        },
        permission: async () => ({
          outcome: { outcome: "selected", optionId },
        }),
      })
      await open(guest, { sessionId: GUEST_REF })
      await prompt(test, "Delete it")
      await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
      test.sources[0]?.emit(turnStarted())
      test.sources[0]?.emit({
        kind: TurnEventKind.TurnRequiresAction,
        requests: [APPROVAL],
      })
      test.sources[0]?.finish()

      if (accepted) {
        await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
        expect(test.start.mock.calls[1]?.[1]).toMatchObject({
          replies: [{ requestId: APPROVAL.requestId, status: "resolved" }],
        })
      } else {
        const refused = await guest.recorder.wait(
          (entry) => entry.method === AOS_METHODS.notify.error
        )
        expect(refused.params).toMatchObject({ code: "invalid_request" })
        expect(test.start).toHaveBeenCalledTimes(1)
      }
      unanswered.release()
      test.close()
      guest.close()
    }
  )

  it("shows an operator a guest's prompt rebuilt from its allowed fields", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    await open(test)
    const guest = await test.connect("guest-connection", {
      guest: invitedGuest(),
    })

    const messageId = await prompt(
      guest,
      [
        {
          type: "text",
          text: "Hello",
          annotations: { priority: 1 },
          _meta: { private: "guest-only" },
        },
      ],
      GUEST_REF
    )
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    await replyWhileWatched(test.sources[0], "Done", [test])

    expect(flow(test.recorder)).toContain(`prompt ${messageId}`)
    expect(prompts(test.recorder)).toEqual([[{ type: "text", text: "Hello" }]])
    test.close()
    guest.close()
  })

  it("asks a browser shown a prompt to reload when its turn ended first", async () => {
    const test = await harness({
      providerIds: true,
      // The provider runs the whole turn before its admission even returns.
      onStart: (source) => {
        reply(source, "Instant")
        source.finish()
      },
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)

    await prompt(test, "Summarize")
    const invalidated = await other.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.sessionInvalidated
    )

    expect(invalidated.params).toEqual({ sessionId: SESSION })
    expect(prompts(other.recorder)).toHaveLength(1)
    test.close()
    other.close()
  })

  it("sends nothing to a browser that closed the Session", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    await other.agent.request(methods.agent.session.close, {
      sessionId: SESSION,
    })
    const from = other.recorder.entries.length

    await prompt(test, "Summarize")
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    reply(test.sources[0], "Done")
    await test.recorder.wait(endedTurn)
    await settled()

    expect(other.recorder.entries.slice(from)).toEqual([])
    test.close()
    other.close()
  })
})
