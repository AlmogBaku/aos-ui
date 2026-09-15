import {
  AgentCatalogResponseSchema,
  SessionCatalogResponseSchema,
  SessionCreateResponseSchema,
  SessionPatchRequestSchema,
  SessionSchema,
  type AgentCatalogResponse,
  type Session,
  type SessionCatalogResponse,
} from "../../../protocol"
import {
  parseOpenCodeAgentCatalog,
  parseOpenCodeSession,
  parseOpenCodeSessionCatalog,
} from "./native-schemas"

const MAX_PAGE_SIZE = 100
const MAX_CATALOG_WINDOW = 1_000

export class OpenCodeWorkspaceScopeError extends Error {
  constructor() {
    super("Session is not available in this Agent scope")
    this.name = "OpenCodeWorkspaceScopeError"
  }
}

export class OpenCodeWorkspaceUnavailableError extends Error {
  constructor() {
    super("OpenCode workspace operation is temporarily unavailable")
    this.name = "OpenCodeWorkspaceUnavailableError"
  }
}

type OpenCodeWorkspaceClient = {
  catalog: { agents(signal?: AbortSignal): Promise<unknown> }
  sessions: {
    list(options?: {
      limit?: number
      cursor?: string
      signal?: AbortSignal
    }): Promise<unknown>
    get(sessionId: string, signal?: AbortSignal): Promise<unknown>
    create(input?: { agent?: string }, signal?: AbortSignal): Promise<unknown>
  }
}

export type OpenCodeWorkspaceOperations = ReturnType<
  typeof createOpenCodeWorkspaceOperations
>

function timestamp(value: number) {
  return new Date(value < 10_000_000_000 ? value * 1_000 : value).toISOString()
}

function revision(parts: readonly string[]) {
  let hash = 2_166_136_261
  for (const part of parts.join("\u0000")) {
    hash ^= part.charCodeAt(0)
    hash = Math.imul(hash, 16_777_619)
  }
  return `oc-${(hash >>> 0).toString(36)}`
}

function validPage(limit: number, offset: number) {
  return (
    Number.isSafeInteger(limit) &&
    Number.isSafeInteger(offset) &&
    limit >= 1 &&
    limit <= MAX_PAGE_SIZE &&
    offset >= 0 &&
    offset + limit <= MAX_CATALOG_WINDOW
  )
}

function projectSession(
  value: ReturnType<typeof parseOpenCodeSession>["data"],
  agentId: string
): Session {
  if (!value || value.agent !== agentId) throw new OpenCodeWorkspaceScopeError()
  const parsed = SessionSchema.safeParse({
    id: value.id,
    agentId,
    title: value.title,
    archived: value.time.archived !== undefined,
    updatedAt: timestamp(value.time.updated ?? value.time.created),
    status: "idle",
  })
  if (!parsed.success) throw new OpenCodeWorkspaceUnavailableError()
  return parsed.data
}

