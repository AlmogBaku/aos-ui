import {
  RuntimeAuthStateSchema,
  RuntimeInfoSchema,
  SessionHistoryResponseSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
  type AgentCatalogResponse,
  type RuntimeAuthState,
  type RuntimeInfo,
  type Session,
  type SessionAttachmentStageRequest,
  type SessionCatalogResponse,
  type SessionHistoryResponse,
  type SessionModelUpdateRequest,
  type SessionPlanActivityMessage,
  type VisibilityUpdateResponse,
} from "../../../protocol"
import type {
  ServerAttachmentStage,
  ServerTurnEngine,
  ServerRuntime,
} from "../../core/runtime"
import { projectTodos } from "../todos"
import {
  OpenCodeClientAbortError,
  OpenCodeClientError,
  OpenCodeMutationUncertainError,
  type OpenCodeClient,
  type OpenCodePageOptions,
  type OpenCodeSessionEvents,
} from "./client"
import { openCodeCapabilities } from "./capabilities"
import { OpenCodeContent, OpenCodeContentUnavailableError } from "./content"
import { projectOpenCodeHistory } from "./history"
import { OPENCODE_TODO_STATUS_ALIASES } from "./todos"
import {
  OpenCodeInteractionPublicError,
  OpenCodeInteractions,
} from "./interactions"
import {
  parseOpenCodeMessageCatalog,
  parseOpenCodeModelCatalog,
  parseOpenCodeSession,
} from "./native-schemas"
import {
  OpenCodeEventValidationError,
  validateOpenCodeLiveEvent,
} from "./events"
import {
  createOpenCodeWorkspaceOperations,
  OpenCodeWorkspaceScopeError,
  OpenCodeWorkspaceUnavailableError,
  type OpenCodeWorkspaceOperations,
} from "./workspace"

const MAX_HISTORY_PAGE_SIZE = 100
const MAX_HISTORY_PAGES = 100

/** The assembly seam deliberately excludes coordinator-owned run state. */
export type OpenCodeAdapterClient = Readonly<{
  catalog: Pick<OpenCodeClient["catalog"], "agents" | "models">
  sessions: Pick<
    OpenCodeClient["sessions"],
    | "list"
    | "get"
    | "create"
    | "update"
    | "delete"
    | "switchModel"
    | "messages"
    | "context"
    | "todos"
    | "events"
    | "active"
    | "history"
    | "prompt"
    | "interrupt"
    | "wait"
    | "questions"
    | "permissions"
  >
  close(): Promise<void>
}>

export type OpenCodeServerAdapterOptions = Readonly<{
  client: OpenCodeAdapterClient
  /** Created by the native turns leaf; coordinator admission remains central. */
  turns: ServerTurnEngine
  /** Factory supplies the one shared native-interaction authority. */
  interactions?: OpenCodeInteractions
  creatorAgentId?: string
}>

function identifier(value: string) {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )
}

function unavailableRuntimeInfo(): RuntimeInfo {
  return RuntimeInfoSchema.parse({
    runtime: { id: "opencode", name: "OpenCode" },
    status: "unavailable",
    capabilities: {
      agentCatalog: {
        status: "unavailable",
        reason: "temporarily-unavailable",
      },
      agentVisibility: {
        status: "unavailable",
        reason: "native-agent-catalog-read-only",
      },
      sessionCatalog: {
        status: "unavailable",
        reason: "temporarily-unavailable",
      },
      sessionHistory: {
        status: "unavailable",
        reason: "temporarily-unavailable",
      },
      sessionDetail: {
        status: "unavailable",
        reason: "temporarily-unavailable",
      },
      sessionCreation: {
        status: "unavailable",
        reason: "temporarily-unavailable",
      },
      sessionTitle: {
        status: "unavailable",
        reason: "temporarily-unavailable",
      },
      sessionArchival: {
        status: "unavailable",
        reason: "temporarily-unavailable",
      },
      sessionPin: { status: "unavailable", reason: "temporarily-unavailable" },
      sessionDeletion: {
        status: "unavailable",
        reason: "temporarily-unavailable",
      },
      sessionTurn: { status: "unavailable", reason: "temporarily-unavailable" },
      sessionStop: { status: "unavailable", reason: "temporarily-unavailable" },
      sessionSteer: {
        status: "unavailable",
        reason: "native-steering-unproven",
      },
      sessionReadState: {
        status: "unavailable",
        reason: "native-session-read-state-unavailable",
      },
    },
  })
}

