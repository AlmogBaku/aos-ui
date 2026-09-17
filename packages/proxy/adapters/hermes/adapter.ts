import {
  AgentCatalogResponseSchema,
  RuntimeInfoSchema,
  SessionCatalogResponseSchema,
  SessionCreateResponseSchema,
  SessionHistoryResponseSchema,
  SessionSchema,
  SESSION_CATALOG_MAX_WINDOW,
  VisibilityUpdateResponseSchema,
  type AgentCatalogEntry,
  type AgentCatalogResponse,
  type RuntimeAuthState,
  type RuntimeInfo,
  type SessionMessage,
  type VisibilityUpdateResponse,
} from "../../../protocol"
import {
  HermesAuthenticationError,
  HermesHttpError,
  HermesUnavailableError,
  throwUnavailable,
  type HermesLog,
  type HermesRpcTransport,
} from "./gateway"
import { projectHermesHistory } from "./history"
import { publishedArtifact } from "./media-artifacts"
import {
  HermesRunEngine,
  HermesRunPublicError,
  type HermesRunScope,
} from "./run"
import { HermesNativeRuntime, type HermesRunNative } from "./run-native"
import {
  createHermesWorkspaceOperations,
  HermesWorkspaceScopeError,
  HermesWorkspaceUnavailableError,
  latestHermesTodos,
  type HermesWorkspaceOperations,
  type HermesWorkspaceSession,
} from "./workspace"
import {
  createHermesContentOperations,
  decodeDataUrl,
  HermesContentScopeError,
  HermesContentUnavailableError,
  type HermesContentAttachment,
} from "./content"
import {
  HermesInteractionPublicError,
  HermesInteractions,
} from "./interactions"
import { HermesDashboardClient } from "./dashboard-client"
import {
  HermesAttachmentRegistry,
  HermesSessionGoneError,
  isSessionGone,
} from "./attachment-registry"
import type { ServerRuntime } from "../../core/runtime"
import { nativeSlashCommands } from "./slash-commands"
import { isRecord, nativeId, timestamp, trimmedText } from "./native"

export type { HermesRpcTransport } from "./gateway"

export class HermesRevisionConflictError extends Error {
  constructor() {
    super("Agent visibility revision conflict")
    this.name = "HermesRevisionConflictError"
  }
}

export { HermesUnavailableError }

export class HermesAgentNotFoundError extends Error {
  constructor() {
    super("Agent not found")
    this.name = "HermesAgentNotFoundError"
  }
}

export class HermesSessionNotFoundError extends Error {
  constructor() {
    super("Session not found")
    this.name = "HermesSessionNotFoundError"
  }
}

export class HermesSessionConflictError extends Error {
  constructor() {
    super("Session mutation conflict")
    this.name = "HermesSessionConflictError"
  }
}

type NativeRecord = Record<string, unknown>

function historyPagination(
  requestedLimit: number,
  requestedOffset: number,
  messageCount: number,
  value: unknown
) {
  const nextOffset = requestedOffset + messageCount
  if (!Number.isSafeInteger(nextOffset)) throw new HermesUnavailableError()
  if (value === undefined) return { total: nextOffset, nextOffset }
  if (!isRecord(value)) throw new HermesUnavailableError()

  const { limit, offset, returned } = value
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) <= 0 ||
    (limit as number) > requestedLimit ||
    !Number.isSafeInteger(offset) ||
    offset !== requestedOffset ||
    !Number.isSafeInteger(returned) ||
    (returned as number) < 0 ||
    (returned as number) > (limit as number) ||
    returned !== messageCount
  )
    throw new HermesUnavailableError()

  if (Object.prototype.hasOwnProperty.call(value, "total")) {
    if (
      !Number.isSafeInteger(value.total) ||
      (value.total as number) < nextOffset
    )
      throw new HermesUnavailableError()
    return { total: value.total as number, nextOffset }
  }

  if (returned !== limit) return { total: nextOffset, nextOffset }
  const continuationTotal = nextOffset + 1
  if (!Number.isSafeInteger(continuationTotal))
    throw new HermesUnavailableError()
  return { total: continuationTotal, nextOffset }
}

function validLiveSessionId(value: unknown): value is string {
  return nativeId(value, 256) !== undefined
}

function nativeRevision(profile: NativeRecord) {
  const revisions = isRecord(profile.ui_meta_revisions)
    ? profile.ui_meta_revisions
    : undefined
  const revision = revisions?.["hermes-bots"]
  return typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision >= 0
    ? revision
    : undefined
}

function nativeBots(profile: NativeRecord) {
  const uiMeta = isRecord(profile.ui_meta) ? profile.ui_meta : {}
  return isRecord(uiMeta["hermes-bots"]) ? uiMeta["hermes-bots"] : {}
}

