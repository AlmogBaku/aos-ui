import { createHash } from "node:crypto"

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
  type SessionModelUpdateRequest,
  type SessionPlanActivityMessage,
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
import { hermesInflightTurn, restoredHermesFailedTurn } from "./inflight"
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
  HermesContentUnreadableError,
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

/**
 * The statuses Hermes' `GET /api/fs/read-data-url` answers when it has read the
 * request and refuses the file itself: 404 for a path it cannot find (a default
 * `text_to_speech` output lives in the media cache Hermes prunes hourly at a
 * 24-hour age, so its receipt outlives its bytes), 400 for a path it rejects or
 * a directory, 403 for one it will not read — unreadable, sensitive, or outside
 * the managed root (`hermes_cli/web_routers/files.py:165`, `:173`, `:185`,
 * `hermes_cli/web_server_files.py:171`) — and 413 for a file past its own
 * data-URL ceiling. Authentication is never among them: the dashboard answers
 * 401 for a rejected credential. None of these change on a retry.
 */
const UNREADABLE_ARTIFACT_STATUS: ReadonlySet<number> = new Set([
  400, 403, 404, 413,
])

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

/**
 * Hermes has no `display_kind` predicate on its messages route, so a page of
 * durable rows can be entirely display chrome that the projection drops. The
 * adapter keeps reading older pages to fill the requested conversation page, and
 * this bounds that scan: a store that is almost entirely chrome costs a few
 * seconds once (a live page is roughly 100ms) instead of hanging the request,
 * while at the usual limit of 200 the budget still reaches past 6,000 chrome
 * rows. A healthy Session spends none of the budget.
 */
const MAX_EXTRA_HISTORY_PAGE_FETCHES = 32

/**
 * One stored native flag, however the endpoint reporting it spells it: the
 * Session list coerces its SQLite integers to booleans, while the Session
 * detail read returns the raw `0`/`1`. Anything else is unknown, not false.
 */
function nativeFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (value === 1) return true
  if (value === 0) return false
  return undefined
}

function validLiveSessionId(value: unknown): value is string {
  return nativeId(value, 256) !== undefined
}

/**
 * The `hermes-bots` CAS revision of one profile-list row. Hermes always sends
 * `ui_meta_revisions` on a list row — that map is how it feature-detects its
 * own gateway-owned CAS — but a profile that has never been written through it
 * has no `hermes-bots` key, and the gateway then compares against `0`. So an
 * absent key is revision `0`, and only a missing map means the CAS itself is
 * unavailable. `profiles.describe` never carries the map, so it cannot answer
 * this question.
 */