function readyRuntimeInfo(): RuntimeInfo {
  return RuntimeInfoSchema.parse({
    runtime: { id: "opencode", name: "OpenCode" },
    status: "ready",
    capabilities: {
      agentCatalog: { status: "available" },
      agentVisibility: {
        status: "unavailable",
        reason: "native-agent-catalog-read-only",
      },
      sessionCatalog: {
        status: "available",
        scope: "workspace",
        order: "recent",
        defaultPageSize: 50,
        maxPageSize: 100,
        maxWindow: 1_000,
      },
      sessionHistory: {
        status: "available",
        order: "chronological",
        compacted: true,
        loading: "on-open",
        defaultPageSize: 200,
        maxPageSize: 500,
      },
      sessionDetail: { status: "available" },
      sessionCreation: { status: "available" },
      sessionTitle: { status: "available" },
      sessionArchival: { status: "available" },
      sessionPin: { status: "available" },
      sessionDeletion: { status: "available" },
      sessionTurn: { status: "available" },
      sessionStop: { status: "available" },
      sessionSteer: {
        status: "unavailable",
        reason: "native-steering-unproven",
      },
      sessionReadState: {
        status: "unavailable",
        reason: "native-session-read-state-unavailable",
      },
    },
  })
}

export class OpenCodeServerAdapter implements ServerRuntime {
  readonly turns: ServerTurnEngine
  readonly interactions: OpenCodeInteractions
  readonly #workspace: OpenCodeWorkspaceOperations
  readonly #content = new OpenCodeContent()
  readonly #invalidations = new Set<() => void>()
  #closePromise: Promise<void> | undefined

