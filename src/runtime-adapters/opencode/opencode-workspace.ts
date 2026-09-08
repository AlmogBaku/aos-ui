import {
  OpenCodeEventSource,
  type GlobalSession,
  type OpencodeClient,
  type Session,
  type SessionStatus as OpenCodeSessionStatus,
} from "@assistant-ui/react-opencode"

import type {
  AgentCatalogEntry,
  ReadyAgentSummary,
  SessionCreationOptions,
  SessionMetadata,
  TodoItem,
  WorkspaceActivityEvent,
  WorkspaceAdapter,
} from "../contracts"
import type { OpenCodeWorkspaceEvent } from "./opencode-event"
import {
  openCodeActivityIdPart,
  readOpenCodeActivitySignal,
  readOpenCodeEventAgentId,
  readOpenCodeEventId,
  readOpenCodeEventOccurredAt,
  readOpenCodeEventOrder,
} from "./opencode-activity"
import { OpenCodeSessionOwnership } from "./opencode-session-ownership"
import { isCatalogAgent, isSupportedAgent } from "./agent-catalog"

const REQUEST_OPTIONS = { throwOnError: true } as const

type OpenCodeAgent = NonNullable<
  Awaited<ReturnType<OpencodeClient["app"]["agents"]>>["data"]
>[number]

type OpenCodeTodo = NonNullable<
  Awaited<ReturnType<OpencodeClient["session"]["todo"]>>["data"]
>[number]

type SessionMetadataSubscription = {
  active: boolean
  listener: (metadata: SessionMetadata[]) => void
  onError?: (error: Error) => void
  revision: number
  threadIds: string[]
  threadIdSet: Set<string>
}

type AgentCatalogSubscription = {
  listener: () => void
  onError?: (error: Error) => void
}

type ActivitySubscription = {
  listener: (event: WorkspaceActivityEvent) => void
  onError?: (error: Error) => void
}

export type OpenCodeEventSubscription = {
  subscribe(listener: (event: OpenCodeWorkspaceEvent) => void): () => void
}

export type OpenCodeWorkspaceOptions = {
  client: OpencodeClient
  events?: OpenCodeEventSubscription
  ownership?: OpenCodeSessionOwnership
  reloadThreads?: () => void | Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value))
}

function toAgentSummary(agent: OpenCodeAgent): ReadyAgentSummary {
  const options = isRecord(agent.options) ? agent.options : {}
  const configuredName = options.aos_ui_name
  const name =
    typeof configuredName === "string" &&
    configuredName.trim().length > 0 &&
    configuredName.length <= 80
      ? configuredName.trim()
      : agent.name
  return {
    kind: "ready",
    id: agent.name,
    name,
    ...(agent.description ? { description: agent.description } : {}),
    visibility: agent.hidden === true ? "hidden" : "visible",
    ...(options.aos_ui_role === "creator" ? { role: "creator" as const } : {}),
  }
}

function toSessionStatus(
  status: OpenCodeSessionStatus | undefined
): SessionMetadata["status"] {
  if (status?.type === "busy" || status?.type === "retry") return "running"
  return "idle"
}

function toSessionMetadata(
  session: Pick<Session, "id" | "agent" | "time" | "metadata">,
  status: OpenCodeSessionStatus | undefined,
  waitingForInput = false
): SessionMetadata | undefined {
  if (!session.agent) return undefined
  return {
    threadId: session.id,
    agentId: session.agent,
    updatedAt: new Date(session.time.updated).toISOString(),
    status: waitingForInput ? "waiting-for-input" : toSessionStatus(status),
  }
}

function toTodoStatus(status: string): TodoItem["status"] {
  switch (status) {
    case "in_progress":
      return "active"
    case "completed":
      return "completed"
    case "cancelled":
      return "failed"
    default:
      return "pending"
  }
}

function toTodoItems(
  threadId: string,
  todos: readonly OpenCodeTodo[]
): TodoItem[] {
  return todos.map((todo, index) => ({
    id: `${threadId}:todo:${index}`,
    label: todo.content,
    status: toTodoStatus(todo.status),
  }))
}

