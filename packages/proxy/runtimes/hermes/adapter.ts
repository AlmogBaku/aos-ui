import {
  AgentCatalogResponseSchema,
  RuntimeAuthStateSchema,
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
  type VisibilityUpdateResponse,
} from "../../../protocol"
import { HermesAuthenticationError, HermesHttpError } from "./transport"
import { projectHermesHistory } from "./history"
import {
  HermesRunEngine,
  HermesRunPublicError,
  type HermesRunNative,
  type HermesRunScope,
} from "./run"
import {
  createHermesWorkspaceOperations,
  HermesWorkspaceScopeError,
  HermesWorkspaceUnavailableError,
  type HermesWorkspaceOperations,
  type HermesWorkspaceSession,
} from "./workspace"
import {
  createHermesContentOperations,
  HermesContentScopeError,
  HermesContentUnavailableError,
  type HermesContentAttachment,
} from "./content"
import {
  HermesInteractionPublicError,
  HermesInteractions,
} from "./interactions"
import { HermesBrowserAuthenticationError } from "./auth-broker"
import { HermesDashboardClient } from "./dashboard-client"
import type { ServerRuntime } from "../../runtime"
import type { ResumeEntry } from "@ag-ui/core"

export interface HermesRpcTransport {
  request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    maxResponseBytes?: number
  ): Promise<unknown>
  http?(
    path: string,
    init?: { method?: string; body?: unknown; maxResponseBytes?: number }
  ): Promise<unknown>
  authState?(): Promise<RuntimeAuthState>
  observeEvents?(
    listener: (event: unknown) => void,
    disconnected: (error?: Error) => void
  ): Promise<() => void>
  close?(): Promise<void>
}

export class HermesRevisionConflictError extends Error {
  constructor() {
    super("Agent visibility revision conflict")
    this.name = "HermesRevisionConflictError"
  }
}

export class HermesUnavailableError extends Error {
  constructor() {
    super("Hermes is temporarily unavailable")
    this.name = "HermesUnavailableError"
  }
}

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

function isRecord(value: unknown): value is NativeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

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

const MAX_OBSERVED_EVENT_BYTES = 4_194_304
const MAX_OBSERVED_EVENT_DEPTH = 12
const MAX_OBSERVED_EVENT_NODES = 4_096

function observedEventDisposition(
  value: unknown,
  liveSessionId: string
): "foreign" | "invalid" | "valid" {
  if (!isRecord(value) || value.session_id !== liveSessionId) return "foreign"
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new WeakSet<object>()
  let bytes = 0
  let nodes = 0
  while (stack.length > 0) {
    const current = stack.pop()!
    nodes += 1
    if (
      nodes > MAX_OBSERVED_EVENT_NODES ||
      current.depth > MAX_OBSERVED_EVENT_DEPTH
    )
      return "invalid"
    if (typeof current.value === "string")
      bytes += Buffer.byteLength(current.value, "utf8")
    else if (
      typeof current.value === "number" ||
      typeof current.value === "boolean" ||
      current.value === null
    )
      bytes += 16
    else if (typeof current.value === "object") {
      if (seen.has(current.value)) return "invalid"
      seen.add(current.value)
      const entries = Array.isArray(current.value)
        ? current.value.map((entry) => ["", entry] as const)
        : Object.entries(current.value)
      for (const [key, entry] of entries) {
        bytes += Buffer.byteLength(key, "utf8")
        stack.push({ value: entry, depth: current.depth + 1 })
      }
    } else return "invalid"
    if (bytes > MAX_OBSERVED_EVENT_BYTES) return "invalid"
  }
  return "valid"
}

function validLiveSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )
}

function throwUnavailable(error: unknown): never {
  if (error instanceof HermesAuthenticationError) throw error
  throw new HermesUnavailableError()
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
  const id = nonEmptyString(profile.name)
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
      name: nonEmptyString(profile.display_name) ?? id,
      ...(nonEmptyString(profile.description)
        ? { description: nonEmptyString(profile.description) }
        : {}),
      activity: "unknown",
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

function sessionId(profile: string, storedId: string) {
  return `hermes:${encodeURIComponent(profile)}:${encodeURIComponent(storedId)}`
}

function storedSessionIdentity(profile: string, publicId: string) {
  const match = /^hermes:([^:]+):(.+)$/u.exec(publicId)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1]) === profile
      ? decodeURIComponent(match[2])
      : undefined
  } catch {
    return undefined
  }
}

