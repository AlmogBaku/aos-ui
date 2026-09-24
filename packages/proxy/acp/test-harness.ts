/**
 * The in-process ACP harness the proxy's ACP tests share: an SDK client that
 * records what it receives, connected to the real ACP agent and Session
 * coordinator over a fake provider runtime whose turns the test drives.
 */
import {
  client,
  methods,
  type ContentBlock,
  type CreateElicitationResponse,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
} from "@agentclientprotocol/sdk/experimental/v2"
import { expect, vi } from "vitest"
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
import { EVERY_FEED } from "../core/member"
import { createSessionRows, type SessionRows } from "../core/session-rows"
import { createAosAcpAgent } from "./agent"
import { createChannel } from "../core/channel"
import type { AcpConnectionContext, AcpOutbound, Translators } from "./types"

export const AGENT = "researcher"
export const PRINCIPAL = "operator"
export const CONNECTION = "connection-1"
export const SESSION = "session-1"
export const CREATED = "session-created"
export const NOW = "2026-01-01T00:00:00.000Z"

export function sessionRow(overrides: Partial<Session> = {}): Session {
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

export const MODELS: SessionModelsResponse = {
  selectedId: "sonnet",
  options: [
    { id: "sonnet", label: "Sonnet", group: "Anthropic" },
    { id: "opus", label: "Opus", group: "Anthropic" },
  ],
}

export const AVAILABLE = { status: "available" } as const

export const RUNTIME_INFO: RuntimeInfo = {
  runtime: { id: "test-runtime", name: "Test Runtime" },
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

export const CAPABILITIES = {
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

export const USAGE = {
  usedTokens: 1_200,
  maxTokens: 20_000,
  source: "provider-usage" as const,
  breakdown: { systemTokens: 300, toolTokens: 400, messageTokens: 500 },
}

/** One provider run segment the test drives event by event. */
export class EventSource implements ServerTurnHandle {
  readonly #values: TurnEvent[] = []
  readonly #waiters: Array<(value: IteratorResult<TurnEvent>) => void> = []
  readonly stop = vi.fn<ServerTurnHandle["stop"]>(async () => "stopping")
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

function questionOutbound(request: PendingRequest): RequestOutbound {
  return {
    kind: "elicitation",
    requestId: request.requestId,
    request: {
      mode: "form",
      message: request.message ?? "",
      requestedSchema: { type: "object", properties: {} },
    },
  }
}

const requestOutbound = (request: PendingRequest): RequestOutbound =>
  request.kind === PendingRequestKind.Elicitation
    ? questionOutbound(request)
    : permissionOutbound(request)

/** Deterministic stand-ins for the translator lane's pure projections. */
export const translators: Translators = {
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
              // As the real translator does, a dated start keeps its date.
              _meta: {
                [AOS_META_KEY]: {
                  ...meta._meta[AOS_META_KEY],
                  ...(event.startedAt ? { at: event.startedAt } : {}),
                },
              },
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
      return { state, outbound: event.requests.map(requestOutbound) }
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
    if (event.kind === TurnEventKind.ModelChanged)
      return {
        state,
        outbound: [{ kind: "model-changed", modelId: event.modelId }],
      }
    return { state, outbound: [] }
  },
  translateHistory: (history) =>
    history.messages.map((message) => ({
      kind: "update",
      update: {
        sessionUpdate: "agent_message",
        messageId: message.id,
        content: [{ type: "text", text: `replay:${message.id}` }],
      },
    })),
  pendingRequestToOutbound: (request) => requestOutbound(request),
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

/**
 * `vi.waitFor` polling every 10ms instead of 50ms: an in-process connection
 * settles in a few ms, so the default interval is most of each wait.
 */
export function waitFor<T>(callback: () => T | Promise<T>) {
  return vi.waitFor(callback, { interval: 10 })
}

export type Recorded = { method: string; params: unknown }

/** How long `recorder.wait` holds out; an in-process connection answers in ms. */
const WAIT_DEADLINE_MS = 5_000
// Captured at load so a test that fakes timers cannot freeze the deadline.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

/** What the client received, newest last, abbreviated for a timeout message. */
function summarize(entries: readonly Recorded[]) {
  const recent = entries.slice(-5)
  if (recent.length === 0) return "nothing"
  return recent
    .map(({ method, params }) => {
      const text = JSON.stringify(params) ?? ""
      return `${method} ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`
    })
    .join("\n  ")
}

export function createRecorder() {
  const entries: Recorded[] = []
  const waiters = new Set<() => void>()
  return {
    entries,
    of(method: string) {
      return entries.filter((entry) => entry.method === method)
    },
    add(entry: Recorded) {
      entries.push(entry)
      for (const wake of [...waiters]) wake()
    },
    /** The first entry `predicate` matches, or a failure naming `description`. */
    wait(predicate: (entry: Recorded) => boolean, description: string) {
      return new Promise<Recorded>((resolve, reject) => {
        const check = () => {
          const found = entries.find(predicate)
          if (!found) return
          settle()
          resolve(found)
        }
        const timer = realSetTimeout(() => {
          settle()
          reject(
            new Error(
              `Timed out after ${WAIT_DEADLINE_MS}ms waiting for ${description}; ` +
                `the last entries recorded were:\n  ${summarize(entries)}`
            )
          )
        }, WAIT_DEADLINE_MS)
        const settle = () => {
          waiters.delete(check)
          realClearTimeout(timer)
        }
        waiters.add(check)
        check()
      })
    },
  }
}

export type Recorder = ReturnType<typeof createRecorder>

export const unsupported = () => {
  throw new Error("The ACP test harness does not exercise this operation")
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

/** A browser's answers to what the proxy asks; `signal` aborts on withdrawal. */
export type ClientAnswers = {
  permission?: (
    params: unknown,
    signal: AbortSignal
  ) => Promise<RequestPermissionResponse>
  question?: (
    params: unknown,
    signal: AbortSignal
  ) => Promise<CreateElicitationResponse>
}

/**
 * An SDK client connected in process to one proxy connection, recording every
 * notification and request it receives. Unanswered permission requests allow
 * once and unanswered questions accept, as an attentive browser would.
 */
export function connectClient(
  context: AcpConnectionContext,
  { name, permission, question }: ClientAnswers & { name: string }
) {
  const recorder = createRecorder()
  const clientApp = client({ name })
    .onNotification(methods.client.session.update, ({ params }) => {
      recorder.add({ method: methods.client.session.update, params })
    })
    .onRequest(
      methods.client.session.requestPermission,
      async ({ params, signal }) => {
        recorder.add({
          method: methods.client.session.requestPermission,
          params,
        })
        return (
          (await permission?.(params, signal)) ?? {
            outcome: { outcome: "selected", optionId: "once" },
          }
        )
      }
    )
    .onRequest(
      methods.client.elicitation.create,
      async ({ params, signal }) => {
        recorder.add({ method: methods.client.elicitation.create, params })
        return (
          (await question?.(params, signal)) ?? {
            action: "accept",
            content: {},
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
  return { connection: clientApp.connect(createAosAcpAgent(context)), recorder }
}

export type HarnessOptions = {
  rows?: Session[]
  total?: number
  activity?: AosActivityNotification[]
  /** This browser's answer; `signal` aborts as the proxy withdraws the request. */
  permission?: (
    params: unknown,
    signal: AbortSignal
  ) => Promise<RequestPermissionResponse>
  /** This browser's answer to a question; `signal` aborts on withdrawal. */
  question?: (
    params: unknown,
    signal: AbortSignal
  ) => Promise<CreateElicitationResponse>
  discover?: ServerTurnEngine["discover"]
  /** Stands for a runtime that reports the turns it starts by itself. */
  watch?: ServerTurnEngine["watch"]
  /** Defaults to a readable window; a rejection stands for one that is not. */
  context?: ServerRuntime["context"]
  /** Runs before each model catalog read; a slow one stands for a real provider. */
  beforeModels?: () => Promise<void>
  /** Runs before each history read; a held one stands for a slow page. */
  beforeHistory?: () => Promise<void>
  /** Bounds each turn's journal; a small one stands for a long turn. */
  maxReplayEvents?: number
  /** Runs as a resume translates the page it read, before it follows the turn. */
  onReplay?: () => void
  /** Stands for a provider with no catalog change signal. */
  withoutCatalogChanges?: boolean
  /**
   * Runs as the provider admits each turn, before its handle returns: holding
   * it holds the admission, and throwing refuses the turn.
   */
  onStart?: (source: EventSource) => void | Promise<void>
  /** The replayed page's messages; defaults to one earlier assistant reply. */
  history?: SessionHistoryResponse["messages"]
  /**
   * The Session's whole history, oldest first, paged newest first as every
   * runtime pages it; `truncated` stands for older rows it cannot reach.
   */
  transcript?: SessionHistoryResponse["messages"]
  truncated?: boolean
  /** Replaces the harness's one-update-per-message history translation. */
  translateHistory?: Translators["translateHistory"]
  /** Gives provider Sessions ids of their own, as a real runtime does. */
  providerIds?: boolean
  /** Whether the client pages older history, as the AOS browser does. */
  pagesHistory?: boolean
  /** What the provider reports it supports; defaults to `CAPABILITIES`. */
  capabilities?: unknown
  /** Queue depth one browser's run stream is allowed, before it is dropped. */
  maxSubscriberEvents?: number
  /** The translator lane; defaults to the deterministic stand-ins above. */
  translators?: Translators
  /** The clock Session rows read; wall time by default. */
  now?: () => number
  /**
   * Composes the operator lane's own read state and activity feed, as
   * `createOperatorAcpService` does; observable fakes stand in by default.
   */
  compose?: (parts: {
    runtimeInstance: RuntimeInstance
    sessionRows: SessionRows
  }) => Pick<AcpConnectionContext, "readState" | "activityFeed">
}

export async function harness(options: HarnessOptions = {}) {
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
  const history = vi.fn(
    async (
      _agentId: string,
      sessionId: string,
      limit: number,
      offset: number
    ): Promise<SessionHistoryResponse> => {
      await options.beforeHistory?.()
      const { transcript } = options
      if (transcript) {
        const end = Math.max(0, transcript.length - offset)
        const messages = transcript.slice(Math.max(0, end - limit), end)
        const nextOffset = offset + messages.length
        return {
          sessionId,
          messages,
          total: transcript.length,
          limit,
          offset,
          nextOffset,
          ...(options.truncated && nextOffset >= transcript.length
            ? { truncated: true }
            : {}),
        }
      }
      return {
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
      }
    }
  )

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
    workspaceCapabilities: async () => options.capabilities ?? CAPABILITIES,
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

  const coordinator = new SessionCoordinator({
    engine,
    readings: runtime,
    maxActiveExecutions: 8,
    maxGuestActiveExecutions: 2,
    maxSubscriberEvents: options.maxSubscriberEvents ?? 64,
    maxSubscriberBytes: 256 * 1024,
    maxReplayEvents: options.maxReplayEvents ?? 64,
    maxReplayBytes: 256 * 1024,
  })
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
    connected: vi.fn(() => false),
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
  const sessionRows = createSessionRows(
    options.now ? { now: options.now } : undefined
  )
  const composed = options.compose?.({ runtimeInstance, sessionRows })
  const { watch } = options
  const rooms = createChannel({
    snapshot: (roomScope) => coordinator.snapshot(roomScope),
    ...(watch
      ? {
          adoption: {
            watch,
            discover: (roomScope, lane) =>
              coordinator.discover(roomScope, lane),
            observe: (roomScope, listener) =>
              coordinator.observeScope(roomScope, listener),
          },
        }
      : {}),
  })

  /**
   * One browser connection to the proxy. Every connection shares the one
   * coordinator, engine, and room registry, as one deployment's lanes do.
   */
  async function connect(
    connectionId: string,
    lane: {
      /** This browser's answer to a permission request, if not the harness's. */
      permission?: HarnessOptions["permission"]
      /** This browser's answer to a question, if not the harness's. */
      question?: HarnessOptions["question"]
    } = {}
  ) {
    const attachmentStages = new AttachmentStageRegistry()
    const base = options.translators ?? translators
    const permission = lane.permission ?? options.permission
    const question = lane.question ?? options.question
    const context: AcpConnectionContext = {
      connectionId,
      principalId: PRINCIPAL,
      runtimeInstance,
      sessionRows,
      readState: composed?.readState ?? readState,
      translators: {
        ...base,
        translateHistory: (history) => {
          options.onReplay?.()
          return (options.translateHistory ?? base.translateHistory)(history)
        },
      },
      attachmentStages,
      rooms,
      presence,
      logger,
      lane: "operator",
      feeds: EVERY_FEED,
      activityFeed: composed?.activityFeed ?? activityFeed,
    }

    const { connection, recorder } = connectClient(context, {
      name: "aos-browser",
      permission,
      question,
    })
    const initialize = await connection.agent.request(
      methods.agent.initialize,
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        info: { name: "aos-browser", version: "1" },
        capabilities: {
          _meta: {
            [AOS_META_KEY]: { historyPages: options.pagesHistory ?? true },
          },
        },
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

  const primary = await connect(CONNECTION)

  const scope: SessionScope = {
    agentId: AGENT,
    sessionId: providerId(SESSION),
    threadId: SESSION,
  }

  return {
    ...primary,
    connect,
    coordinator,
    runtimeInstance,
    rooms,
    scope,
    sources,
    start,
    discover,
    updateSession,
    deleteSession,
    updateModel,
    listAllSessions,
    history,
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

export function turnStarted(): TurnEvent {
  return { kind: TurnEventKind.TurnStarted }
}

export function updates(recorder: Recorder) {
  return recorder.of(methods.client.session.update).map((entry) => entry.params)
}

export type Browser = Pick<
  Awaited<ReturnType<typeof harness>>,
  "agent" | "recorder"
>

/**
 * What one browser shows of a Session, in order: replayed rows, prompts, and
 * the turn stream. Usage, commands, and row updates are left out.
 */
export function flow(recorder: Recorder, sessionId = SESSION, from = 0) {
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
export function prompts(recorder: Recorder, sessionId = SESSION) {
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
export async function prompt(
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
export async function open(
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
      JSON.stringify(entry.params).includes("state_update"),
    "an update carrying state_update"
  )
}

/** Streams one reply on a provider segment and ends its turn. */
export function reply(source: EventSource | undefined, text: string) {
  source?.emit(turnStarted())
  source?.emit({
    kind: TurnEventKind.MessageChunk,
    messageId: "assistant-1",
    text,
  })
  source?.emit({ kind: TurnEventKind.TurnEnded })
}

/** Lets the follow-ups a response schedules for the next task run. */
export const settled = () => new Promise((resolve) => setTimeout(resolve, 10))

/**
 * Streams one reply, ending its turn only once every watcher saw it live: a
 * browser the room brings in late must still find the turn running.
 */
export async function replyWhileWatched(
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
    await recorder.wait(
      (entry) => JSON.stringify(entry.params).includes(text),
      `an update carrying ${text}`
    )
  source?.emit({ kind: TurnEventKind.TurnEnded })
  for (const { recorder } of watchers)
    await recorder.wait(endedTurn, "the turn to end")
}

export const endedTurn = (entry: Recorded) =>
  JSON.stringify(entry.params).includes("end_turn")

/** Matches the first entry whose params carry `text`. */
export const said = (text: string) => (entry: Recorded) =>
  JSON.stringify(entry.params).includes(text)

export const isPromptOrChunk = (item: string) =>
  item.startsWith("prompt") || item.startsWith("chunk")

/** Streams one assistant chunk on a provider segment. */
export function chunk(
  source: EventSource | undefined,
  text: string,
  messageId = "assistant-1"
) {
  source?.emit({ kind: TurnEventKind.MessageChunk, messageId, text })
}

/**
 * Starts one turn and streams its first chunk, `Live`, until every watcher
 * has seen it. Returns the prompt's message id.
 */
export async function liveTurn(
  test: Awaited<ReturnType<typeof harness>>,
  watchers: readonly Browser[]
) {
  const messageId = await prompt(test, "Summarize")
  await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
  test.sources[0]?.emit(turnStarted())
  chunk(test.sources[0], "Live")
  for (const { recorder } of watchers)
    await recorder.wait(said("Live"), "an update carrying Live")
  return messageId
}

/**
 * What Hermes stores of a turn still running: its prompt, then the rows it
 * folded into one message so far. Stored by default as the turn is admitted.
 */
export function storedLiveTurn(
  createdAt = new Date().toISOString(),
  correction?: string
): SessionHistoryResponse["messages"] {
  return [
    {
      id: "user-1",
      role: "user",
      content: [{ type: "text", text: " Summarize " }],
      createdAt,
    },
    ...(correction === undefined
      ? []
      : [
          {
            id: "correction-1",
            role: "user" as const,
            content: [{ type: "text" as const, text: correction }],
            createdAt,
            metadata: { custom: { correction: true } },
          },
        ]),
    {
      id: "assistant-0",
      role: "assistant",
      content: [{ type: "text", text: "Live" }],
      createdAt,
    },
  ]
}

/** One browser's view of a Session without the states that bracket it. */
export const withoutStates = (seen: readonly string[]) =>
  seen.filter((item) => !item.startsWith("state"))

/** A held step a test releases when the scenario needs it to go on. */
export function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { held: promise, release: () => resolve() }
}

/** A browser holding its answer until the proxy withdraws the request. */
export function heldUntilWithdrawn(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    })
  })
}