function nativeRevision(profile: NativeRecord) {
  if (!isRecord(profile.ui_meta_revisions)) return undefined
  const revision = profile.ui_meta_revisions["hermes-bots"] ?? 0
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

/**
 * A catalog revision is an identifier, so it is bounded at 256 characters,
 * while the profile list it describes is not bounded at all. Naming every
 * profile inline crossed that bound at ten profiles and failed the whole
 * catalog, which reads to the browser as a runtime that is unavailable. A
 * digest stays bounded whatever the operator names their profiles, and still
 * changes whenever any agent's own revision does.
 */
function catalogRevision(agents: readonly AgentCatalogEntry[]) {
  const material = agents
    .map(({ summary, revision }) => `${summary.id}@${revision}`)
    .sort()
    .join(",")
  return `profiles:${createHash("sha256").update(material).digest("hex")}`
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

/**
 * How recent a binding snapshot has to be for a history load to restore the
 * retained turn from it instead of resuming the Session again.
 */
const RESTORE_SNAPSHOT_FRESH_MS = 3_000

export class HermesServerAdapter implements ServerRuntime {
  readonly #dashboard?: HermesDashboardClient
  readonly #workspace: HermesWorkspaceOperations
  readonly #content: ReturnType<typeof createHermesContentOperations>
  readonly #attachments: HermesAttachmentRegistry
  readonly #attachmentInfo = new Map<string, NativeRecord>()
  /** Live Session id to retained-record key, for events that carry only the id. */
  readonly #liveInfoKeys = new Map<string, string>()
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
        // Read the retained record, not the snapshot the scope was built from:
        // Hermes pushes `session.info` after every model or effort change, and a
        // read taken right after a write must see what this server just applied.
        sessionInfo: async (scope) => {
          const retained = this.#retainedInfo(scope.agentId, scope.sessionId)
          if (retained)
            return isRecord(retained.info) ? retained.info : retained
          return (scope as HermesWorkspaceSession & { info?: unknown }).info
        },
        recordSessionInfo: (scope, patch) =>
          this.#recordSessionInfo(scope.agentId, scope.sessionId, patch),
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
          let payload: unknown
          try {
            payload = await this.#dashboard.readArtifactDataUrl(
              scope.agentId,
              storedId,
              reference,
              maxResponseBytes
            )
          } catch (error) {
            if (
              error instanceof HermesHttpError &&
              UNREADABLE_ARTIFACT_STATUS.has(error.status)
            )
              throw new HermesContentUnreadableError()
            throw error
          }
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
        // Every observed `session.info` is retained on its way through, so a
        // workspace read never answers from the attach-time snapshot.
        onEvent: (listener) =>
          transport.onEvent?.((event) => {
            this.#retainObservedInfo(event)
            listener(event)
          }) ?? (() => undefined),
        onConnection: (handler) =>
          transport.onConnection?.(handler) ?? (() => undefined),
      },
      { idleMs: options.sessionIdleMs, log: options.log }
    )
    // `refresh` must reach the registry: a caller reconciling a Session (an
    // interactions `resume`) needs Hermes' own answer, whose `open_requests`
    // re-deliver whatever is still waiting on it.
    const ensureAttached = async (
      scope: HermesRunScope,
      attach: { refresh?: boolean } = {}
    ) => ({
      liveSessionId: (await this.#attachments.ensure(scope, attach))
        .liveSessionId,
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
      cause instanceof HermesContentScopeError ||
      // The artifact is still authoritative history, but the provider no longer
      // holds its bytes: "not found" is the honest answer, and unlike a 503 it
      // never invites a retry that cannot succeed.
      cause instanceof HermesContentUnreadableError
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

  #retainedInfo(agentId: string, publicSessionId: string) {
    const storedId = storedSessionIdentity(agentId, publicSessionId)
    return storedId
      ? this.#attachmentInfo.get(attachmentInfoKey(agentId, storedId))
      : undefined
  }

  /**
   * Folds a Session-info change this server applied into the retained record, so
   * the Session's own model state is fresh before Hermes echoes it back.
   */
  #recordSessionInfo(
    agentId: string,
    publicSessionId: string,
    patch: Readonly<NativeRecord>
  ) {
    const storedId = storedSessionIdentity(agentId, publicSessionId)
    if (!storedId) return
    const key = attachmentInfoKey(agentId, storedId)
    const retained = this.#attachmentInfo.get(key)
    this.#attachmentInfo.set(key, {
      ...retained,
      info: { ...(isRecord(retained?.info) ? retained.info : {}), ...patch },
    })
  }

  /**
   * Hermes pushes `session.info` after every model, effort, and activity change.
   * Retaining the latest one keeps workspace reads off the attach-time snapshot,
   * which would otherwise report the Session's model for the life of the socket.
   */
  #retainObservedInfo(event: unknown) {
    if (!isRecord(event) || event.type !== "session.info") return
    if (!validLiveSessionId(event.session_id)) return
    const key = this.#liveInfoKeys.get(event.session_id)
    const payload = isRecord(event.payload) ? event.payload : undefined
    if (!key || !payload) return
    const retained = this.#attachmentInfo.get(key)
    this.#attachmentInfo.set(key, {
      ...retained,
      info: payload,
      ...(typeof payload.running === "boolean"
        ? { running: payload.running }
        : {}),
    })
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

  updateModel(
    agentId: string,
    sessionId: string,
    patch: SessionModelUpdateRequest
  ) {
    return this.#workspace.updateModel(agentId, sessionId, patch)
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

  /** The validated native profile rows, one per distinct Agent id. */
  async #profiles(): Promise<NativeRecord[]> {
    try {
      const payload = await this.transport.request("profiles.list", {
        include_sessions: false,
      })
      const profiles = nativeProfiles(payload)
      if (
        new Set(profiles.map(({ name }) => trimmedText(name))).size !==
        profiles.length
      )
        throw new HermesUnavailableError()
      return profiles
    } catch (error) {
      if (error instanceof HermesAuthenticationError) throw error
      throw new HermesUnavailableError()
    }
  }

  async listAgents(): Promise<AgentCatalogResponse> {
    try {
      const agents = (await this.#profiles()).map(projectProfile)
      return AgentCatalogResponseSchema.parse({
        revision: catalogRevision(agents),
        agents,
      })
    } catch (error) {
      if (error instanceof HermesAuthenticationError) throw error
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
          sessionPin: {
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
          sessionReadState: {
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
        sessionPin: { status: "available" },
        sessionDeletion: { status: "available" },
        sessionRun: { status: "available" },
        sessionStop: { status: "available" },
        sessionSteer: { status: "available" },
        sessionReadState: { status: "available" },
      },
    })
  }

  async updateAgentVisibility(
    agentId: string,
    visibility: "visible" | "hidden",
    observedRevision: string
  ): Promise<VisibilityUpdateResponse> {
    // The list row is the only read that carries the CAS revision and the
    // stored `hermes-bots` keys the write must preserve; `profiles.configure`
    // then compares that revision itself, so a write that races another client
    // is rejected by Hermes rather than by a second read here.
    const profile = (await this.#profiles()).find(
      (row) => trimmedText(row.name) === agentId
    )
    if (!profile) throw new HermesAgentNotFoundError()
    const current = projectProfile(profile)
    if (!current.editable || current.revision === "unavailable")
      throw new HermesUnavailableError()
    if (current.revision !== observedRevision)
      throw new HermesRevisionConflictError()
    const expected = Number(current.revision.slice("hermes-bots:".length))

    let configured: unknown
    try {
      configured = await this.transport.request("profiles.configure", {
        name: agentId,
        ui_meta: {
          "hermes-bots": {
            ...nativeBots(profile),
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
    const key = attachmentInfoKey(scope.agentId, scope.sessionId)
    this.#attachmentInfo.set(key, payload)
    // A re-resumed Session answers under a new live id; the previous one can
    // never name this Session again.
    for (const [observed, mapped] of this.#liveInfoKeys)
      if (mapped === key && observed !== liveSessionId)
        this.#liveInfoKeys.delete(observed)
    this.#liveInfoKeys.set(liveSessionId, key)
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

  /**
   * Hermes broadcasts a debounced, payload-less `sessions.changed` on the same
   * multiplexed socket whenever its Session store moves. The frame carries no
   * Session id, so it is observed on the gateway's own event fan-out rather than
   * through the per-Session attachment routing.
   */
  async subscribeCatalogChanges(listener: () => void) {
    if (!this.transport.onEvent) throw new HermesUnavailableError()
    // A lost connection is not a catalog change, and this observer survives it:
    // the next authoritative read reconciles whatever was missed.
    return this.transport.onEvent((event) => {
      if (isRecord(event) && event.type === "sessions.changed") listener()
    })
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
        (row.is_active !== undefined && typeof row.is_active !== "boolean") ||
        (row.unread !== undefined && typeof row.unread !== "boolean") ||
        (row.pinned !== undefined && typeof row.pinned !== "boolean")
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
        // Read state is derived per catalog row; an older Hermes omits it, and
        // absent must stay absent rather than collapse to "read".
        ...(typeof row.unread === "boolean" ? { unread: row.unread } : {}),
        // The pin is stored, and absent stays absent for the same reason.
        ...(typeof row.pinned === "boolean" ? { pinned: row.pinned } : {}),
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
    const dashboard = this.#dashboard
    if (!dashboard) throw new HermesUnavailableError()
    await this.getSession(profile, storedId)
    // This contract pages in conversation messages while Hermes pages in durable
    // rows, and an unbounded number of those rows are display chrome the
    // projection drops. A page that projects to nothing therefore means "keep
    // reading older rows", not "the conversation is empty".
    let rows: unknown[] = []
    let messages: Array<SessionMessage | SessionPlanActivityMessage> = []
    let pagination: { total: number; nextOffset: number } | undefined
    let scanOffset = offset
    for (
      let fetches = 0;
      fetches <= MAX_EXTRA_HISTORY_PAGE_FETCHES;
      fetches += 1
    ) {
      let payload: unknown
      try {
        payload = await dashboard.getSessionMessages(
          profile,
          storedId,
          limit,
          scanOffset
        )
      } catch (error) {
        // Only the first fetch can mean "nothing persisted yet"; a 404 part way
        // through the scan contradicts the pages Hermes already served.
        if (
          error instanceof HermesHttpError &&
          error.status === 404 &&
          scanOffset === offset
        ) {
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
      const page = payload.messages
      // Validate every fetch against the offset it asked for. The last fetch's
      // arithmetic also carries the whole scan, because its offset already
      // includes every row read before it.
      pagination = historyPagination(
        limit,
        scanOffset,
        page.length,
        payload.pagination
      )
      scanOffset = pagination.nextOffset
      // `order=latest` pages backwards, so each extra fetch holds the rows just
      // older than the ones already read. Projecting the accumulated array as a
      // whole also lets a tool row pair with an assistant tool call that landed
      // on an older page. Every page but the last projects to nothing, and one
      // page holds at most `limit` rows, so the projection stays within `limit`.
      rows = [...page, ...rows]
      messages = projectHermesHistory(rows)
      // A short page means Hermes has no older rows left; an empty page says the
      // same even if a caller passed a degenerate limit.
      if (messages.length > 0 || page.length === 0 || page.length < limit) break
    }
    if (!pagination) throw new HermesUnavailableError()
    // Hermes keeps a turn that failed out of its transcript, so a last page
    // ending with an unanswered prompt is the one history load that asks Hermes
    // for the retained turn. Every other load leaves the Session alone.
    const trailing = messages.at(-1)
    const restored =
      pagination.total === pagination.nextOffset && trailing?.role === "user"
        ? await this.#restoredFailedTurn(profile, storedId, trailing)
        : undefined
    if (restored) messages.push(restored)
    const todos = latestHermesTodos(rows)
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

  /**
   * The failed turn Hermes retained for the prompt this transcript ends with,
   * read from the Session's own inflight snapshot.
   */
  async #restoredFailedTurn(
    agentId: string,
    storedId: string,
    trailing: SessionMessage
  ) {
    const prompt = trailing.content.find((part) => part.type === "text")
    if (prompt?.type !== "text") return undefined
    try {
      // The registry single-flights `session.resume`: a Session someone is
      // already resuming costs no second RPC, and a bound one is re-read
      // because a binding snapshot taken before the turn failed carries no
      // retained turn at all. A binding Hermes answered for moments ago already
      // carries it, so a burst of history loads costs one resume, not one each.
      await this.#attachments.ensure(
        {
          agentId,
          sessionId: storedId,
          threadId: sessionId(agentId, storedId),
        },
        { refresh: true, freshForMs: RESTORE_SNAPSHOT_FRESH_MS }
      )
    } catch {
      // A Session Hermes cannot resume restores nothing; the authoritative
      // transcript is still served.
      return undefined
    }
    const inflight = this.#resumedInflight(agentId, storedId)
    return inflight === undefined
      ? undefined
      : restoredHermesFailedTurn(inflight, {
          id: `aos-inflight:${sessionId(agentId, storedId)}`,
          userText: prompt.text,
          createdAt: trailing.createdAt,
        })
  }

  /** The retained turn from this Session's last `session.resume`, validated. */
  #resumedInflight(agentId: string, storedId: string) {
    return hermesInflightTurn(
      this.#attachmentInfo.get(attachmentInfoKey(agentId, storedId))?.inflight
    )
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
    const pinned = nativeFlag(payload.pinned)
    const result = SessionSchema.safeParse({
      id: sessionId(profile, storedId),
      agentId: profile,
      title: trimmedText(payload.title) ?? storedId,
      // This read reports the stored flags as SQLite integers, so an archived
      // Session arrives as `1`; an unreadable flag stays the archive default.
      archived: nativeFlag(payload.archived) ?? false,
      updatedAt: timestamp(payload.last_active ?? payload.started_at),
      status:
        payload.is_active === true ? ("running" as const) : ("idle" as const),
      ...(pinned === undefined ? {} : { pinned }),
      // `unread` is omitted: the Session detail read carries no derived
      // activity timestamp, so read state is unknowable here.
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
      // `unread` is omitted: an unpersisted draft has no derived activity
      // timestamp for Hermes to compare a read marker against.
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
    // The native patch owns every flag's side effects: pinning a Session also
    // clears `hidden` and exempts the row from auto-archive.
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