function parsedJson(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function publishedArtifact(rows: readonly unknown[], artifactId: string) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (!isRecord(row)) continue
    const value = parsedJson(row.content ?? row.result)
    if (!isRecord(value) || value.ok !== true || value.type !== "aos.artifact")
      continue
    const artifact = isRecord(value.artifact) ? value.artifact : undefined
    const id = nonEmptyString(artifact?.id)
    const reference = nonEmptyString(artifact?.path)
    const filename = nonEmptyString(artifact?.filename)
    if (
      id !== artifactId ||
      !reference ||
      !filename ||
      reference.startsWith("/") ||
      /^[A-Za-z]:[\\/]/u.test(reference) ||
      reference.split(/[\\/]/u).includes("..")
    )
      continue
    return { reference, filename }
  }
  return undefined
}

function dataUrlBytes(value: unknown) {
  if (!isRecord(value) || typeof value.dataUrl !== "string") return undefined
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(
    value.dataUrl
  )
  if (!match || match[2].length % 4 !== 0) return undefined
  try {
    const bytes = Uint8Array.from(atob(match[2]), (character) =>
      character.charCodeAt(0)
    )
    return { bytes, mimeType: match[1] }
  } catch {
    return undefined
  }
}

function timestamp(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value)
  return Number.isFinite(numeric) && numeric > 0
    ? new Date(
        numeric < 10_000_000_000 ? numeric * 1000 : numeric
      ).toISOString()
    : new Date(0).toISOString()
}

export class HermesServerAdapter implements HermesRunNative, ServerRuntime {
  readonly #dashboard?: HermesDashboardClient
  readonly #workspace: HermesWorkspaceOperations
  readonly #content: ReturnType<typeof createHermesContentOperations>
  readonly interactions: HermesInteractions
  readonly runs: HermesRunEngine

  constructor(private readonly transport: HermesRpcTransport) {
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
          this.transport.request(method, params, maxResponseBytes),
        readArtifact: async (scope, reference, _maxBytes, maxResponseBytes) => {
          if (!this.#dashboard) throw new HermesUnavailableError()
          const storedId = storedSessionIdentity(scope.agentId, scope.sessionId)
          if (!storedId) throw new HermesUnavailableError()
          return dataUrlBytes(
            await this.#dashboard.readArtifactDataUrl(
              scope.agentId,
              storedId,
              reference,
              maxResponseBytes
            )
          ) as { bytes: Uint8Array; mimeType?: string }
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
    this.interactions = new HermesInteractions({
      request: (method, params) => this.transport.request(method, params),
    })
    this.runs = new HermesRunEngine(this)
  }

  resolveSessionId(agentId: string, publicSessionId: string) {
    return storedSessionIdentity(agentId, publicSessionId)
  }

  publicError(cause: unknown) {
    if (cause instanceof HermesBrowserAuthenticationError)
      return cause.code === "provider-temporarily-unavailable"
        ? ({ code: "temporarily_unavailable", status: 503 } as const)
        : cause.code === "invalid-request"
          ? ({ code: "invalid_request", status: 400 } as const)
          : ({ code: "runtime_authentication_required", status: 401 } as const)
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
    if (
      cause instanceof HermesWorkspaceUnavailableError ||
      cause instanceof HermesContentUnavailableError ||
      cause instanceof HermesRunPublicError ||
      cause instanceof HermesUnavailableError ||
      (cause instanceof HermesInteractionPublicError &&
        (cause.code === "AOS_PROVIDER_UNAVAILABLE" ||
          cause.code === "AOS_RECONCILIATION_STALE"))
    )
      return { code: "temporarily_unavailable", status: 503 } as const
    if (cause instanceof HermesInteractionPublicError)
      return cause.code === "AOS_INTERACTION_NOT_FOUND"
        ? ({ code: "not_found", status: 404 } as const)
        : ({ code: "invalid_request", status: 400 } as const)
    return undefined
  }

  respondInteraction(
    scope: HermesRunScope & { runId: string },
    response: ResumeEntry
  ) {
    return this.interactions.respond(scope, response)
  }

  async #requireAttachedSession(agentId: string, publicSessionId: string) {
    const storedId = storedSessionIdentity(agentId, publicSessionId)
    if (!storedId) throw new HermesSessionNotFoundError()
    await this.getSession(agentId, storedId)
    let resumed: unknown
    try {
      resumed = await this.transport.request("session.resume", {
        session_id: storedId,
        profile: agentId,
        omit_messages: true,
      })
    } catch (error) {
      throwUnavailable(error)
    }
    if (!isRecord(resumed)) throw new HermesUnavailableError()
    const liveSessionId = validLiveSessionId(resumed.session_id)
      ? resumed.session_id
      : undefined
    if (!liveSessionId) throw new HermesUnavailableError()
    const info = isRecord(resumed.info) ? resumed.info : undefined
    return {
      agentId,
      sessionId: publicSessionId,
      liveSessionId,
      attached: true,
      active:
        resumed.running === true ||
        resumed.status === "working" ||
        resumed.status === "waiting" ||
        resumed.status === "starting",
      usage: info?.usage,
      info: info ?? resumed,
    }
  }

