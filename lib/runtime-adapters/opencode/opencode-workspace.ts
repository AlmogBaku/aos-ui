import {
  OpenCodeEventSource,
  type GlobalSession,
  type OpencodeClient,
  type Session,
  type SessionStatus as OpenCodeSessionStatus,
} from "@assistant-ui/react-opencode"

import type {
  AgentBuilderCreationOptions,
  AgentLifecycleEvent,
  AgentCatalogEntry,
  AgentVisibility,
  ReadyAgentSummary,
  SessionCreationOptions,
  SessionMetadata,
  TodoItem,
  WorkspaceActivityEvent,
  WorkspaceAdapter,
} from "../contracts"
import { AgentVisibilityUpdateError } from "../contracts"
import {
  readAgentCreatedEvent,
  readAgentCreatedFromMessages,
  type OpenCodeWorkspaceEvent,
} from "./agent-activation"
import {
  openCodeActivityIdPart,
  readOpenCodeActivitySignal,
  readOpenCodeEventAgentId,
  readOpenCodeEventId,
  readOpenCodeEventOccurredAt,
  readOpenCodeEventOrder,
} from "./opencode-activity"
import { OpenCodeSessionOwnership } from "./opencode-session-ownership"
import {
  hasManagedAgentMetadata,
  isCatalogAgent,
  isManagedAgentId,
} from "./agent-catalog"
import {
  AGENT_BUILDER_ID,
  AGENT_BUILDER_KICKOFF,
  AGENT_FIRST_SESSION_TITLE,
  AGENT_DRAFT_TITLE,
  createAgentDraftMetadata,
  draftAgentId,
  explainInvalidAgentDraftMetadata,
  nextAgentDraftMetadata,
  projectAgentDraft,
  readAgentDraftMetadata,
  readDraftThreadId,
  type AgentDraftCandidate,
  type AgentDraftMetadata,
} from "./agent-draft"

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
  diagnosticRevision: number
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
  managementUrl?: string
  fetcher?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value))
}

function transcriptHasKickoff(value: unknown) {
  if (!Array.isArray(value)) return false
  return value.some((message) => {
    if (
      !isRecord(message) ||
      !isRecord(message.info) ||
      message.info.role !== "user" ||
      !Array.isArray(message.parts)
    ) {
      return false
    }
    return message.parts.some(
      (part) =>
        isRecord(part) &&
        part.type === "text" &&
        part.text === AGENT_BUILDER_KICKOFF
    )
  })
}