function projectProfile(profile: NativeRecord): AgentCatalogEntry {
  const id = trimmedText(profile.name)
  if (!id) throw new HermesUnavailableError()
  const uiMeta = isRecord(profile.ui_meta) ? profile.ui_meta : {}
  const aos = isRecord(uiMeta.aos) ? uiMeta.aos : {}
  const bots = nativeBots(profile)
  const revision = nativeRevision(profile)
  const visibility =
    bots.hidden === true ? ("hidden" as const) : ("visible" as const)
  const creator = aos.role === "creator"
  return {
    summary: {
      kind: "ready",
      id,
      name: trimmedText(profile.display_name) ?? id,
      ...(trimmedText(profile.description)
        ? { description: trimmedText(profile.description) }
        : {}),
      visibility,
      ...(creator ? { role: "creator" as const } : {}),
    },
    visibility,
    selectable: visibility === "visible" && !creator,
    editable: revision !== undefined && !creator,
    revision:
      revision === undefined ? "unavailable" : `hermes-bots:${revision}`,
  }
}

function nativeProfiles(payload: unknown): NativeRecord[] {
  if (!isRecord(payload) || !Array.isArray(payload.profiles))
    throw new HermesUnavailableError()
  const profiles = payload.profiles
  if (!profiles.every(isRecord)) throw new HermesUnavailableError()
  return profiles
}

function catalogRevision(agents: readonly AgentCatalogEntry[]) {
  return `profiles:${agents
    .map(({ summary, revision }) => `${summary.id}@${revision}`)
    .sort()
    .join(",")}`
}

function sessionId(_profile: string, storedId: string) {
  return storedId
}

function storedSessionIdentity(_profile: string, publicId: string) {
  return publicId.length > 0 && publicId.length <= 256 ? publicId : undefined
}

function attachmentInfoKey(agentId: string, sessionId: string) {
  return `${agentId}\u0000${sessionId}`
}

export class HermesServerAdapter implements ServerRuntime {
  readonly #dashboard?: HermesDashboardClient
  readonly #workspace: HermesWorkspaceOperations
  readonly #content: ReturnType<typeof createHermesContentOperations>
  readonly #attachments: HermesAttachmentRegistry
  readonly #attachmentInfo = new Map<string, NativeRecord>()
  readonly #invitedSessionCreates = new Map<
    string,
    Promise<{ sessionId: string; created: boolean }>
  >()
  readonly interactions: HermesInteractions
  /** The typed native run boundary; `run-native.ts` owns every native outcome. */
  readonly native: HermesRunNative
  readonly runs: HermesRunEngine