function readTodoEvent(event: OpenCodeWorkspaceEvent) {
  if (event.type !== "todo.updated" || !isRecord(event.properties)) {
    return undefined
  }

  const { sessionID, todos } = event.properties
  if (typeof sessionID !== "string" || !Array.isArray(todos)) return undefined

  const validTodos = todos.filter(
    (todo): todo is OpenCodeTodo =>
      isRecord(todo) &&
      typeof todo.content === "string" &&
      typeof todo.status === "string" &&
      typeof todo.priority === "string"
  )
  if (validTodos.length !== todos.length) return undefined

  return { threadId: sessionID, todos: validTodos }
}

function readSessionMetadataInvalidation(event: OpenCodeWorkspaceEvent) {
  if (event.type === "stream.reconnected") return { all: true as const }
  if (event.type === "session.updated" || event.type === "session.deleted") {
    if (!isRecord(event.properties) || !isRecord(event.properties.info)) {
      return undefined
    }

    const { id } = event.properties.info
    if (typeof id !== "string") return undefined
    return { all: false as const, threadId: id }
  }
  if (
    event.type !== "session.status" &&
    event.type !== "session.idle" &&
    event.type !== "question.asked" &&
    event.type !== "question.replied" &&
    event.type !== "question.rejected" &&
    event.type !== "question.v2.asked" &&
    event.type !== "question.v2.replied" &&
    event.type !== "question.v2.rejected" &&
    event.type !== "permission.asked" &&
    event.type !== "permission.replied" &&
    event.type !== "permission.rejected" &&
    event.type !== "permission.v2.asked" &&
    event.type !== "permission.v2.replied" &&
    event.type !== "permission.v2.rejected"
  ) {
    return undefined
  }
  if (!isRecord(event.properties)) return undefined

  const { sessionID } = event.properties
  if (typeof sessionID !== "string") return undefined
  return { all: false as const, threadId: sessionID }
}

function createOfficialEventSubscription(
  client: OpencodeClient
): OpenCodeEventSubscription {
  const source = new OpenCodeEventSource(client)
  return {
    subscribe: (listener) =>
      source.subscribe((event) => listener(event as OpenCodeWorkspaceEvent)),
  }
}

export class OpenCodeWorkspace implements WorkspaceAdapter {
  readonly #client: OpencodeClient
  readonly #events: OpenCodeEventSubscription
  readonly #ownership: OpenCodeSessionOwnership
  readonly #reloadThreads?: () => void | Promise<void>
  readonly #createdSessions = new Map<string, SessionMetadata>()
  readonly #todoListeners = new Map<string, Set<(todos: TodoItem[]) => void>>()
  readonly #todoRevisions = new Map<string, number>()
  readonly #sessionMetadataSubscriptions =
    new Set<SessionMetadataSubscription>()
  readonly #agentCatalogListeners = new Set<AgentCatalogSubscription>()
  readonly #activityListeners = new Set<ActivitySubscription>()
  readonly #activeRuns = new Map<
    string,
    { agentId: string; lifecycleId: string }
  >()
  readonly #emittedActivityIds = new Set<string>()
  readonly #emittedActivityIdOrder: string[] = []
  readonly #lastRunSequence = new Map<
    string,
    { threadId: string; sequence: number }
  >()
  #threadReloadQueued = false
  #threadReloadDirty = false
  #threadReloadRefreshOwnership = false
  #eventSubscriptionGeneration = 0
  #activitySubscriptionGeneration = 0
  #activityEventQueue = Promise.resolve()
  #stopEvents: (() => void) | undefined

  constructor({
    client,
    events,
    ownership,
    reloadThreads,
  }: OpenCodeWorkspaceOptions) {
    this.#client = client
    this.#events = events ?? createOfficialEventSubscription(client)
    this.#ownership = ownership ?? new OpenCodeSessionOwnership()
    this.#reloadThreads = reloadThreads
  }

  async listAgentCatalog(): Promise<AgentCatalogEntry[]> {
    const response = await this.#client.app.agents({}, REQUEST_OPTIONS)
    return (response.data ?? []).filter(isCatalogAgent).map((agent) => ({
      summary: toAgentSummary(agent),
      visibility: agent.hidden ? "hidden" : "visible",
      selectable: !agent.hidden,
      editable: false,
    }))
  }