function toAgentSummary(agent: OpenCodeAgent): ReadyAgentSummary {
  const configuredName = isRecord(agent.options)
    ? agent.options.aos_ui_name
    : undefined
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
  const draft = readAgentDraftMetadata(session.metadata)
  const agentId =
    session.agent === AGENT_BUILDER_ID && draft
      ? draftAgentId(session.id)
      : session.agent

  return {
    threadId: session.id,
    agentId,
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
  readonly updateAgentVisibility?: (
    agentId: string,
    visibility: AgentVisibility
  ) => Promise<void>
  readonly #client: OpencodeClient
  readonly #events: OpenCodeEventSubscription
  readonly #ownership: OpenCodeSessionOwnership
  readonly #createdSessions = new Map<string, SessionMetadata>()
  readonly #todoListeners = new Map<string, Set<(todos: TodoItem[]) => void>>()
  readonly #todoRevisions = new Map<string, number>()
  readonly #sessionMetadataSubscriptions =
    new Set<SessionMetadataSubscription>()
  readonly #lifecycleListeners = new Set<{
    listener: (event: AgentLifecycleEvent) => void
    onError?: (error: Error) => void
  }>()
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
  readonly #activationInFlight = new Set<string>()
  readonly #observedToolCalls = new Set<string>()
  #agentCatalogDiagnostics: Error[] = []
  #agentCatalogDiagnosticRevision = 0
  #eventSubscriptionGeneration = 0
  #activitySubscriptionGeneration = 0
  #activityEventQueue = Promise.resolve()
  #stopEvents: (() => void) | undefined

  constructor({
    client,
    events,
    ownership,
    managementUrl,
    fetcher = fetch,
  }: OpenCodeWorkspaceOptions) {
    this.#client = client
    this.#events = events ?? createOfficialEventSubscription(client)
    this.#ownership = ownership ?? new OpenCodeSessionOwnership()
    if (managementUrl) {
      const update = async (agentId: string, visibility: AgentVisibility) => {
        const entry = (await this.listAgentCatalog()).find(
          (entry) => entry.summary.id === agentId
        )
        if (!entry?.editable)
          throw new Error("This Agent is managed by its provider")
        if (visibility !== "visible" && visibility !== "hidden")
          throw new Error("Invalid Agent visibility")
        try {
          const response = await fetcher(
            `${managementUrl.replace(/\/$/, "")}/agents/${encodeURIComponent(agentId)}/visibility`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                visibility,
                expectedVisibility: entry.visibility,
              }),
            }
          )
          if (!response.ok) {
            const payload: unknown = await response
              .json()
              .catch(() => undefined)
            if (
              isRecord(payload) &&
              (payload.code === "provider-active" ||
                payload.code === "pending-reload")
            )
              throw new AgentVisibilityUpdateError(
                payload.code,
                "Agent visibility requires a retry"
              )
            throw new Error(
              isRecord(payload) &&
                typeof payload.message === "string" &&
                payload.message.length <= 300
                ? payload.message
                : "Agent visibility could not be changed"
            )
          }
          const confirmed = (await this.listAgentCatalog()).find(
            (entry) => entry.summary.id === agentId
          )
          if (confirmed?.visibility !== visibility)
            throw new Error("OpenCode did not confirm Agent visibility")
        } finally {
          this.#publishAgentCatalog()
        }
      }
      this.updateAgentVisibility = (agentId, visibility) =>
        this.#ownership.withReloadBarrier(() => update(agentId, visibility))
    }
  }

  async listAgentCatalog(): Promise<AgentCatalogEntry[]> {
    const response = await this.#client.app.agents({}, REQUEST_OPTIONS)
    return (response.data ?? []).filter(isCatalogAgent).map((agent) => ({
      summary: toAgentSummary(agent),
      visibility: agent.hidden ? "hidden" : "visible",
      selectable: !agent.hidden,
      editable:
        Boolean(this.updateAgentVisibility) &&
        isManagedAgentId(agent.name) &&
        hasManagedAgentMetadata(agent.options),
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
      .filter((agent) => isCatalogAgent(agent) && !agent.hidden)
      .map(toAgentSummary)
    for (const session of sessionsResponse.data ?? []) {
      if (session.agent) this.#ownership.remember(session.id, session.agent)
    }
    const diagnostics: Error[] = []
    const drafts = (sessionsResponse.data ?? []).flatMap((session) => {
      if (session.agent !== AGENT_BUILDER_ID) return []
      const metadata = readAgentDraftMetadata(session.metadata)
      if (!metadata) {
        if (!isRecord(session.metadata) || !("aos_ui" in session.metadata)) {
          return []
        }
        const reason = explainInvalidAgentDraftMetadata(session.metadata)
        diagnostics.push(
          new Error(
            `OpenCode hid Agent Builder Session ${session.id}: ${reason ?? "invalid AOS Agent draft metadata"}`
          )
        )
        return []
      }
      const projected = projectAgentDraft(session.id, metadata)
      if (!projected) return []
      this.#ownership.remember(session.id, AGENT_BUILDER_ID)
      if (!metadata.candidate) {
        void this.#recoverActivationReceipt(session.id, metadata)
          .then((recovered) => {
            if (recovered.phase === "activating") {
              return this.#resumeActivation(session.id)
            }
          })
          .catch((reason: unknown) => this.#publishLifecycleError(reason))
      } else if (metadata.phase === "activating") {
        void this.#resumeActivation(session.id).catch((reason: unknown) =>
          this.#publishLifecycleError(reason)
        )
      }
      return [projected]
    })
    this.#replaceAgentCatalogDiagnostics(diagnostics)
    return [...readyAgents, ...drafts]
  }

  async refreshAgents() {
    return this.listAgents()
  }

  async openAgentBuilder(options?: AgentBuilderCreationOptions) {
    const response = await this.#client.app.agents({}, REQUEST_OPTIONS)
    const builder = (response.data ?? []).find(
      (agent) =>
        agent.name === AGENT_BUILDER_ID &&
        (agent.mode === "primary" || agent.mode === "all")
    )
    if (!builder) {
      throw new Error(
        "The configured OpenCode Agent Builder is not available. Restart OpenCode after installing this workspace configuration."
      )
    }

    const initialMetadata = createAgentDraftMetadata(options)
    const createResponse = await this.#client.session.create(
      {
        agent: AGENT_BUILDER_ID,
        title: options?.draftTitle ?? AGENT_DRAFT_TITLE,
        metadata: { aos_ui: initialMetadata },
      },
      REQUEST_OPTIONS
    )
    const session = createResponse.data
    if (!session?.id || session.agent !== AGENT_BUILDER_ID) {
      throw new Error("OpenCode did not create an Agent Builder Session")
    }
    const provisionalId = draftAgentId(session.id)
    this.#ownership.remember(session.id, AGENT_BUILDER_ID)
    this.#createdSessions.set(session.id, {
      threadId: session.id,
      agentId: provisionalId,
      updatedAt: new Date(session.time.updated).toISOString(),
      status: "idle",
    })
    this.#emitLifecycle({
      type: "draft-created",
      draftAgentId: provisionalId,
      threadId: session.id,
      revision: initialMetadata.revision,
    })
    try {
      await this.#sendBuilderKickoff(session.id)
    } catch (reason) {
      const failed = nextAgentDraftMetadata(initialMetadata, {
        phase: "start-failed",
        lastError: toError(reason).message,
      })
      await this.#persistDraft(session.id, failed)
      this.#emitLifecycle({
        type: "draft-updated",
        draftAgentId: provisionalId,
        revision: failed.revision,
      })
    }
    this.#publishAgentCatalog()
    return { threadId: session.id, draftAgentId: provisionalId }
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
      diagnosticRevision: 0,
    }
    this.#agentCatalogListeners.add(entry)
    this.#ensureEventSubscription()
    const diagnosticRevision = this.#agentCatalogDiagnosticRevision
    if (this.#agentCatalogDiagnostics.length > 0) {
      queueMicrotask(() => {
        if (this.#agentCatalogListeners.has(entry)) {
          this.#deliverAgentCatalogDiagnostics(entry, diagnosticRevision)
        }
      })
    }
    return () => {
      this.#agentCatalogListeners.delete(entry)
      this.#stopEventSubscriptionIfUnused()
    }
  }

  subscribeAgentLifecycle(
    listener: (event: AgentLifecycleEvent) => void,
    onError?: (error: Error) => void
  ) {
    const entry = { listener, ...(onError ? { onError } : {}) }
    this.#lifecycleListeners.add(entry)
    this.#ensureEventSubscription()
    return () => {
      this.#lifecycleListeners.delete(entry)
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

  async deleteAgentDraft(provisionalId: string) {
    const threadId = readDraftThreadId(provisionalId)
    if (!threadId) throw new Error("Invalid Agent draft ID")
    const session = await this.#findDraftSession(threadId)
    let metadata = readAgentDraftMetadata(session.metadata)
    if (metadata && !metadata.candidate) {
      metadata = await this.#recoverActivationReceipt(threadId, metadata)
      if (metadata.phase === "activating") {
        void this.#resumeActivation(threadId).catch((reason: unknown) =>
          this.#publishLifecycleError(reason)
        )
      }
    }
    if (
      !metadata ||
      (metadata.phase !== "interview" && metadata.phase !== "start-failed")
    ) {
      throw new Error("This Agent draft can no longer be deleted")
    }
    await this.#client.session.delete({ sessionID: threadId }, REQUEST_OPTIONS)
    this.#createdSessions.delete(threadId)
    this.#ownership.forget(threadId)
    const deleted = nextAgentDraftMetadata(metadata, { phase: "deleted" })
    this.#emitLifecycle({
      type: "draft-deleted",
      draftAgentId: provisionalId,
      revision: deleted.revision,
    })
    this.#publishAgentCatalog()
  }

  async retryAgentDraft(provisionalId: string) {
    const threadId = readDraftThreadId(provisionalId)
    if (!threadId) throw new Error("Invalid Agent draft ID")
    const session = await this.#findDraftSession(threadId)
    const metadata = readAgentDraftMetadata(session.metadata)
    if (!metadata) throw new Error("Agent draft metadata is unavailable")
    if (metadata.phase === "start-failed") {
      const messages = await this.#client.session.messages(
        { sessionID: threadId, limit: 100 },
        REQUEST_OPTIONS
      )
      if (!transcriptHasKickoff(messages.data)) {
        await this.#sendBuilderKickoff(threadId)
      }
      const interviewing = nextAgentDraftMetadata(metadata, {
        phase: "interview",
        lastError: undefined,
      })
      await this.#persistDraft(threadId, interviewing)
      this.#emitLifecycle({
        type: "draft-updated",
        draftAgentId: provisionalId,
        revision: interviewing.revision,
      })
      return
    }
    if (metadata.phase === "activation-failed" && metadata.candidate) {
      const activating = nextAgentDraftMetadata(metadata, {
        phase: "activating",
        lastError: undefined,
      })
      await this.#persistDraft(threadId, activating)
      this.#emitLifecycle({
        type: "draft-updated",
        draftAgentId: provisionalId,
        revision: activating.revision,
      })
      await this.#resumeActivation(threadId)
      return
    }
    throw new Error("This Agent draft is not waiting for a retry")
  }

  async #sendBuilderKickoff(threadId: string) {
    await this.#client.session.promptAsync(
      {
        sessionID: threadId,
        agent: AGENT_BUILDER_ID,
        parts: [{ type: "text", text: AGENT_BUILDER_KICKOFF }],
      },
      REQUEST_OPTIONS
    )
  }

  async #findDraftSession(threadId: string) {
    const sessions = await this.#client.experimental.session.list(
      { roots: true, archived: true },
      REQUEST_OPTIONS
    )
    const session = (sessions.data ?? []).find(
      (candidate) =>
        candidate.id === threadId && candidate.agent === AGENT_BUILDER_ID
    )
    if (!session) throw new Error(`Agent draft Session not found: ${threadId}`)
    return session
  }

  async #persistDraft(threadId: string, metadata: AgentDraftMetadata) {
    await this.#client.session.update(
      { sessionID: threadId, metadata: { aos_ui: metadata } },
      REQUEST_OPTIONS
    )
  }

  async #recoverActivationReceipt(
    threadId: string,
    metadata: AgentDraftMetadata
  ) {
    if (
      metadata.candidate ||
      metadata.phase === "promoted" ||
      metadata.phase === "deleted"
    ) {
      return metadata
    }
    const messages = await this.#client.session.messages(
      { sessionID: threadId, limit: 100 },
      REQUEST_OPTIONS
    )
    const candidate = readAgentCreatedFromMessages(messages.data, threadId)
    if (!candidate) return metadata

    const activating = nextAgentDraftMetadata(metadata, {
      phase: "activating",
      candidate,
      lastError: undefined,
    })
    await this.#persistDraft(threadId, activating)
    this.#emitLifecycle({
      type: "draft-updated",
      draftAgentId: draftAgentId(threadId),
      revision: activating.revision,
    })
    this.#publishAgentCatalog()
    return activating
  }

  #emitLifecycle(event: AgentLifecycleEvent) {
    for (const { listener } of this.#lifecycleListeners) {
      listener(structuredClone(event))
    }
    if (event.type === "draft-promoted") {
      this.#emitActivity({
        id: `opencode:agent-ready:${openCodeActivityIdPart(event.draftAgentId)}:${event.revision}`,
        agentId: event.agentId,
        threadId: event.threadId,
        occurredAt: new Date().toISOString(),
        type: "agent-ready",
      })
    }
  }

  #publishAgentCatalog() {
    for (const { listener } of this.#agentCatalogListeners) listener()
  }

  #replaceAgentCatalogDiagnostics(diagnostics: Error[]) {
    const revision = ++this.#agentCatalogDiagnosticRevision
    this.#agentCatalogDiagnostics = diagnostics
    if (diagnostics.length === 0) return

    setTimeout(() => {
      if (revision !== this.#agentCatalogDiagnosticRevision) return
      for (const entry of this.#agentCatalogListeners) {
        this.#deliverAgentCatalogDiagnostics(entry, revision)
      }
    }, 0)
  }

  #deliverAgentCatalogDiagnostics(
    entry: AgentCatalogSubscription,
    revision: number
  ) {
    if (
      revision !== this.#agentCatalogDiagnosticRevision ||
      entry.diagnosticRevision >= revision
    ) {
      return
    }
    entry.diagnosticRevision = revision
    for (const diagnostic of this.#agentCatalogDiagnostics) {
      entry.onError?.(new Error(diagnostic.message))
    }
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

      const createdAgent = readAgentCreatedEvent(event)
      if (createdAgent) {
        const toolKey = `${createdAgent.threadId}\u0000${createdAgent.candidate.callId}`
        if (!this.#observedToolCalls.has(toolKey)) {
          this.#observedToolCalls.add(toolKey)
          void this.#beginActivation(
            createdAgent.threadId,
            createdAgent.candidate
          ).catch((reason: unknown) => {
            // Persisted lifecycle state remains authoritative. Removing only
            // the process-local replay key lets a later provider replay
            // recover a pre-persistence transport failure without causing an
            // activation-failed draft to retry automatically.
            this.#observedToolCalls.delete(toolKey)
            this.#publishLifecycleError(reason)
          })
        }
      }

      if (
        event.type === "session.idle" ||
        event.type === "session.status" ||
        event.type === "stream.reconnected"
      ) {
        void this.#resumePendingActivations().catch((reason: unknown) =>
          this.#publishLifecycleError(reason)
        )
      }

      if (
        event.type === "session.created" ||
        event.type === "session.updated" ||
        event.type === "session.deleted"
      ) {
        this.#publishAgentCatalog()
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
    const agentId =
      providerAgentId === AGENT_BUILDER_ID
        ? draftAgentId(signal.threadId)
        : providerAgentId
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

  async #beginActivation(threadId: string, candidate: AgentDraftCandidate) {
    const session = await this.#findDraftSession(threadId)
    const current = readAgentDraftMetadata(session.metadata)
    if (
      !current ||
      current.phase === "deleted" ||
      current.phase === "promoted"
    ) {
      return
    }
    if (current.candidate) {
      const isSameReceipt =
        current.candidate.callId === candidate.callId &&
        current.candidate.agentId === candidate.agentId &&
        current.candidate.name === candidate.name &&
        current.candidate.description === candidate.description
      if (isSameReceipt && current.phase === "activating") {
        await this.#resumeActivation(threadId)
      }
      // A persisted receipt wins over all stream replays and later spoofed
      // candidates. Failed activation resumes only through retryAgentDraft.
      return
    }
    const activating = nextAgentDraftMetadata(current, {
      phase: "activating",
      candidate,
      lastError: undefined,
    })
    await this.#persistDraft(threadId, activating)
    this.#emitLifecycle({
      type: "draft-updated",
      draftAgentId: draftAgentId(threadId),
      revision: activating.revision,
    })
    this.#publishAgentCatalog()
    await this.#resumeActivation(threadId)
  }

  async #resumePendingActivations() {
    const sessions = await this.#client.experimental.session.list(
      { roots: true, archived: false },
      REQUEST_OPTIONS
    )
    await Promise.all(
      (sessions.data ?? []).flatMap((session) => {
        const metadata = readAgentDraftMetadata(session.metadata)
        return session.agent === AGENT_BUILDER_ID &&
          metadata?.phase === "activating"
          ? [this.#resumeActivation(session.id)]
          : []
      })
    )
  }

  async #resumeActivation(threadId: string) {
    if (this.#activationInFlight.has(threadId)) return
    this.#activationInFlight.add(threadId)
    try {
      const session = await this.#findDraftSession(threadId)
      let metadata = readAgentDraftMetadata(session.metadata)
      if (metadata?.phase !== "activating") return
      if (!metadata.candidate) {
        metadata = await this.#recoverActivationReceipt(threadId, metadata)
      }
      const candidate = metadata.candidate
      if (!candidate) return

      const statusResponse = await this.#client.session.status(
        {},
        REQUEST_OPTIONS
      )
      const hasActiveSession = Object.values(statusResponse.data ?? {}).some(
        (status) => status.type === "busy" || status.type === "retry"
      )
      if (hasActiveSession) return

      const reloadAndVerify = async () => {
        await this.#client.instance.dispose({}, REQUEST_OPTIONS)
        const agentResponse = await this.#client.app.agents({}, REQUEST_OPTIONS)
        const readyAgent = (agentResponse.data ?? []).find((agent) => {
          if (
            agent.name !== candidate.agentId ||
            agent.native === true ||
            agent.hidden ||
            (agent.mode !== "primary" && agent.mode !== "all")
          ) {
            return false
          }
          const summary = toAgentSummary(agent)
          return (
            summary.name === candidate.name &&
            summary.description === candidate.description
          )
        })
        if (!readyAgent) {
          throw new Error(
            `OpenCode did not discover Agent ${candidate.agentId}`
          )
        }
        return readyAgent
      }
      await this.#ownership.withReloadBarrier(reloadAndVerify)

      const sessionsResponse = await this.#client.experimental.session.list(
        { roots: true, archived: true },
        REQUEST_OPTIONS
      )
      let firstSession: Pick<Session, "id" | "agent"> | undefined = (
        sessionsResponse.data ?? []
      ).find((sessionCandidate) => {
        if (sessionCandidate.agent !== candidate.agentId) return false
        if (
          !isRecord(sessionCandidate.metadata) ||
          !isRecord(sessionCandidate.metadata.aos_ui)
        ) {
          return false
        }
        return (
          sessionCandidate.metadata.aos_ui.version === 1 &&
          sessionCandidate.metadata.aos_ui.kind === "agent-first-session" &&
          sessionCandidate.metadata.aos_ui.draftThreadId === threadId
        )
      })
      if (!firstSession) {
        const created = await this.#client.session.create(
          {
            agent: candidate.agentId,
            title:
              metadata.labels?.firstSessionTitle ?? AGENT_FIRST_SESSION_TITLE,
            metadata: {
              aos_ui: {
                version: 1,
                kind: "agent-first-session",
                draftThreadId: threadId,
              },
            },
          },
          REQUEST_OPTIONS
        )
        firstSession = created.data
      }
      if (!firstSession?.id || firstSession.agent !== candidate.agentId) {
        throw new Error("OpenCode did not create the Agent's first Session")
      }
      this.#ownership.remember(firstSession.id, candidate.agentId)
      const promoted = nextAgentDraftMetadata(metadata, {
        phase: "promoted",
        promotedAgentId: candidate.agentId,
        firstSessionId: firstSession.id,
        lastError: undefined,
      })
      await this.#persistDraft(threadId, promoted)
      this.#emitLifecycle({
        type: "draft-promoted",
        draftAgentId: draftAgentId(threadId),
        agentId: candidate.agentId,
        threadId: firstSession.id,
        revision: promoted.revision,
      })
      this.#publishAgentCatalog()
    } catch (reason) {
      const error = toError(reason)
      try {
        const session = await this.#findDraftSession(threadId)
        const metadata = readAgentDraftMetadata(session.metadata)
        if (
          metadata &&
          metadata.phase !== "promoted" &&
          metadata.phase !== "deleted"
        ) {
          const failed = nextAgentDraftMetadata(metadata, {
            phase: "activation-failed",
            lastError: error.message,
          })
          await this.#persistDraft(threadId, failed)
          this.#emitLifecycle({
            type: "draft-updated",
            draftAgentId: draftAgentId(threadId),
            revision: failed.revision,
          })
          this.#emitActivity({
            id: `opencode:agent-activation-failed:${openCodeActivityIdPart(draftAgentId(threadId))}:${failed.revision}`,
            agentId: draftAgentId(threadId),
            threadId,
            occurredAt: new Date().toISOString(),
            type: "agent-activation-failed",
          })
          this.#publishAgentCatalog()
        }
      } catch {
        // Preserve the originating activation error; retry remains available
        // once provider metadata can be read again.
      }
      throw error
    } finally {
      this.#activationInFlight.delete(threadId)
    }
  }

  #publishLifecycleError(reason: unknown) {
    const error = toError(reason)
    for (const entry of this.#lifecycleListeners) entry.onError?.(error)
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
      this.#lifecycleListeners.size > 0 ||
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
