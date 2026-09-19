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
  type SessionMessage,
  type SessionModelUpdateRequest,
  type SessionPlanActivityMessage,
  type VisibilityUpdateResponse,
} from "../../../protocol"
import {
  HermesAuthenticationError,
  HermesHttpError,
  HermesRpcRejectedError,
  HermesRpcUncertainError,
} from "./transport"
import { projectHermesHistory } from "./history"
import { projectHermesMediaArtifacts } from "./media-artifacts"
import {
  HermesRunRewindConflictError,
  HermesRunEngine,
  HermesRunPublicError,
  type HermesRunNative,
  type HermesRunScope,
} from "./run"
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
  HermesContentScopeError,
  HermesContentUnavailableError,
  type HermesContentAttachment,
} from "./content"
import {
  HermesInteractionPublicError,
  HermesInteractions,
} from "./interactions"
import { HermesDashboardClient } from "./dashboard-client"
import { HermesAttachmentRegistry } from "./attachment-registry"
import {
  ServerRunSteerUncertainError,
  type ServerRuntime,
} from "../../core/runtime"
import type { ResumeEntry } from "@ag-ui/core"
import { nativeSlashCommands, nativeSlashInvocation } from "./slash-commands"

async function executeSlashCommand(
  transport: HermesRpcTransport,
  liveSessionId: string,
  name: string,
  args: string,
  depth = 0
): Promise<{ output: string; composerPrefill?: string } | undefined> {
  if (depth >= 4) throw new HermesUnavailableError()
  let result: unknown
  try {
    result = await transport.request(
      "slash.exec",
      {
        command: `${name}${args ? ` ${args}` : ""}`,
        session_id: liveSessionId,
      },
      1_048_576
    )
  } catch (error) {
    if (
      !(error instanceof HermesRpcRejectedError) ||
      (error.code !== -32601 && error.code !== 4018)
    )
      throw error
    result = await transport.request(
      "command.dispatch",
      { session_id: liveSessionId, name, arg: args },
      1_048_576
    )
  }
  if (!isRecord(result)) throw new HermesUnavailableError()
  if (result.type === "alias") {
    const target =
      typeof result.target === "string"
        ? /^\/?([^\s/]+)(?:\s+([\s\S]*))?$/u.exec(result.target)
        : undefined
    if (!target) throw new HermesUnavailableError()
    return executeSlashCommand(
      transport,
      liveSessionId,
      target[1]!,
      [target[2], args].filter(Boolean).join(" "),
      depth + 1
    )
  }
  if (result.type === "send" || result.type === "skill") {
    if (typeof result.message !== "string" || !result.message.trim())
      throw new HermesUnavailableError()
    await transport.request("prompt.submit", {
      session_id: liveSessionId,
      text: result.message,
    })
    return undefined
  }
  if (result.type === "prefill") {
    if (
      typeof result.message !== "string" ||
      !result.message ||
      Buffer.byteLength(result.message, "utf8") > 1_048_576 ||
      (result.notice !== undefined && typeof result.notice !== "string")
    )
      throw new HermesUnavailableError()
    return {
      output: typeof result.notice === "string" ? result.notice : "",
      composerPrefill: result.message,
    }
  }
  if (
    result.type !== "exec" &&
    result.type !== "plugin" &&
    typeof result.output !== "string" &&
    typeof result.warning !== "string"
  )
    throw new HermesUnavailableError()
  const output = [result.warning, result.output]
    .filter((value): value is string => typeof value === "string" && !!value)
    .join("\n")
  return { output }
}

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
    if (row.role === "tool") {
      const toolCallId = nonEmptyString(row.tool_call_id ?? row.toolCallId)
      const toolName = nonEmptyString(row.tool_name ?? row.toolName)
      if (toolCallId && toolName)
        for (const media of projectHermesMediaArtifacts(
          toolCallId,
          toolName,
          row.content ?? row.result
        ))
          if (media.descriptor.id === artifactId)
            return {
              reference: media.reference,
              filename: media.descriptor.filename,
            }
    }
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