  constructor(private readonly options: OpenCodeServerAdapterOptions) {
    this.turns = options.turns
    this.#workspace = createOpenCodeWorkspaceOperations({
      client: options.client,
      creatorAgentId: options.creatorAgentId,
    })
    this.interactions =
      options.interactions ??
      new OpenCodeInteractions({
        questions: options.client.sessions.questions,
        permissions: options.client.sessions.permissions,
      })
  }

  resolveSessionId(agentId: string, publicSessionId: string) {
    return identifier(agentId) && identifier(publicSessionId)
      ? publicSessionId
      : undefined
  }

  resolveInvitedSession(
    agentId: string,
    ref: string,
    create?: { firstTurnInstruction?: string }
  ) {
    return this.#workspace.resolveInvitedSession(agentId, ref, create)
  }

  publicError(cause: unknown) {
    if (cause instanceof OpenCodeMutationUncertainError)
      return { code: "uncertain_mutation", status: 503 } as const
    if (
      cause instanceof OpenCodeClientAbortError ||
      (cause instanceof OpenCodeClientError &&
        cause.code === "connection_interrupted")
    )
      return { code: "connection_interrupted", status: 503 } as const
    if (cause instanceof OpenCodeClientError) {
      if (cause.code === "authentication")
        return { code: "runtime_authentication_required", status: 401 } as const
      if (cause.code === "invalid_request")
        return { code: "invalid_request", status: 400 } as const
      if (cause.code === "not_found")
        return { code: "not_found", status: 404 } as const
      if (cause.code === "conflict")
        return { code: "revision_conflict", status: 409 } as const
      return { code: "temporarily_unavailable", status: 503 } as const
    }
    if (cause instanceof OpenCodeWorkspaceScopeError)
      return { code: "not_found", status: 404 } as const
    if (cause instanceof OpenCodeWorkspaceUnavailableError)
      return { code: "temporarily_unavailable", status: 503 } as const
    if (cause instanceof OpenCodeContentUnavailableError)
      return { code: "temporarily_unavailable", status: 503 } as const
    if (cause instanceof OpenCodeInteractionPublicError) {
      if (cause.code === "AOS_INTERACTION_NOT_FOUND")
        return { code: "not_found", status: 404 } as const
      if (cause.code === "AOS_MUTATION_UNCERTAIN")
        return { code: "uncertain_mutation", status: 503 } as const
      if (
        cause.code === "AOS_PROVIDER_UNAVAILABLE" ||
        cause.code === "AOS_PROVIDER_INVALID_RESPONSE"
      )
        return { code: "temporarily_unavailable", status: 503 } as const
      return { code: "invalid_request", status: 400 } as const
    }
    return undefined
  }

  async authState(): Promise<RuntimeAuthState> {
    try {
      await this.listAgents()
      return RuntimeAuthStateSchema.parse({ status: "authenticated" })
    } catch (error) {
      if (this.publicError(error)?.code === "runtime_authentication_required")
        return RuntimeAuthStateSchema.parse({
          status: "authentication-required",
        })
      return RuntimeAuthStateSchema.parse({
        status: "unavailable",
        reason: "temporarily-unavailable",
      })
    }
  }

  async runtimeInfo(): Promise<RuntimeInfo> {
    try {
      await this.listAgents()
      return readyRuntimeInfo()
    } catch (error) {
      if (this.publicError(error)?.code === "runtime_authentication_required")
        throw error
      return unavailableRuntimeInfo()
    }
  }

  listAgents(): Promise<AgentCatalogResponse> {
    return this.#workspace.listAgents()
  }

  async updateAgentVisibility(
    agentId: string,
    visibility: "visible" | "hidden",
    observedRevision: string
  ): Promise<VisibilityUpdateResponse> {
    void [agentId, visibility, observedRevision]
    throw new OpenCodeWorkspaceUnavailableError()
  }

  listAllSessions(
    limit: number,
    offset: number
  ): Promise<SessionCatalogResponse> {
    return this.#workspace.listAllSessions(limit, offset)
  }

  listSessions(
    agentId: string,
    limit: number,
    offset: number
  ): Promise<SessionCatalogResponse> {
    return this.#workspace.listSessions(agentId, limit, offset)
  }

  async history(
    agentId: string,
    sessionId: string,
    limit: number,
    offset: number
  ): Promise<SessionHistoryResponse> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new OpenCodeClientError("invalid_request")
    await this.getSession(agentId, sessionId)
    const required = offset + limit + 1
    if (!Number.isSafeInteger(required))
      throw new OpenCodeClientError("invalid_request")
    const { messages, hasMore } = await this.#readHistory(sessionId, required)
    const page: Array<(typeof messages)[number] | SessionPlanActivityMessage> =
      messages.slice(offset, offset + limit)
    const nextOffset = offset + page.length
    const total = hasMore
      ? Math.max(messages.length, nextOffset + 1)
      : messages.length
    const todos = await this.#todos(sessionId)
    if (todos)
      page.push({
        id: `aos-plan:${sessionId}`,
        role: "activity",
        activityType: "PLAN",
        content: { todos },
      })
    return SessionHistoryResponseSchema.parse({
      sessionId,
      messages: page,
      total,
      limit,
      offset,
      nextOffset,
    })
  }

  /**
   * The Session's own authoritative Todo list, read once per history load. A
   * Session the provider cannot answer for has no plan rather than a stale or
   * invented one, and history still loads either way.
   */
  async #todos(sessionId: string) {
    try {
      return projectTodos(
        { todos: await this.options.client.sessions.todos(sessionId) },
        OPENCODE_TODO_STATUS_ALIASES
      )
    } catch {
      return undefined
    }
  }

  getSession(agentId: string, sessionId: string): Promise<Session> {
    return this.#workspace.getSession(agentId, sessionId)
  }

  async createSession(agentId: string, title?: string) {
    if (title !== undefined) throw new OpenCodeWorkspaceUnavailableError()
    return this.#workspace.createSession(agentId)
  }

  async mutateSession(
    agentId: string,
    sessionId: string,
    method: "PATCH" | "DELETE",
    body?: unknown
  ) {
    await (method === "DELETE"
      ? this.#workspace.deleteSession(agentId, sessionId)
      : this.#workspace.patchSession(agentId, sessionId, body))
  }

  async workspaceCapabilities(agentId: string, publicSessionId: string) {
    await this.getSession(agentId, publicSessionId)
    const { agentVisibility, ...workspace } = this.#workspace.capabilities()
    void agentVisibility
    return SessionWorkspaceCapabilitiesResponseSchema.parse({
      workspace,
      ...openCodeCapabilities(),
    })
  }

  async models(agentId: string, publicSessionId: string) {
    const { selectedId, options } = await this.#models(agentId, publicSessionId)
    return { selectedId, options }
  }

  async updateModel(
    agentId: string,
    publicSessionId: string,
    patch: SessionModelUpdateRequest
  ) {
    // OpenCode reports no reasoning ladder, so it can never settle an effort.
    if (patch.effortId !== undefined || patch.selectedId === undefined)
      throw new OpenCodeWorkspaceUnavailableError()
    const selectedId = patch.selectedId
    const options = await this.#models(agentId, publicSessionId)
    const selected = options.native.get(selectedId)
    if (!selected) throw new OpenCodeWorkspaceUnavailableError()
    await this.options.client.sessions.switchModel(publicSessionId, selected)
    return { selectedId }
  }

  async context(agentId: string, publicSessionId: string) {
    await this.getSession(agentId, publicSessionId)
    // The pinned SDK's session.context response is `data: SessionMessage[]`,
    // not a provider token/accounting metric. Do not invent an estimate.
    throw new OpenCodeWorkspaceUnavailableError()
  }

  async subscribeSessionInvalidation(
    agentId: string,
    publicSessionId: string,
    listener: () => void,
    reset?: () => void
  ): Promise<() => void> {
    await this.getSession(agentId, publicSessionId)
    const controller = new AbortController()
    let source: OpenCodeSessionEvents | undefined
    let released = false
    let lastSeen: number | undefined
    const release = () => {
      if (released) return
      released = true
      this.#invalidations.delete(release)
      controller.abort()
      source?.abort()
    }
    const fail = () => {
      if (released) return
      release()
      reset?.()
    }
    try {
      source = await this.options.client.sessions.events(publicSessionId, {
        signal: controller.signal,
      })
    } catch (error) {
      release()
      throw error
    }
    this.#invalidations.add(release)
    void (async () => {
      try {
        for await (const envelope of source!) {
          if (released) return
          const event = validateOpenCodeLiveEvent(envelope, publicSessionId)
          if (lastSeen !== undefined && event.seq !== lastSeen + 1)
            throw new OpenCodeEventValidationError()
          lastSeen = event.seq
          listener()
        }
        fail()
      } catch {
        fail()
      }
    })()
    return release
  }

  async stageAttachments(
    agentId: string,
    publicSessionId: string,
    attachments: SessionAttachmentStageRequest["attachments"]
  ): Promise<ServerAttachmentStage> {
    await this.getSession(agentId, publicSessionId)
    return this.#content.stage(attachments)
  }

  async artifact(
    agentId: string,
    publicSessionId: string,
    artifactId: string
  ): Promise<{ bytes: Uint8Array; mimeType?: string; filename: string }> {
    await this.getSession(agentId, publicSessionId)
    void artifactId
    throw new OpenCodeContentUnavailableError()
  }

  async transcribe(
    agentId: string,
    bytes: Uint8Array,
    mimeType: string,
    signal?: AbortSignal
  ): Promise<string> {
    void [agentId, bytes, mimeType, signal]
    throw new OpenCodeContentUnavailableError()
  }

  async speak(
    agentId: string,
    text: string,
    signal?: AbortSignal
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    void [agentId, text, signal]
    throw new OpenCodeContentUnavailableError()
  }

  close() {
    this.#closePromise ??= Promise.resolve().then(async () => {
      for (const release of [...this.#invalidations]) release()
      await this.options.client.close()
    })
    return this.#closePromise
  }

  async #readHistory(sessionId: string, required: number) {
    const raw: unknown[] = []
    const seenMessages = new Set<string>()
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const options: OpenCodePageOptions = cursor
        ? { limit: MAX_HISTORY_PAGE_SIZE, cursor }
        : { limit: MAX_HISTORY_PAGE_SIZE, order: "asc" }
      const parsed = parseOpenCodeMessageCatalog(
        await this.options.client.sessions.messages(sessionId, options)
      )
      if (!parsed.success) throw new OpenCodeWorkspaceUnavailableError()
      for (const message of parsed.data.data) {
        if (seenMessages.has(message.id))
          throw new OpenCodeWorkspaceUnavailableError()
        seenMessages.add(message.id)
        raw.push(message)
      }
      const messages = projectOpenCodeHistory({ messages: raw, sessionId })
      const next = parsed.data.cursor.next
      if (!next) return { messages, hasMore: false }
      if (messages.length >= required) return { messages, hasMore: true }
      if (seenCursors.has(next)) throw new OpenCodeWorkspaceUnavailableError()
      seenCursors.add(next)
      cursor = next
    }
    throw new OpenCodeWorkspaceUnavailableError()
  }

  async #models(agentId: string, sessionId: string) {
    await this.getSession(agentId, sessionId)
    const session = parseOpenCodeSession(
      await this.options.client.sessions.get(sessionId)
    )
    if (
      !session.success ||
      session.data.agent !== agentId ||
      !session.data.model
    )
      throw new OpenCodeWorkspaceUnavailableError()
    const catalog = parseOpenCodeModelCatalog(
      await this.options.client.catalog.models()
    )
    if (!catalog.success) throw new OpenCodeWorkspaceUnavailableError()
    const native = new Map<
      string,
      { providerID: string; id: string; variant?: string }
    >()
    const options = catalog.data.data.flatMap((model) => {
      if (!model.enabled) return []
      const id = JSON.stringify([model.providerID, model.id])
      if (!identifier(id) || native.has(id))
        throw new OpenCodeWorkspaceUnavailableError()
      native.set(id, { providerID: model.providerID, id: model.id })
      return [{ id, label: model.name, group: model.providerID }]
    })
    const selectedId = JSON.stringify([
      session.data.model.providerID,
      session.data.model.id,
    ])
    if (!identifier(selectedId) || !native.has(selectedId))
      throw new OpenCodeWorkspaceUnavailableError()
    return { selectedId, options, native }
  }
}