  constructor(
    private readonly transport: HermesRpcTransport,
    options: { sessionIdleMs?: number; log?: HermesLog } = {}
  ) {
    this.#dashboard = transport.http
      ? new HermesDashboardClient((path, init) => transport.http!(path, init))
      : undefined
    const requireSession = (agentId: string, publicSessionId: string) =>
      this.#requireAttachedSession(agentId, publicSessionId)
    this.#workspace = createHermesWorkspaceOperations({
      authority: { requireSession },
      transport: {
        request: (method, params) => this.transport.request(method, params),
        history: (scope) => this.#rawHistory(scope),
        sessionInfo: async (scope) =>
          (scope as HermesWorkspaceSession & { info?: unknown }).info,
      },
    })
    this.#content = createHermesContentOperations({
      authority: {
        requireSession,
        requireArtifact: async (scope, artifactId) =>
          publishedArtifact(await this.#rawHistory(scope), artifactId),
      },
      transport: {
        request: (method, params, maxResponseBytes) =>
          this.transport.request(method, params, { maxResponseBytes }),
        readArtifact: async (scope, reference, maxBytes, maxResponseBytes) => {
          if (!this.#dashboard) throw new HermesUnavailableError()
          const storedId = storedSessionIdentity(scope.agentId, scope.sessionId)
          if (!storedId) throw new HermesUnavailableError()
          const payload = await this.#dashboard.readArtifactDataUrl(
            scope.agentId,
            storedId,
            reference,
            maxResponseBytes
          )
          const decoded = decodeDataUrl(
            isRecord(payload) ? payload.dataUrl : undefined,
            maxBytes
          )
          if (!decoded) throw new HermesUnavailableError()
          return decoded
        },
        audioConfig: async (scope, kind, maxResponseBytes) => {
          if (!this.#dashboard) throw new HermesUnavailableError()
          return this.#dashboard.getAudioConfig(
            scope.agentId,
            kind,
            maxResponseBytes
          )
        },
        transcribe: async (scope, request, _signal, maxResponseBytes) => {
          if (!this.#dashboard) throw new HermesUnavailableError()
          return this.#dashboard.transcribe(
            scope.agentId,
            request,
            maxResponseBytes
          )
        },
        speak: async (scope, text, _signal, maxResponseBytes) => {
          if (!this.#dashboard) throw new HermesUnavailableError()
          return this.#dashboard.speak(scope.agentId, text, maxResponseBytes)
        },
      },
    })
    this.#attachments = new HermesAttachmentRegistry(
      {
        resume: (scope) => this.#resumeNative(scope),
        close: (liveSessionId) => this.#closeNativeSession(liveSessionId),
      },
      // The registry requires observation, so a transport that cannot observe
      // is adapted here rather than silently skipped there: such a transport
      // serves only the read-only surfaces, and no run can attach through it.
      {
        onEvent: (listener) =>
          transport.onEvent?.(listener) ?? (() => undefined),
        onConnection: (handler) =>
          transport.onConnection?.(handler) ?? (() => undefined),
      },
      { idleMs: options.sessionIdleMs, log: options.log }
    )
    const ensureAttached = async (scope: HermesRunScope) => ({
      liveSessionId: (await this.#attachments.ensure(scope)).liveSessionId,
      running: this.#attachedRunning(scope.agentId, scope.sessionId),
    })
    this.interactions = new HermesInteractions(
      {
        // A transport that cannot carry server→client requests answers none:
        // read-only surfaces still work, no interaction is ever presented.
        onRequest: (handler) =>
          transport.onRequest?.(handler) ?? (() => undefined),
        onEvent: (listener) =>
          transport.onEvent?.(listener) ?? (() => undefined),
        // Only the gateway knows its socket; a transport that cannot say is
        // taken at its word when a write does not throw.
        connected: () => transport.connected?.() ?? true,
      },
      {
        ensure: ensureAttached,
        retain: (scope, reason) => this.#attachments.retain(scope, reason),
        scopeFor: (liveSessionId) => this.#attachments.scopeFor(liveSessionId),
      },
      ...(options.log ? [{ log: options.log }] : [])
    )
    this.native = new HermesNativeRuntime({
      transport,
      attachments: {
        ensure: ensureAttached,
        retain: (scope, reason) => this.#attachments.retain(scope, reason),
        subscribeLive: (liveSessionId, observer) =>
          this.#attachments.subscribeLive(liveSessionId, observer),
        invalidate: (liveSessionId) =>
          this.#attachments.invalidate(liveSessionId),
      },
      interactions: this.interactions,
      history: (scope) => this.#rawHistory(scope),
      ...(options.log ? { log: options.log } : {}),
    })
    this.runs = new HermesRunEngine(this.native, {
      ...(options.log ? { log: options.log } : {}),
    })
  }

  resolveSessionId(agentId: string, publicSessionId: string) {
    return storedSessionIdentity(agentId, publicSessionId)
  }

  async resolveInvitedSession(
    agentId: string,
    ref: string,
    create?: { readonly firstTurnInstruction?: string }
  ): Promise<{ sessionId: string; created: boolean } | undefined> {
    if (
      Buffer.byteLength(agentId, "utf8") > 256 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(agentId) ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(ref)
    )
      throw new HermesSessionNotFoundError()
    const title = `aos-invite:${ref}`
    if (!create) {
      const sessionId = await this.#findInvitedSession(agentId, title)
      return sessionId ? { sessionId, created: false } : undefined
    }

    const key = `${agentId}\u0000${ref}`
    const existing = this.#invitedSessionCreates.get(key)
    if (existing) return existing
    const pending = this.#reuseOrCreateInvitedSession(agentId, title, create)
    this.#invitedSessionCreates.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.#invitedSessionCreates.get(key) === pending)
        this.#invitedSessionCreates.delete(key)
    }
  }

  async #findInvitedSession(agentId: string, title: string) {
    let payload: unknown
    try {
      payload = await this.transport.request("session.list", {
        profile: agentId,
        title,
        include_hidden: true,
      })
    } catch (error) {
      throwUnavailable(error)
    }
    if (!isRecord(payload) || !Array.isArray(payload.sessions))
      throw new HermesUnavailableError()
    if (payload.sessions.length > 1) throw new HermesSessionConflictError()
    const row = payload.sessions[0]
    if (row === undefined) return undefined
    if (
      !isRecord(row) ||
      (row.profile !== undefined && row.profile !== agentId) ||
      row.title !== title ||
      !validLiveSessionId(row.id) ||
      (row.resolved_id !== undefined &&
        row.resolved_id !== "" &&
        !validLiveSessionId(row.resolved_id))
    )
      throw new HermesUnavailableError()
    return validLiveSessionId(row.resolved_id) ? row.resolved_id : row.id
  }

  async #reuseOrCreateInvitedSession(
    agentId: string,
    title: string,
    create: { readonly firstTurnInstruction?: string }
  ) {
    const existing = await this.#findInvitedSession(agentId, title)
    if (existing) return { sessionId: existing, created: false }

    let payload: unknown
    try {
      payload = await this.transport.request("session.create", {
        profile: agentId,
        title,
        close_on_disconnect: false,
        ...(create.firstTurnInstruction === undefined
          ? {}
          : {
              messages: [
                {
                  role: "user",
                  content: JSON.stringify({
                    v: 1,
                    type: "aos.guest.first-turn",
                    instruction: create.firstTurnInstruction,
                  }),
                },
              ],
            }),
      })
    } catch (error) {
      throwUnavailable(error)
    }
    if (
      !isRecord(payload) ||
      !validLiveSessionId(payload.session_id) ||
      !validLiveSessionId(payload.stored_session_id)
    )
      throw new HermesUnavailableError()
    try {
      await this.transport.request("session.title", {
        session_id: payload.session_id,
        title,
      })
    } catch (error) {
      throwUnavailable(error)
    }
    const authoritative = await this.#findInvitedSession(agentId, title)
    if (!authoritative || authoritative !== payload.stored_session_id)
      throw new HermesSessionConflictError()
    return { sessionId: authoritative, created: true }
  }

  publicError(cause: unknown) {
    if (cause instanceof HermesAuthenticationError)
      return { code: "runtime_authentication_required", status: 401 } as const
    if (
      cause instanceof HermesAgentNotFoundError ||
      cause instanceof HermesSessionNotFoundError ||
      cause instanceof HermesWorkspaceScopeError ||
      cause instanceof HermesContentScopeError
    )
      return { code: "not_found", status: 404 } as const
    if (
      cause instanceof HermesRevisionConflictError ||
      cause instanceof HermesSessionConflictError
    )
      return { code: "revision_conflict", status: 409 } as const
    // An unconfirmed Stop is not an outage: Hermes may have accepted it, so the
    // browser must reconcile instead of treating the Session as unavailable.
    if (
      cause instanceof HermesRunPublicError &&
      cause.code === "AOS_STOP_UNCERTAIN"
    )
      return { code: "uncertain_mutation", status: 409 } as const
    if (
      cause instanceof HermesWorkspaceUnavailableError ||
      cause instanceof HermesContentUnavailableError ||
      cause instanceof HermesRunPublicError ||
      cause instanceof HermesUnavailableError ||
      (cause instanceof HermesInteractionPublicError &&
        cause.code === "AOS_PROVIDER_UNAVAILABLE")
    )
      return { code: "temporarily_unavailable", status: 503 } as const
    if (cause instanceof HermesInteractionPublicError)
      return cause.code === "AOS_INTERACTION_NOT_FOUND"
        ? ({ code: "not_found", status: 404 } as const)
        : ({ code: "invalid_request", status: 400 } as const)
    return undefined
  }

  async #requireAttachedSession(agentId: string, publicSessionId: string) {
    const storedId = storedSessionIdentity(agentId, publicSessionId)
    if (!storedId) throw new HermesSessionNotFoundError()
    await this.getSession(agentId, storedId)
    const attached = await this.#attachments.ensure({
      agentId,
      sessionId: storedId,
      threadId: publicSessionId,
    })
    const resumed = this.#attachmentInfo.get(
      attachmentInfoKey(agentId, storedId)
    )
    const info = resumed && isRecord(resumed.info) ? resumed.info : undefined
    return {
      agentId,
      sessionId: publicSessionId,
      liveSessionId: attached.liveSessionId,
      attached: true,
      active: this.#attachedRunning(agentId, storedId),
      usage: info?.usage,
      info: info ?? resumed,
    }
  }

  /**
   * Last known native turn state of a bound Session, from the authoritative
   * `session.resume` payload the registry recorded.
   */
  #attachedRunning(agentId: string, sessionId: string) {
    const resumed = this.#attachmentInfo.get(
      attachmentInfoKey(agentId, sessionId)
    )
    return (
      resumed?.running === true ||
      resumed?.status === "working" ||
      resumed?.status === "waiting" ||
      resumed?.status === "starting"
    )
  }

  async #rawHistory(
    scope: Pick<HermesWorkspaceSession, "agentId" | "sessionId"> & {
      info?: unknown
    }
  ) {
    if (!this.#dashboard) throw new HermesUnavailableError()
    const storedId = storedSessionIdentity(scope.agentId, scope.sessionId)
    if (!storedId) throw new HermesSessionNotFoundError()
    let value: unknown
    try {
      value = await this.#dashboard.getSessionMessages(
        scope.agentId,
        storedId,
        500,
        0
      )
    } catch (error) {
      if (
        error instanceof HermesHttpError &&
        error.status === 404 &&
        isRecord(scope.info) &&
        scope.info.lazy === true
      )
        return []
      throw error
    }
    if (
      !isRecord(value) ||
      value.session_id !== storedId ||
      !Array.isArray(value.messages)
    )
      throw new HermesUnavailableError()
    return value.messages
  }

  async workspaceCapabilities(agentId: string, publicSessionId: string) {
    let slashCommands
    try {
      slashCommands = {
        status: "available" as const,
        scope: "attached-session" as const,
        commands: await this.slashCommands(agentId, publicSessionId),
      }
    } catch {
      slashCommands = {
        status: "unavailable" as const,
        reason: "command-catalog-unavailable",
      }
    }
    return {
      agent: {
        identity: { type: "hermes", provider: "NousResearch" },
        transport: { streaming: true, resumable: true },
        tools: { supported: true, clientProvided: false },
        reasoning: { supported: true, streaming: true, encrypted: false },
        multimodal: {
          input: {
            image: true,
            audio: false,
            video: false,
            pdf: true,
            file: true,
          },
          output: { image: false, audio: false },
        },
        humanInTheLoop: {
          supported: true,
          approvals: true,
          interventions: true,
          feedback: false,
          interrupts: true,
          approveWithEdits: false,
        },
        custom: { "aos.planActivityType": "PLAN" },
      },
      workspace: { ...this.#workspace.capabilities(), slashCommands },
      interactions: {
        ...this.interactions.capabilities(),
        steering: {
          status: "available" as const,
          scope: "active-run" as const,
          semantics: "visible-user-message" as const,
          input: "text" as const,
          fallback: "provider-queue" as const,
        },
      },
      content: this.#content.capabilities(),
    }
  }

  models(agentId: string, sessionId: string) {
    return this.#workspace.models(agentId, sessionId)
  }

  selectModel(agentId: string, sessionId: string, selectedId: string) {
    return this.#workspace.selectModel(agentId, sessionId, selectedId)
  }

  context(agentId: string, sessionId: string) {
    return this.#workspace.context(agentId, sessionId)
  }

  todos(agentId: string, sessionId: string) {
    return this.#workspace.todos(agentId, sessionId)
  }

  activity(agentId: string, sessionId: string) {
    return this.#workspace.activity(agentId, sessionId)
  }

  async pendingInteractions(
    agentId: string,
    publicSessionId: string,
    requestedRunId?: string
  ) {
    const storedId = storedSessionIdentity(agentId, publicSessionId)
    if (!storedId) throw new HermesSessionNotFoundError()
    await this.getSession(agentId, storedId)
    const runId = requestedRunId ?? "aos-hermes-restored-interaction"
    return {
      runId,
      ...(await this.interactions.resume({
        agentId,
        sessionId: storedId,
        threadId: publicSessionId,
      })),
    }
  }

  stageAttachments(
    agentId: string,
    sessionId: string,
    attachments: readonly HermesContentAttachment[]
  ) {
    return this.#content.stage(agentId, sessionId, attachments)
  }

  artifact(agentId: string, sessionId: string, artifactId: string) {
    return this.#content.artifact(agentId, sessionId, artifactId)
  }

  transcribe(
    agentId: string,
    bytes: Uint8Array,
    mimeType: string,
    signal?: AbortSignal
  ) {
    return this.#content.transcribe(agentId, bytes, mimeType, signal)
  }

  speak(agentId: string, text: string, signal?: AbortSignal) {
    return this.#content.speak(agentId, text, signal)
  }

  async authState(): Promise<RuntimeAuthState> {
    try {
      await this.transport.request("profiles.list", { include_sessions: false })
      return { status: "authenticated" }
    } catch (error) {
      if (error instanceof HermesAuthenticationError)
        return { status: "authentication-required" }
      return { status: "unavailable", reason: "temporarily-unavailable" }
    }
  }

  async listAgents(): Promise<AgentCatalogResponse> {
    let payload: unknown
    try {
      payload = await this.transport.request("profiles.list", {
        include_sessions: false,
      })
      const agents = nativeProfiles(payload).map(projectProfile)
      if (
        new Set(agents.map(({ summary }) => summary.id)).size !== agents.length
      )
        throw new HermesUnavailableError()
      return AgentCatalogResponseSchema.parse({
        revision: catalogRevision(agents),
        agents,
      })
    } catch (error) {
      if (error instanceof HermesAuthenticationError) throw error
      if (error instanceof HermesUnavailableError) throw error
      throw new HermesUnavailableError()
    }
  }

  async runtimeInfo(): Promise<RuntimeInfo> {
    let visibilityAvailable = false
    try {
      const catalog = await this.listAgents()
      visibilityAvailable = catalog.agents.every(
        ({ summary, revision }) =>
          summary.role === "creator" || revision !== "unavailable"
      )
    } catch (error) {
      if (error instanceof HermesAuthenticationError) throw error
      return RuntimeInfoSchema.parse({
        runtime: { id: "hermes", name: "Hermes" },
        status: "unavailable",
        capabilities: {
          agentCatalog: {
            status: "unavailable",
            reason: "temporarily-unavailable",
          },
          agentVisibility: {
            status: "unavailable",
            reason: "temporarily-unavailable",
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
          sessionDeletion: {
            status: "unavailable",
            reason: "temporarily-unavailable",
          },
          sessionRun: {
            status: "unavailable",
            reason: "temporarily-unavailable",
          },
          sessionStop: {
            status: "unavailable",
            reason: "temporarily-unavailable",
          },
          sessionSteer: {
            status: "unavailable",
            reason: "temporarily-unavailable",
          },
        },
      })
    }
    return RuntimeInfoSchema.parse({
      runtime: { id: "hermes", name: "Hermes" },
      status: "ready",
      capabilities: {
        agentCatalog: { status: "available" },
        agentVisibility: visibilityAvailable
          ? { status: "available", concurrency: "revision" }
          : { status: "unavailable", reason: "native-revision-unavailable" },
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
        sessionDetail: { status: "available" },
        sessionCreation: { status: "available" },
        sessionTitle: { status: "available" },
        sessionArchival: { status: "available" },
        sessionDeletion: { status: "available" },
        sessionRun: { status: "available" },
        sessionStop: { status: "available" },
        sessionSteer: { status: "available" },
      },
    })
  }

  async updateAgentVisibility(
    agentId: string,
    visibility: "visible" | "hidden",
    observedRevision: string
  ): Promise<VisibilityUpdateResponse> {
    const before = await this.listAgents()
    const current = before.agents.find(({ summary }) => summary.id === agentId)
    if (!current) throw new HermesAgentNotFoundError()
    if (!current.editable || current.revision === "unavailable")
      throw new HermesUnavailableError()
    if (current.revision !== observedRevision)
      throw new HermesRevisionConflictError()
    const expected = Number(current.revision.slice("hermes-bots:".length))

    let described: unknown
    try {
      described = await this.transport.request("profiles.describe", {
        name: agentId,
      })
    } catch (error) {
      throwUnavailable(error)
    }
    if (!isRecord(described) || trimmedText(described.name) !== agentId)
      throw new HermesUnavailableError()
    if (nativeRevision(described) !== expected)
      throw new HermesRevisionConflictError()

    let configured: unknown
    try {
      configured = await this.transport.request("profiles.configure", {
        name: agentId,
        ui_meta: {
          "hermes-bots": {
            ...nativeBots(described),
            hidden: visibility === "hidden",
          },
        },
        ui_meta_expected_revisions: { "hermes-bots": expected },
      })
    } catch (error) {
      throwUnavailable(error)
    }
    const applied =
      isRecord(configured) && isRecord(configured.applied)
        ? configured.applied
        : undefined
    if (applied?.ui_meta !== true) {
      if (applied && isRecord(applied.ui_meta_conflicts))
        throw new HermesRevisionConflictError()
      throw new HermesUnavailableError()
    }

    const confirmed = await this.listAgents()
    const agent = confirmed.agents.find(({ summary }) => summary.id === agentId)
    if (!agent || agent.visibility !== visibility)
      throw new HermesUnavailableError()
    return VisibilityUpdateResponseSchema.parse({
      revision: confirmed.revision,
      agent,
    })
  }

  async close() {
    this.interactions.close()
    await this.#attachments.close()
    await this.transport.close?.()
  }

  async #resumeNative(scope: HermesRunScope) {
    let payload: unknown
    try {
      payload = await this.transport.request("session.resume", {
        session_id: scope.sessionId,
        profile: scope.agentId,
        omit_messages: true,
      })
    } catch (error) {
      // A heal must learn that Hermes reaped this live Session so the registry
      // can invalidate the binding and resume the durable Session again; every
      // other transport failure stays an outage.
      if (isSessionGone(error)) throw new HermesSessionGoneError()
      throwUnavailable(error)
    }
    const liveSessionId =
      isRecord(payload) && validLiveSessionId(payload.session_id)
        ? payload.session_id
        : undefined
    if (!liveSessionId || !isRecord(payload)) throw new HermesUnavailableError()
    this.#attachmentInfo.set(
      attachmentInfoKey(scope.agentId, scope.sessionId),
      payload
    )
    return { liveSessionId }
  }

  async #closeNativeSession(liveSessionId: string) {
    try {
      await this.transport.request("session.close", {
        session_id: liveSessionId,
      })
    } catch {
      // Idle retention is best-effort; it must never close the shared socket.
    }
  }

  async subscribeSessionInvalidation(
    agentId: string,
    publicSessionId: string,
    listener: () => void,
    reset?: () => void
  ) {
    const sessionId = storedSessionIdentity(agentId, publicSessionId)
    if (!sessionId) throw new HermesSessionNotFoundError()
    return this.#attachments.subscribe(
      { agentId, sessionId, threadId: publicSessionId },
      (signal) => {
        if (signal.kind === "event") listener()
        else if (signal.kind === "lost") reset?.()
      }
    )
  }

  async slashCommands(agentId: string, publicSessionId: string) {
    const scope = await this.#requireAttachedSession(agentId, publicSessionId)
    try {
      return await nativeSlashCommands(this.transport, {
        session_id: scope.liveSessionId,
        profile: agentId,
      })
    } catch (error) {
      throwUnavailable(error)
    }
  }

  async listSessions(profile: string, limit: number, offset: number) {
    if (!this.#dashboard) throw new HermesUnavailableError()
    let payload: unknown
    try {
      payload = await this.#dashboard.listSessions(profile, limit, offset)
    } catch (error) {
      throwUnavailable(error)
    }
    if (!isRecord(payload) || !Array.isArray(payload.sessions))
      throw new HermesUnavailableError()
    const seen = new Set<string>()
    const sessions = payload.sessions.map((row) => {
      if (!isRecord(row)) throw new HermesUnavailableError()
      const storedId = trimmedText(row.id)
      if (
        !storedId ||
        trimmedText(row.profile) !== profile ||
        seen.has(storedId) ||
        (row.is_active !== undefined && typeof row.is_active !== "boolean")
      )
        throw new HermesUnavailableError()
      seen.add(storedId)
      return {
        id: sessionId(profile, storedId),
        agentId: profile,
        title: trimmedText(row.title) ?? storedId,
        archived: row.archived === true,
        updatedAt: timestamp(row.last_active ?? row.started_at),
        status:
          row.is_active === true ? ("running" as const) : ("idle" as const),
      }
    })
    const result = SessionCatalogResponseSchema.safeParse({
      sessions,
      total:
        typeof payload.total === "number" && payload.total >= 0
          ? payload.total
          : sessions.length,
      limit,
      offset,
    })
    if (!result.success) throw new HermesUnavailableError()
    return result.data
  }

  async listAllSessions(limit: number, offset: number) {
    if (offset + limit > SESSION_CATALOG_MAX_WINDOW)
      throw new HermesUnavailableError()
    const profiles = (await this.listAgents()).agents
      .filter(({ summary }) => summary.role !== "creator")
      .map(({ summary }) => summary.id)
    const prefixLength = offset + limit
    if (!Number.isSafeInteger(prefixLength)) throw new HermesUnavailableError()
    const profilePages: Array<{
      sessions: Awaited<
        ReturnType<HermesServerAdapter["listSessions"]>
      >["sessions"]
      total: number
    }> = []
    const fanout = 4
    for (let start = 0; start < profiles.length; start += fanout) {
      profilePages.push(
        ...(await Promise.all(
          profiles.slice(start, start + fanout).map(async (profile) => {
            const sessions: Awaited<
              ReturnType<HermesServerAdapter["listSessions"]>
            >["sessions"] = []
            let profileOffset = 0
            let total = 0
            while (sessions.length < prefixLength) {
              const page = await this.listSessions(
                profile,
                Math.min(100, prefixLength - sessions.length),
                profileOffset
              )
              sessions.push(...page.sessions)
              total = page.total
              profileOffset += page.sessions.length
              if (page.sessions.length === 0 || profileOffset >= total) break
            }
            return { sessions, total }
          })
        ))
      )
    }
    const merged = profilePages
      .flatMap(({ sessions }) => sessions)
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
          left.id.localeCompare(right.id)
      )
    const result = SessionCatalogResponseSchema.safeParse({
      sessions: merged.slice(offset, prefixLength),
      total: profilePages.reduce((sum, page) => sum + page.total, 0),
      limit,
      offset,
    })
    if (!result.success) throw new HermesUnavailableError()
    return result.data
  }

  async history(
    profile: string,
    storedId: string,
    limit: number,
    offset: number
  ) {
    if (!this.#dashboard) throw new HermesUnavailableError()
    await this.getSession(profile, storedId)
    let payload: unknown
    try {
      payload = await this.#dashboard.getSessionMessages(
        profile,
        storedId,
        limit,
        offset
      )
    } catch (error) {
      if (error instanceof HermesHttpError && error.status === 404) {
        await this.#unpersistedDraft(profile, storedId)
        return SessionHistoryResponseSchema.parse({
          sessionId: sessionId(profile, storedId),
          messages: [],
          total: 0,
          limit,
          offset,
          nextOffset: offset,
        })
      }
      throwUnavailable(error)
    }
    if (
      !isRecord(payload) ||
      trimmedText(payload.session_id) !== storedId ||
      !Array.isArray(payload.messages)
    )
      throw new HermesUnavailableError()
    const pagination = historyPagination(
      limit,
      offset,
      payload.messages.length,
      payload.pagination
    )
    const messages: Array<
      | SessionMessage
      | {
          id: string
          role: "activity"
          activityType: "PLAN"
          content: { todos: NonNullable<ReturnType<typeof latestHermesTodos>> }
        }
    > = projectHermesHistory(payload.messages)
    const todos = latestHermesTodos(payload.messages)
    if (todos !== undefined)
      messages.push({
        id: `aos-plan:${sessionId(profile, storedId)}`,
        role: "activity",
        activityType: "PLAN",
        content: { todos },
      })
    const result = SessionHistoryResponseSchema.safeParse({
      sessionId: sessionId(profile, storedId),
      messages,
      total: pagination.total,
      limit,
      offset,
      nextOffset: pagination.nextOffset,
    })
    if (!result.success) throw new HermesUnavailableError()
    return result.data
  }

  async getSession(profile: string, storedId: string) {
    if (!this.#dashboard) throw new HermesUnavailableError()
    let payload: unknown
    try {
      payload = await this.#dashboard.getSession(profile, storedId)
    } catch (error) {
      if (error instanceof HermesHttpError && error.status === 404)
        return this.#unpersistedDraft(profile, storedId)
      throwUnavailable(error)
    }
    if (
      !isRecord(payload) ||
      trimmedText(payload.id) !== storedId ||
      (payload.is_active !== undefined &&
        typeof payload.is_active !== "boolean")
    )
      throw new HermesUnavailableError()
    if (trimmedText(payload.profile) !== profile)
      throw new HermesSessionNotFoundError()
    const result = SessionSchema.safeParse({
      id: sessionId(profile, storedId),
      agentId: profile,
      title: trimmedText(payload.title) ?? storedId,
      archived: payload.archived === true,
      updatedAt: timestamp(payload.last_active ?? payload.started_at),
      status:
        payload.is_active === true ? ("running" as const) : ("idle" as const),
    })
    if (!result.success) throw new HermesUnavailableError()
    return result.data
  }

  async #unpersistedDraft(profile: string, storedId: string) {
    let payload: unknown
    try {
      payload = await this.transport.request("session.resume", {
        session_id: storedId,
        profile,
        omit_messages: true,
      })
    } catch (error) {
      throwUnavailable(error)
    }
    const info =
      isRecord(payload) && isRecord(payload.info) ? payload.info : undefined
    if (
      !isRecord(payload) ||
      !validLiveSessionId(payload.session_id) ||
      payload.stored_session_id !== storedId ||
      (payload.message_count !== 0 && payload.message_count !== 1) ||
      !Array.isArray(payload.messages) ||
      payload.messages.length !== 0 ||
      info?.lazy !== true ||
      info.profile_name !== profile
    )
      throw new HermesSessionNotFoundError()
    const result = SessionSchema.safeParse({
      id: sessionId(profile, storedId),
      agentId: profile,
      title: storedId,
      archived: false,
      updatedAt: timestamp(undefined),
      status: "idle" as const,
    })
    if (!result.success) throw new HermesUnavailableError()
    return result.data
  }

  async createSession(profile: string, title?: string) {
    const catalog = await this.listAgents()
    if (!catalog.agents.some(({ summary }) => summary.id === profile))
      throw new HermesAgentNotFoundError()
    let payload: unknown
    try {
      payload = await this.transport.request("session.create", {
        profile,
        close_on_disconnect: false,
        ...(title ? { title } : {}),
      })
    } catch (error) {
      throwUnavailable(error)
    }
    if (!isRecord(payload)) throw new HermesUnavailableError()
    const storedId = trimmedText(payload.stored_session_id)
    const liveId = trimmedText(payload.session_id)
    if (!storedId || !liveId) throw new HermesUnavailableError()
    return SessionCreateResponseSchema.parse({
      session: {
        id: sessionId(profile, storedId),
        agentId: profile,
      },
    })
  }

  async mutateSession(
    profile: string,
    storedId: string,
    method: "PATCH" | "DELETE",
    body?: unknown
  ) {
    await this.getSession(profile, storedId)
    if (!this.#dashboard) throw new HermesUnavailableError()
    try {
      await (method === "PATCH"
        ? this.#dashboard.updateSession(profile, storedId, body)
        : this.#dashboard.deleteSession(profile, storedId))
    } catch (error) {
      if (error instanceof HermesHttpError && error.status === 404)
        throw new HermesSessionNotFoundError()
      if (error instanceof HermesHttpError && error.status === 409)
        throw new HermesSessionConflictError()
      throw new HermesUnavailableError()
    }
  }
}