  async #rawHistory(
    scope: Pick<HermesWorkspaceSession, "agentId" | "sessionId">
  ) {
    if (!this.#dashboard) throw new HermesUnavailableError()
    const storedId = storedSessionIdentity(scope.agentId, scope.sessionId)
    if (!storedId) throw new HermesSessionNotFoundError()
    const value = await this.#dashboard.getSessionMessages(
      scope.agentId,
      storedId,
      500,
      0
    )
    if (
      !isRecord(value) ||
      value.session_id !== storedId ||
      !Array.isArray(value.messages)
    )
      throw new HermesUnavailableError()
    return value.messages
  }

  workspaceCapabilities() {
    return {
      workspace: this.#workspace.capabilities(),
      interactions: this.interactions.capabilities(),
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
        runId,
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

  audio(agentId: string, sessionId: string) {
    return this.#content.audio(agentId, sessionId)
  }

  transcribe(
    agentId: string,
    sessionId: string,
    bytes: Uint8Array,
    mimeType: string,
    signal?: AbortSignal
  ) {
    return this.#content.transcribe(agentId, sessionId, bytes, mimeType, signal)
  }

  speak(
    agentId: string,
    sessionId: string,
    text: string,
    signal?: AbortSignal
  ) {
    return this.#content.speak(agentId, sessionId, text, signal)
  }

  async authState(): Promise<RuntimeAuthState> {
    if (this.transport.authState)
      return RuntimeAuthStateSchema.parse(await this.transport.authState())
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
    if (!isRecord(described) || nonEmptyString(described.name) !== agentId)
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
    await this.transport.close?.()
  }

  acceptInteraction(
    scope: HermesRunScope & { runId: string },
    liveSessionId: string,
    event: unknown
  ) {
    return this.interactions.acceptNative(scope, liveSessionId, event)
  }

  async respondInteractions(
    scope: HermesRunScope & { runId: string },
    resume: readonly ResumeEntry[]
  ) {
    await this.interactions.resume(scope)
    return Promise.all(
      resume.map((entry) => this.interactions.respond(scope, entry))
    )
  }

  async resume(scope: HermesRunScope) {
    let payload: unknown
    try {
      payload = await this.transport.request("session.resume", {
        session_id: scope.sessionId,
        profile: scope.agentId,
        omit_messages: true,
      })
    } catch (error) {
      throwUnavailable(error)
    }
    const liveSessionId =
      isRecord(payload) && validLiveSessionId(payload.session_id)
        ? payload.session_id
        : undefined
    if (!liveSessionId) throw new HermesUnavailableError()
    return { liveSessionId }
  }

  async observe(
    liveSessionId: string,
    listener: (event: unknown) => void,
    disconnected?: (error?: Error) => void
  ) {
    if (!this.transport.observeEvents) throw new HermesUnavailableError()
    try {
      let failed = false
      let stopped = false
      const observation: { stop?: () => void } = {}
      const fail = () => {
        if (failed) return
        failed = true
        disconnected?.(new Error("Hermes observation failed"))
        if (observation.stop && !stopped) {
          stopped = true
          observation.stop()
        }
      }
      const nativeStop = await this.transport.observeEvents(
        (event) => {
          if (failed) return
          const disposition = observedEventDisposition(event, liveSessionId)
          if (disposition === "valid") listener(event)
          else if (disposition === "invalid") fail()
        },
        () => fail()
      )
      observation.stop = nativeStop
      if (failed && !stopped) {
        stopped = true
        nativeStop()
      }
      return nativeStop
    } catch (error) {
      throwUnavailable(error)
    }
  }

  async recover(liveSessionId: string, lastSeen?: number) {
    let payload: unknown
    try {
      payload = await this.transport.request("session.events.since", {
        session_id: liveSessionId,
        ...(lastSeen === undefined ? {} : { last_seen: lastSeen }),
      })
    } catch (error) {
      throwUnavailable(error)
    }
    if (!isRecord(payload) || !Array.isArray(payload.events))
      throw new HermesUnavailableError()
    const epoch = nonEmptyString(payload.epoch)
    const nativeLastSeen = payload.last_seen
    if (
      !epoch ||
      typeof nativeLastSeen !== "number" ||
      !Number.isSafeInteger(nativeLastSeen) ||
      nativeLastSeen < 0 ||
      (payload.truncated !== undefined &&
        typeof payload.truncated !== "boolean")
    )
      throw new HermesUnavailableError()
    return {
      epoch,
      lastSeen: nativeLastSeen,
      truncated: payload.truncated === true,
      events: payload.events,
    }
  }

  async submit(liveSessionId: string, prompt: { text: string; runId: string }) {
    try {
      await this.transport.request("prompt.submit", {
        session_id: liveSessionId,
        text: prompt.text,
      })
    } catch (error) {
      throwUnavailable(error)
    }
    return { acknowledgement: "accepted" as const }
  }

  async interrupt(liveSessionId: string) {
    try {
      await this.transport.request("session.interrupt", {
        session_id: liveSessionId,
      })
    } catch (error) {
      throwUnavailable(error)
    }
  }

  async status(liveSessionId: string) {
    let payload: unknown
    try {
      payload = await this.transport.request("session.active_list", {})
    } catch (error) {
      throwUnavailable(error)
    }
    if (!isRecord(payload) || !Array.isArray(payload.sessions))
      throw new HermesUnavailableError()
    const session = payload.sessions.find(
      (value) => isRecord(value) && nonEmptyString(value.id) === liveSessionId
    )
    if (!session) return "idle" as const
    if (!isRecord(session)) throw new HermesUnavailableError()
    if (session.status === "waiting") return "waiting" as const
    if (session.status === "working" || session.status === "starting")
      return "running" as const
    if (session.status === "idle") return "idle" as const
    throw new HermesUnavailableError()
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
      const storedId = nonEmptyString(row.id)
      if (
        !storedId ||
        nonEmptyString(row.profile) !== profile ||
        seen.has(storedId)
      )
        throw new HermesUnavailableError()
      seen.add(storedId)
      return {
        id: sessionId(profile, storedId),
        agentId: profile,
        title: nonEmptyString(row.title) ?? storedId,
        archived: row.archived === true,
        updatedAt: timestamp(row.last_active ?? row.started_at),
        status: "unknown" as const,
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
      if (error instanceof HermesHttpError && error.status === 404)
        throw new HermesSessionNotFoundError()
      throwUnavailable(error)
    }
    if (
      !isRecord(payload) ||
      nonEmptyString(payload.session_id) !== storedId ||
      !Array.isArray(payload.messages)
    )
      throw new HermesUnavailableError()
    const pagination = historyPagination(
      limit,
      offset,
      payload.messages.length,
      payload.pagination
    )
    const result = SessionHistoryResponseSchema.safeParse({
      sessionId: sessionId(profile, storedId),
      messages: projectHermesHistory(payload.messages),
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
        throw new HermesSessionNotFoundError()
      throwUnavailable(error)
    }
    if (
      !isRecord(payload) ||
      nonEmptyString(payload.id) !== storedId ||
      nonEmptyString(payload.profile) !== profile
    )
      throw new HermesUnavailableError()
    const result = SessionSchema.safeParse({
      id: sessionId(profile, storedId),
      agentId: profile,
      title: nonEmptyString(payload.title) ?? storedId,
      archived: payload.archived === true,
      updatedAt: timestamp(payload.last_active ?? payload.started_at),
      status: "unknown" as const,
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
    if (
      !isRecord(payload) ||
      !nonEmptyString(payload.stored_session_id) ||
      !nonEmptyString(payload.session_id)
    )
      throw new HermesUnavailableError()
    return SessionCreateResponseSchema.parse({
      session: {
        id: sessionId(profile, nonEmptyString(payload.stored_session_id)!),
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
