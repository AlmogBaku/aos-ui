import {
  AgentCatalogResponseSchema,
  HermesAuthStateSchema,
  RuntimeInfoSchema,
  SessionCatalogResponseSchema,
  SessionCreateResponseSchema,
  SessionHistoryResponseSchema,
  SessionSchema,
  SESSION_CATALOG_MAX_WINDOW,
  VisibilityUpdateResponseSchema,
  type AgentCatalogEntry,
  type AgentCatalogResponse,
  type HermesAuthState,
  type RuntimeInfo,
  type VisibilityUpdateResponse,
} from "../protocol"
import { HermesAuthenticationError, HermesHttpError } from "./hermes-transport"
import { projectHermesHistory } from "./hermes-history"

export interface HermesRpcTransport {
  request(
    method: string,
    params: Readonly<Record<string, unknown>>
  ): Promise<unknown>
  http?(
    path: string,
    init?: { method?: string; body?: unknown }
  ): Promise<unknown>
  authState?(): Promise<HermesAuthState>
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

function timestamp(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value)
  return Number.isFinite(numeric) && numeric > 0
    ? new Date(
        numeric < 10_000_000_000 ? numeric * 1000 : numeric
      ).toISOString()
    : new Date(0).toISOString()
}

export class HermesServerAdapter {
  constructor(private readonly transport: HermesRpcTransport) {}

  async authState(): Promise<HermesAuthState> {
    if (this.transport.authState)
      return HermesAuthStateSchema.parse(await this.transport.authState())
    try {
      await this.transport.request("profiles.list", { include_sessions: false })
      return { status: "authenticated", method: "static-token" }
    } catch (error) {
      if (error instanceof HermesAuthenticationError)
        return { status: "unauthenticated" }
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
    } catch {
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
    } catch {
      throw new HermesUnavailableError()
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
    } catch {
      throw new HermesUnavailableError()
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

  async listSessions(profile: string, limit: number, offset: number) {
    if (!this.transport.http) throw new HermesUnavailableError()
    const query = new URLSearchParams({
      profile,
      limit: String(limit),
      offset: String(offset),
      order: "recent",
      archived: "include",
      exclude_sources: "cron,tool,kanban",
    })
    let payload: unknown
    try {
      payload = await this.transport.http(`/api/sessions?${query}`)
    } catch {
      throw new HermesUnavailableError()
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
    if (!this.transport.http) throw new HermesUnavailableError()
    await this.getSession(profile, storedId)
    const query = new URLSearchParams({
      profile,
      limit: String(limit),
      offset: String(offset),
      order: "oldest",
      include_compacted: "true",
    })
    let payload: unknown
    try {
      payload = await this.transport.http(
        `/api/sessions/${encodeURIComponent(storedId)}/messages?${query}`
      )
    } catch (error) {
      if (error instanceof HermesHttpError && error.status === 404)
        throw new HermesSessionNotFoundError()
      throw new HermesUnavailableError()
    }
    if (
      !isRecord(payload) ||
      nonEmptyString(payload.session_id) !== storedId ||
      !Array.isArray(payload.messages)
    )
      throw new HermesUnavailableError()
    const result = SessionHistoryResponseSchema.safeParse({
      sessionId: sessionId(profile, storedId),
      messages: projectHermesHistory(payload.messages),
      total:
        isRecord(payload.pagination) &&
        typeof payload.pagination.total === "number"
          ? payload.pagination.total
          : payload.messages.length,
      limit,
      offset,
      nextOffset:
        offset +
        (isRecord(payload.pagination) &&
        typeof payload.pagination.returned === "number" &&
        Number.isSafeInteger(payload.pagination.returned) &&
        payload.pagination.returned >= 0
          ? payload.pagination.returned
          : payload.messages.length),
    })
    if (!result.success) throw new HermesUnavailableError()
    return result.data
  }

  async getSession(profile: string, storedId: string) {
    if (!this.transport.http) throw new HermesUnavailableError()
    let payload: unknown
    try {
      payload = await this.transport.http(
        `/api/sessions/${encodeURIComponent(storedId)}?profile=${encodeURIComponent(profile)}`
      )
    } catch (error) {
      if (error instanceof HermesHttpError && error.status === 404)
        throw new HermesSessionNotFoundError()
      throw new HermesUnavailableError()
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
    } catch {
      throw new HermesUnavailableError()
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
    if (!this.transport.http) throw new HermesUnavailableError()
    try {
      await this.transport.http(
        `/api/sessions/${encodeURIComponent(storedId)}?profile=${encodeURIComponent(profile)}`,
        { method, body }
      )
    } catch (error) {
      if (error instanceof HermesHttpError && error.status === 404)
        throw new HermesSessionNotFoundError()
      if (error instanceof HermesHttpError && error.status === 409)
        throw new HermesSessionConflictError()
      throw new HermesUnavailableError()
    }
  }
}