export function createOpenCodeWorkspaceOperations(input: {
  client: OpenCodeWorkspaceClient
  creatorAgentId?: string
  /**
   * Optional native integration operation for a title-bearing Session create.
   * The pinned v2 SDK facade has no title field, so callers without this exact
   * native acknowledgement leave invite creation unavailable.
   */
  createInvitedSession?: (
    agentId: string,
    title: string,
    firstTurnInstruction?: string
  ) => Promise<void>
  updateSession?: (
    sessionId: string,
    patch: { title?: string; archived?: boolean }
  ) => Promise<void>
  deleteSession?: (sessionId: string) => Promise<void>
}) {
  async function allSessions() {
    const sessions: NonNullable<
      ReturnType<typeof parseOpenCodeSessionCatalog>["data"]
    >["data"] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    do {
      const parsed = parseOpenCodeSessionCatalog(
        await input.client.sessions.list({
          limit: MAX_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        })
      )
      if (!parsed.success) throw new OpenCodeWorkspaceUnavailableError()
      sessions.push(...parsed.data.data)
      cursor = parsed.data.cursor.next
      if (cursor && seenCursors.has(cursor))
        throw new OpenCodeWorkspaceUnavailableError()
      if (cursor) seenCursors.add(cursor)
      if (sessions.length > MAX_CATALOG_WINDOW)
        throw new OpenCodeWorkspaceUnavailableError()
    } while (cursor)
    const ids = new Set<string>()
    if (sessions.some((session) => ids.has(session.id) || !ids.add(session.id)))
      throw new OpenCodeWorkspaceUnavailableError()
    return sessions
  }

  async function owned(agentId: string) {
    return (await allSessions())
      .filter((session) => session.agent === agentId)
      .map((session) => projectSession(session, agentId))
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
          left.id.localeCompare(right.id)
      )
  }

  return {
    capabilities: () => ({
      models: {
        status: "available" as const,
        scope: "session",
        source: "native-session-model" as const,
      },
      context: {
        status: "available" as const,
        scope: "session",
        source: "native-session-context" as const,
      },
      todos: {
        status: "available" as const,
        scope: "session",
        mode: "read-only-projection" as const,
      },
      activity: {
        status: "unavailable" as const,
        reason: "native-activity-unavailable",
      },
      agentVisibility: {
        status: "unavailable" as const,
        reason: "native-agent-catalog-read-only",
      },
      sessionTitle: {
        status: "unavailable" as const,
        reason: "native-session-title-unavailable",
      },
      sessionDeletion: {
        status: "unavailable" as const,
        reason: "native-session-delete-unavailable",
      },
    }),

    async listAgents(): Promise<AgentCatalogResponse> {
      const parsed = parseOpenCodeAgentCatalog(
        await input.client.catalog.agents()
      )
      if (!parsed.success) throw new OpenCodeWorkspaceUnavailableError()
      const agents = parsed.data.data
        .filter((agent) => agent.id !== input.creatorAgentId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((agent) => ({
          summary: {
            kind: "ready" as const,
            id: agent.id,
            name: agent.id,
            ...(agent.description ? { description: agent.description } : {}),
            status: "unknown" as const,
            activity: "unknown" as const,
            visibility: agent.hidden
              ? ("hidden" as const)
              : ("visible" as const),
          },
          visibility: agent.hidden ? ("hidden" as const) : ("visible" as const),
          selectable: !agent.hidden,
          editable: false,
          revision: revision([
            agent.id,
            agent.description ?? "",
            String(agent.hidden),
          ]),
        }))
      return AgentCatalogResponseSchema.parse({
        revision: revision(agents.map((agent) => agent.revision)),
        agents,
      })
    },

    async listSessions(
      agentId: string,
      limit: number,
      offset: number
    ): Promise<SessionCatalogResponse> {
      if (!validPage(limit, offset))
        throw new OpenCodeWorkspaceUnavailableError()
      const sessions = await owned(agentId)
      return SessionCatalogResponseSchema.parse({
        sessions: sessions.slice(offset, offset + limit),
        total: sessions.length,
        limit,
        offset,
      })
    },

    async listAllSessions(
      limit: number,
      offset: number
    ): Promise<SessionCatalogResponse> {
      if (!validPage(limit, offset))
        throw new OpenCodeWorkspaceUnavailableError()
      const sessions = (await allSessions())
        .filter((session) => !!session.agent)
        .map((session) => projectSession(session, session.agent!))
        .sort(
          (left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
            left.id.localeCompare(right.id)
        )
      return SessionCatalogResponseSchema.parse({
        sessions: sessions.slice(offset, offset + limit),
        total: sessions.length,
        limit,
        offset,
      })
    },

    async getSession(agentId: string, sessionId: string) {
      const parsed = parseOpenCodeSession(
        await input.client.sessions.get(sessionId)
      )
      if (!parsed.success) throw new OpenCodeWorkspaceUnavailableError()
      return projectSession(parsed.data, agentId)
    },

    async createSession(agentId: string) {
      const created = parseOpenCodeSession(
        await input.client.sessions.create({ agent: agentId })
      )
      if (!created.success) throw new OpenCodeWorkspaceUnavailableError()
      const session = projectSession(created.data, agentId)
      return SessionCreateResponseSchema.parse({
        session: { id: session.id, agentId },
      })
    },

    async mutateSession(
      agentId: string,
      sessionId: string,
      method: "PATCH" | "DELETE",
      body?: unknown
    ) {
      await this.getSession(agentId, sessionId)
      if (method === "DELETE") {
        if (!input.deleteSession) throw new OpenCodeWorkspaceUnavailableError()
        await input.deleteSession(sessionId)
        return
      }
      const patch = SessionPatchRequestSchema.safeParse(body)
      if (!patch.success || !input.updateSession)
        throw new OpenCodeWorkspaceUnavailableError()
      await input.updateSession(sessionId, patch.data)
      const confirmed = await this.getSession(agentId, sessionId)
      if (
        (patch.data.title !== undefined &&
          confirmed.title !== patch.data.title) ||
        (patch.data.archived !== undefined &&
          confirmed.archived !== patch.data.archived)
      )
        throw new OpenCodeWorkspaceUnavailableError()
    },

    async resolveInvitedSession(
      agentId: string,
      ref: string,
      create?: { firstTurnInstruction?: string }
    ) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(ref))
        throw new OpenCodeWorkspaceUnavailableError()
      const title = `aos-invite:${ref}`
      const matches = (await owned(agentId)).filter(
        (session) => session.title === title
      )
      if (matches.length > 1) throw new OpenCodeWorkspaceUnavailableError()
      if (matches.length === 1)
        return { sessionId: matches[0]!.id, created: false }
      if (!create) return undefined
      if (!input.createInvitedSession)
        throw new OpenCodeWorkspaceUnavailableError()
      await input.createInvitedSession(
        agentId,
        title,
        create.firstTurnInstruction
      )
      const confirmed = (await owned(agentId)).filter(
        (session) => session.title === title
      )
      if (confirmed.length !== 1) throw new OpenCodeWorkspaceUnavailableError()
      return { sessionId: confirmed[0]!.id, created: true }
    },
  }
}