function rewindSubmitParams(rows: readonly unknown[], rewindSourceId: string) {
  const history = projectHermesHistory(rows)
  const targetIndex = history.findIndex(
    ({ id, role }) => id === rewindSourceId && role === "user"
  )
  const target = targetIndex < 0 ? undefined : history[targetIndex]
  if (!target) throw new HermesRunRewindConflictError()

  const row = /^hermes-row-(\d+)$/u.exec(target.id)?.[1]
  const rowId = row === undefined ? undefined : Number(row)
  const address =
    rowId !== undefined && Number.isSafeInteger(rowId) && rowId > 0
      ? { truncate_before_row_id: rowId }
      : !target.id.startsWith("hermes-history-")
        ? { truncate_before_message_id: target.id }
        : undefined
  if (!address) throw new HermesRunRewindConflictError()

  return {
    confirm_truncate: true,
    ...address,
    ...(history.slice(0, targetIndex).some(({ role }) => role === "user")
      ? {}
      : { confirm_empty_truncate: true }),
  }
}

export class HermesServerAdapter implements HermesRunNative, ServerRuntime {
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
  readonly #pendingInteractionReleases = new Map<string, () => void>()
  readonly interactions: HermesInteractions
  readonly runs: HermesRunEngine

  constructor(
    private readonly transport: HermesRpcTransport,
    options: { sessionIdleMs?: number } = {}
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
    this.#attachments = new HermesAttachmentRegistry(
      {
        resume: (scope) => this.#resumeNative(scope),
        close: (liveSessionId) => this.#closeNativeSession(liveSessionId),
        observe: async (listener, disconnected) => {
          if (!this.transport.observeEvents) throw new HermesUnavailableError()
          return this.transport.observeEvents((event) => {
            this.#retainObservedInfo(event)
            listener(event)
          }, disconnected)
        },
      },
      { idleMs: options.sessionIdleMs }
    )
    this.interactions = new HermesInteractions({
      request: (method, params) => this.transport.request(method, params),
    })
    this.runs = new HermesRunEngine(this)
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
      active:
        resumed?.running === true ||
        resumed?.status === "working" ||
        resumed?.status === "waiting" ||
        resumed?.status === "starting",
      usage: info?.usage,
      info: info ?? resumed,
    }
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
        runId,
      })),
    }
  }

  inspectExecution(scope: HermesRunScope & { runId: string }) {
    return this.interactions.resume(scope)
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
    await this.#attachments.close()
    await this.transport.close?.()
  }

  acceptInteraction(
    scope: HermesRunScope & { runId: string },
    liveSessionId: string,
    event: unknown
  ) {
    const outcome = this.interactions.acceptNative(scope, liveSessionId, event)
    if (outcome && "interrupts" in outcome)
      this.#retainPendingInteraction(scope)
    return outcome
  }

  async respondInteractions(
    scope: HermesRunScope & { runId: string },
    resume: readonly ResumeEntry[]
  ) {
    await this.interactions.resume(scope)
    return Promise.all(
      resume.map((entry) => this.interactions.respond(scope, entry))
    ).then((results) => {
      if (
        results.every(
          ({ status }) => status === "resolved" || status === "expired"
        )
      )
        this.clearPendingInteraction(scope)
      return results
    })
  }

  clearPendingInteraction(scope: HermesRunScope) {
    const key = attachmentInfoKey(scope.agentId, scope.sessionId)
    this.#pendingInteractionReleases.get(key)?.()
    this.#pendingInteractionReleases.delete(key)
  }

  async #retainPendingInteraction(scope: HermesRunScope) {
    const key = attachmentInfoKey(scope.agentId, scope.sessionId)
    if (this.#pendingInteractionReleases.has(key)) return
    const release = await this.#attachments.retain(scope, "interaction")
    // A terminal event may have won the race while the attachment resumed.
    if (this.#pendingInteractionReleases.has(key)) release()
    else this.#pendingInteractionReleases.set(key, release)
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

  async resume(scope: HermesRunScope) {
    const attachment = await this.#attachments.ensure(scope)
    return { liveSessionId: attachment.liveSessionId }
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
      () => listener(),
      () => reset?.()
    )
  }

  async observe(
    liveSessionId: string,
    listener: (event: unknown) => void,
    disconnected?: (error?: Error) => void
  ) {
    try {
      return await this.#attachments.subscribeLive(
        liveSessionId,
        listener,
        disconnected
      )
    } catch (error) {
      // HermesRunEngine always attaches first. This fallback keeps the private
      // native adapter boundary usable for direct diagnostics without creating
      // a second transport or leaking it through ServerRuntime.
      if (!this.transport.observeEvents) throwUnavailable(error)
      let failed = false
      let stop: (() => void) | undefined
      const fail = () => {
        if (failed) return
        failed = true
        disconnected?.(new Error("Hermes observation failed"))
        stop?.()
      }
      try {
        stop = await this.transport.observeEvents((event) => {
          if (failed) return
          const disposition = observedEventDisposition(event, liveSessionId)
          if (disposition === "valid") listener(event)
          else if (disposition === "invalid") fail()
        }, fail)
        return stop
      } catch (fallbackError) {
        throwUnavailable(fallbackError)
      }
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
    const nativeLastSeen = payload.latest_seq ?? payload.last_seen
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

  async submit(
    liveSessionId: string,
    prompt: {
      scope: HermesRunScope
      text: string
      runId: string
      rewindSourceId?: string
    }
  ) {
    let invocation: Awaited<ReturnType<typeof nativeSlashInvocation>>
    if (prompt.text.startsWith("/")) {
      try {
        invocation = await nativeSlashInvocation(
          this.transport,
          { session_id: liveSessionId },
          prompt.text
        )
      } catch {
        return { acknowledgement: "rejected" as const }
      }
      if (invocation && prompt.scope.hasAttachments)
        return {
          acknowledgement: "rejected" as const,
          rejection: "command-with-attachments" as const,
        }
    }
    const rewind =
      invocation || prompt.rewindSourceId === undefined
        ? {}
        : rewindSubmitParams(
            await this.#rawHistory(prompt.scope),
            prompt.rewindSourceId
          )
    try {
      if (invocation) {
        let completion
        try {
          completion = await executeSlashCommand(
            this.transport,
            liveSessionId,
            invocation.name,
            invocation.args
          )
        } catch (error) {
          if (error instanceof HermesRpcRejectedError)
            return { acknowledgement: "rejected" as const }
          throw error
        }
        return {
          acknowledgement: "accepted" as const,
          ...(completion ? { completion } : {}),
        }
      }
      await this.transport.request("prompt.submit", {
        session_id: liveSessionId,
        text: prompt.text,
        ...rewind,
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

  async redirect(liveSessionId: string, text: string) {
    let payload: unknown
    try {
      payload = await this.transport.request("session.redirect", {
        session_id: liveSessionId,
        text,
      })
    } catch (error) {
      if (error instanceof HermesRpcUncertainError)
        throw new ServerRunSteerUncertainError()
      throwUnavailable(error)
    }
    if (
      !isRecord(payload) ||
      (payload.status !== "redirected" && payload.status !== "queued") ||
      typeof payload.text !== "string"
    )
      throw new HermesUnavailableError()
    return payload.status
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
    if (session.status === "working") return "running" as const
    // A cold Session is submit-ready: Hermes claims the prompt and waits for
    // its deferred agent build. Treating this as busy drops the first message.
    if (session.status === "starting" || session.status === "idle")
      return "idle" as const
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
        seen.has(storedId) ||
        (row.is_active !== undefined && typeof row.is_active !== "boolean")
      )
        throw new HermesUnavailableError()
      seen.add(storedId)
      return {
        id: sessionId(profile, storedId),
        agentId: profile,
        title: nonEmptyString(row.title) ?? storedId,
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
        nonEmptyString(payload.session_id) !== storedId ||
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
      nonEmptyString(payload.id) !== storedId ||
      (payload.is_active !== undefined &&
        typeof payload.is_active !== "boolean")
    )
      throw new HermesUnavailableError()
    if (nonEmptyString(payload.profile) !== profile)
      throw new HermesSessionNotFoundError()
    const result = SessionSchema.safeParse({
      id: sessionId(profile, storedId),
      agentId: profile,
      title: nonEmptyString(payload.title) ?? storedId,
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
    const storedId = nonEmptyString(payload.stored_session_id)
    const liveId = nonEmptyString(payload.session_id)
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