  async listAgents() {
    const [response, sessionsResponse] = await Promise.all([
      this.#client.app.agents({}, REQUEST_OPTIONS),
      this.#client.experimental.session.list(
        { roots: true, archived: false },
        REQUEST_OPTIONS
      ),
    ])
    const readyAgents = (response.data ?? [])
      .filter(isSupportedAgent)
      .map(toAgentSummary)
    for (const session of sessionsResponse.data ?? []) {
      if (session.agent) this.#ownership.remember(session.id, session.agent)
    }
    return readyAgents
  }

  async refreshAgents() {
    return this.listAgents()
  }

  async getSessionMetadata(threadIds: string[]) {
    if (threadIds.length === 0) return []

    const requested = new Set(threadIds)
    const [
      sessionResponse,
      statusResponse,
      permissionResponse,
      questionResponse,
    ] = await Promise.all([
      this.#client.experimental.session.list(
        { roots: true, archived: true },
        REQUEST_OPTIONS
      ),
      this.#client.session.status({}, REQUEST_OPTIONS),
      this.#client.permission.list(undefined, REQUEST_OPTIONS),
      this.#client.question.list(undefined, REQUEST_OPTIONS),
    ])
    const statuses = statusResponse.data ?? {}
    const waitingSessionIds = new Set<string>()
    for (const interaction of [
      ...(permissionResponse.data ?? []),
      ...(questionResponse.data ?? []),
    ]) {
      if (
        typeof interaction.sessionID === "string" &&
        requested.has(interaction.sessionID)
      ) {
        waitingSessionIds.add(interaction.sessionID)
      }
    }
    const sessions = new Map<string, GlobalSession>()

    for (const session of sessionResponse.data ?? []) {
      if (requested.has(session.id)) sessions.set(session.id, session)
    }

    const metadata = [...sessions.values()]
      .map((session) =>
        toSessionMetadata(
          session,
          statuses[session.id],
          waitingSessionIds.has(session.id)
        )
      )
      .filter((value): value is SessionMetadata => value !== undefined)

    for (const item of metadata) {
      const rawSession = sessions.get(item.threadId)
      if (rawSession?.agent) {
        this.#ownership.remember(item.threadId, rawSession.agent)
      }
    }

    const byThread = new Map(metadata.map((value) => [value.threadId, value]))
    for (const [threadId, created] of this.#createdSessions) {
      if (requested.has(threadId) && !byThread.has(threadId)) {
        byThread.set(threadId, {
          ...structuredClone(created),
          status: waitingSessionIds.has(threadId)
            ? "waiting-for-input"
            : toSessionStatus(statuses[threadId]),
        })
      }
    }

    return threadIds.flatMap((threadId) => {
      const value = byThread.get(threadId)
      return value ? [structuredClone(value)] : []
    })
  }

  async createSession(agentId: string, options?: SessionCreationOptions) {
    const response = await this.#client.session.create(
      { agent: agentId, ...(options ? { title: options.title } : {}) },
      REQUEST_OPTIONS
    )
    const session = response.data
    if (!session?.id) throw new Error("OpenCode did not create a Session")
    if (session.agent !== agentId) {
      throw new Error(
        `Session ownership mismatch: requested ${agentId}, received ${session.agent ?? "none"}`
      )
    }

    const statusResponse = await this.#client.session.status(
      {},
      REQUEST_OPTIONS
    )
    const metadata = toSessionMetadata(
      session,
      statusResponse.data?.[session.id]
    )
    if (!metadata) throw new Error("OpenCode did not confirm Session ownership")

    this.#createdSessions.set(session.id, structuredClone(metadata))
    this.#ownership.remember(metadata.threadId, metadata.agentId)
    return { threadId: session.id }
  }

  subscribeAgentCatalog(
    listener: () => void,
    onError?: (error: Error) => void
  ) {
    const entry: AgentCatalogSubscription = {
      listener,
      ...(onError ? { onError } : {}),
    }
    this.#agentCatalogListeners.add(entry)
    this.#ensureEventSubscription()
    return () => {
      this.#agentCatalogListeners.delete(entry)
      this.#stopEventSubscriptionIfUnused()
    }
  }

  subscribeActivity(
    listener: (event: WorkspaceActivityEvent) => void,
    onError?: (error: Error) => void
  ) {
    const entry = { listener, ...(onError ? { onError } : {}) }
    const startsObservation = this.#activityListeners.size === 0
    this.#activityListeners.add(entry)
    if (startsObservation) this.#activitySubscriptionGeneration += 1
    try {
      this.#ensureEventSubscription()
    } catch (reason) {
      this.#activityListeners.delete(entry)
      throw reason
    }
    return () => {
      if (!this.#activityListeners.delete(entry)) return
      if (this.#activityListeners.size === 0) {
        this.#activitySubscriptionGeneration += 1
        this.#activeRuns.clear()
      }
      this.#stopEventSubscriptionIfUnused()
    }
  }

  #publishAgentCatalog() {
    for (const { listener } of this.#agentCatalogListeners) listener()
  }

  subscribeTodos(
    threadId: string,
    listener: (todos: TodoItem[]) => void,
    onError?: (error: Error) => void
  ) {
    let active = true
    const listeners = this.#todoListeners.get(threadId) ?? new Set()
    listeners.add(listener)
    this.#todoListeners.set(threadId, listeners)
    this.#ensureEventSubscription()

    const revisionAtLoad = this.#todoRevisions.get(threadId) ?? 0
    void this.#client.session
      .todo({ sessionID: threadId }, REQUEST_OPTIONS)
      .then((response) => {
        if (!active) return
        if ((this.#todoRevisions.get(threadId) ?? 0) !== revisionAtLoad) return
        this.#publishTodos(threadId, toTodoItems(threadId, response.data ?? []))
      })
      .catch((reason: unknown) => {
        if (!active) return
        onError?.(reason instanceof Error ? reason : new Error(String(reason)))
      })

    return () => {
      active = false
      const current = this.#todoListeners.get(threadId)
      current?.delete(listener)
      if (current?.size === 0) this.#todoListeners.delete(threadId)
      this.#stopEventSubscriptionIfUnused()
    }
  }

  subscribeSessionMetadata(
    threadIds: readonly string[],
    listener: (metadata: SessionMetadata[]) => void,
    onError?: (error: Error) => void
  ) {
    const requestedThreadIds = [...new Set(threadIds)]
    const subscription: SessionMetadataSubscription = {
      active: true,
      listener,
      ...(onError ? { onError } : {}),
      revision: 0,
      threadIds: requestedThreadIds,
      threadIdSet: new Set(requestedThreadIds),
    }
    this.#sessionMetadataSubscriptions.add(subscription)
    try {
      this.#ensureEventSubscription()
    } catch (reason) {
      subscription.active = false
      this.#sessionMetadataSubscriptions.delete(subscription)
      throw reason
    }

    return () => {
      if (!subscription.active) return
      subscription.active = false
      subscription.revision += 1
      this.#sessionMetadataSubscriptions.delete(subscription)
      this.#stopEventSubscriptionIfUnused()
    }
  }

  #ensureEventSubscription() {
    if (this.#stopEvents) return

    const generation = ++this.#eventSubscriptionGeneration
    this.#stopEvents = this.#events.subscribe((event) => {
      if (generation !== this.#eventSubscriptionGeneration) return

      if (
        (event.type === "session.created" ||
          event.type === "session.updated" ||
          event.type === "session.deleted") &&
        isRecord(event.properties) &&
        isRecord(event.properties.info) &&
        typeof event.properties.info.id === "string"
      ) {
        const threadId = event.properties.info.id
        if (event.type === "session.deleted") {
          this.#ownership.forget(threadId)
          this.#activeRuns.delete(threadId)
          for (const [key, state] of this.#lastRunSequence) {
            if (state.threadId === threadId) this.#lastRunSequence.delete(key)
          }
        } else if (typeof event.properties.info.agent === "string") {
          this.#ownership.remember(threadId, event.properties.info.agent)
        }
      }

      if (this.#activityListeners.size > 0) {
        const activityGeneration = this.#activitySubscriptionGeneration
        this.#activityEventQueue = this.#activityEventQueue
          .then(async () => {
            if (
              generation !== this.#eventSubscriptionGeneration ||
              activityGeneration !== this.#activitySubscriptionGeneration
            ) {
              return
            }
            await this.#publishActivityFromProviderEvent(
              event,
              generation,
              activityGeneration
            )
          })
          .catch((reason: unknown) => {
            if (
              generation === this.#eventSubscriptionGeneration &&
              activityGeneration === this.#activitySubscriptionGeneration
            ) {
              this.#publishActivityError(reason)
            }
          })
      }

      const update = readTodoEvent(event)
      if (update) {
        const revision = (this.#todoRevisions.get(update.threadId) ?? 0) + 1
        this.#todoRevisions.set(update.threadId, revision)
        this.#publishTodos(
          update.threadId,
          toTodoItems(update.threadId, update.todos)
        )
      }

      const invalidation = readSessionMetadataInvalidation(event)
      if (invalidation) this.#refreshSessionMetadata(invalidation)

      if (
        event.type === "session.created" ||
        event.type === "session.updated" ||
        event.type === "session.deleted" ||
        event.type === "stream.reconnected"
      ) {
        this.#publishAgentCatalog()
        this.#scheduleThreadReload(event.type === "stream.reconnected")
      }
    })
  }

  async #publishActivityFromProviderEvent(
    event: OpenCodeWorkspaceEvent,
    eventGeneration: number,
    activityGeneration: number
  ) {
    const signal = readOpenCodeActivitySignal(event)
    if (!signal) return

    const providerAgentId = await this.#ownership.find(
      this.#client,
      signal.threadId
    )
    if (
      eventGeneration !== this.#eventSubscriptionGeneration ||
      activityGeneration !== this.#activitySubscriptionGeneration
    ) {
      return
    }
    if (!providerAgentId) return
    const agentId = providerAgentId
    const declaredAgentId = readOpenCodeEventAgentId(event)
    if (
      declaredAgentId &&
      declaredAgentId !== providerAgentId &&
      declaredAgentId !== agentId
    ) {
      return
    }

    const runStartEventId =
      signal.kind === "run-active" ? readOpenCodeEventId(event) : undefined
    if (signal.kind === "run-active" && !runStartEventId) return

    const order = signal.kind.startsWith("run-")
      ? readOpenCodeEventOrder(event, signal.threadId)
      : undefined
    if (order) {
      const key = `${providerAgentId}\u0000${signal.threadId}\u0000${order.key}`
      const previous = this.#lastRunSequence.get(key)?.sequence ?? -1
      if (order.sequence <= previous) return
      this.#lastRunSequence.set(key, {
        threadId: signal.threadId,
        sequence: order.sequence,
      })
    }

    const runKey = signal.threadId
    if (signal.kind === "run-active") {
      if (this.#activeRuns.has(runKey)) return
      if (!runStartEventId) return
      const lifecycleId = `opencode:run:${openCodeActivityIdPart(signal.threadId)}:${openCodeActivityIdPart(runStartEventId)}`
      this.#activeRuns.set(runKey, { agentId, lifecycleId })
      this.#emitActivity({
        id: `${lifecycleId}:started`,
        agentId,
        threadId: signal.threadId,
        occurredAt: readOpenCodeEventOccurredAt(event),
        type: "run-started",
        lifecycleId,
      })
      return
    }

    if (signal.kind === "run-cancelled") {
      this.#activeRuns.delete(runKey)
      return
    }

    if (signal.kind === "run-finished" || signal.kind === "run-failed") {
      const active = this.#activeRuns.get(runKey)
      if (!active || active.agentId !== agentId) return
      this.#activeRuns.delete(runKey)
      const terminal = signal.kind === "run-finished" ? "finished" : "failed"
      this.#emitActivity({
        id: `${active.lifecycleId}:${terminal}`,
        agentId,
        threadId: signal.threadId,
        occurredAt: readOpenCodeEventOccurredAt(event),
        type: signal.kind,
        lifecycleId: active.lifecycleId,
      })
      return
    }

    if (signal.kind === "attention-requested") {
      this.#emitActivity({
        id: `opencode:attention:${openCodeActivityIdPart(signal.threadId)}:${signal.attentionKind}:${openCodeActivityIdPart(signal.requestId)}:requested`,
        agentId,
        threadId: signal.threadId,
        occurredAt: readOpenCodeEventOccurredAt(event),
        type: "attention-requested",
        attentionKind: signal.attentionKind,
        requestId: signal.requestId,
      })
      return
    }

    this.#emitActivity({
      id: `opencode:attention:${openCodeActivityIdPart(signal.threadId)}:${openCodeActivityIdPart(signal.requestId)}:resolved`,
      agentId,
      threadId: signal.threadId,
      occurredAt: readOpenCodeEventOccurredAt(event),
      type: "attention-resolved",
      requestId: signal.requestId,
    })
  }

  #emitActivity(event: WorkspaceActivityEvent) {
    if (this.#emittedActivityIds.has(event.id)) return
    this.#emittedActivityIds.add(event.id)
    this.#emittedActivityIdOrder.push(event.id)
    if (this.#emittedActivityIdOrder.length > 2_048) {
      const oldest = this.#emittedActivityIdOrder.shift()
      if (oldest) this.#emittedActivityIds.delete(oldest)
    }
    for (const entry of this.#activityListeners) {
      try {
        entry.listener(structuredClone(event))
      } catch (reason) {
        this.#notifyActivityError(entry, toError(reason))
      }
    }
  }

  #publishActivityError(reason: unknown) {
    const error = toError(reason)
    for (const entry of this.#activityListeners) {
      this.#notifyActivityError(entry, error)
    }
  }

  #notifyActivityError(entry: ActivitySubscription, error: Error) {
    try {
      entry.onError?.(error)
    } catch {
      // Consumer callbacks cannot poison the shared provider event queue or
      // prevent another activity subscriber from observing the same failure.
    }
  }

  #scheduleThreadReload(refreshOwnership: boolean) {
    this.#threadReloadDirty = true
    this.#threadReloadRefreshOwnership ||= refreshOwnership
    if (this.#threadReloadQueued) return
    this.#threadReloadQueued = true
    queueMicrotask(() => {
      void (async () => {
        try {
          while (this.#threadReloadDirty) {
            this.#threadReloadDirty = false
            const shouldRefreshOwnership = this.#threadReloadRefreshOwnership
            this.#threadReloadRefreshOwnership = false
            if (shouldRefreshOwnership) {
              const response = await this.#client.experimental.session.list(
                { roots: true, archived: true },
                REQUEST_OPTIONS
              )
              this.#ownership.reconcile(
                (response.data ?? []).flatMap((session) =>
                  session.agent ? [[session.id, session.agent] as const] : []
                )
              )
            }
            await this.#reloadThreads?.()
          }
        } catch (reason) {
          const error = toError(reason)
          for (const entry of this.#agentCatalogListeners)
            entry.onError?.(error)
        } finally {
          this.#threadReloadQueued = false
          if (this.#threadReloadDirty) this.#scheduleThreadReload(false)
        }
      })()
    })
  }

  #refreshSessionMetadata(
    invalidation: { all: true } | { all: false; threadId: string }
  ) {
    for (const subscription of this.#sessionMetadataSubscriptions) {
      if (
        !invalidation.all &&
        !subscription.threadIdSet.has(invalidation.threadId)
      ) {
        continue
      }

      const revision = ++subscription.revision
      void this.getSessionMetadata(subscription.threadIds)
        .then((metadata) => {
          if (!subscription.active || revision !== subscription.revision) {
            return
          }
          subscription.listener(structuredClone(metadata))
        })
        .catch((reason: unknown) => {
          if (!subscription.active || revision !== subscription.revision) {
            return
          }
          subscription.onError?.(
            reason instanceof Error ? reason : new Error(String(reason))
          )
        })
    }
  }

  #stopEventSubscriptionIfUnused() {
    if (
      this.#todoListeners.size > 0 ||
      this.#sessionMetadataSubscriptions.size > 0 ||
      this.#agentCatalogListeners.size > 0 ||
      this.#activityListeners.size > 0
    ) {
      return
    }
    this.#eventSubscriptionGeneration += 1
    this.#stopEvents?.()
    this.#stopEvents = undefined
  }

  #publishTodos(threadId: string, todos: TodoItem[]) {
    for (const listener of this.#todoListeners.get(threadId) ?? []) {
      listener(structuredClone(todos))
    }
  }
}

export function createOpenCodeWorkspace(options: OpenCodeWorkspaceOptions) {
  return new OpenCodeWorkspace(options)
}
