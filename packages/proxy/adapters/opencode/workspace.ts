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
    update(
      sessionId: string,
      input: {
        title?: string
        time?: { archived?: number }
        metadata?: Record<string, unknown>
      },
      signal?: AbortSignal
    ): Promise<void>
    delete(sessionId: string, signal?: AbortSignal): Promise<void>
  }
}

/** AOS owns this one native metadata key; OpenCode has no native pin flag. */
export const OPENCODE_PIN_METADATA_KEY = "aos.pinned"

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
    // Only a metadata-bearing row proves the pin state; absence stays absent.
    ...(value.metadata
      ? { pinned: value.metadata[OPENCODE_PIN_METADATA_KEY] === true }
      : {}),
  })
  if (!parsed.success) throw new OpenCodeWorkspaceUnavailableError()
  return parsed.data
}

export function createOpenCodeWorkspaceOperations(input: {
  client: OpenCodeWorkspaceClient
  creatorAgentId?: string
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

  /** One authoritative read that both projects and proves exact ownership. */
  async function readSession(agentId: string, sessionId: string) {
    const parsed = parseOpenCodeSession(
      await input.client.sessions.get(sessionId)
    )
    if (!parsed.success) throw new OpenCodeWorkspaceUnavailableError()
    return {
      native: parsed.data,
      session: projectSession(parsed.data, agentId),
    }
  }

  async function patchSession(
    agentId: string,
    sessionId: string,
    body: unknown
  ) {
    const { native } = await readSession(agentId, sessionId)
    const intent = SessionPatchRequestSchema.safeParse(body)
    if (!intent.success) throw new OpenCodeWorkspaceUnavailableError()
    const { title, archived, pinned } = intent.data
    if (title !== undefined)
      return input.client.sessions.update(sessionId, { title })
    if (archived !== undefined)
      // An empty native `time` is the only unarchive the pinned SDK can
      // express: it types `time.archived` as a bare number and offers no
      // unarchive route. Unverified until a live OpenCode acceptance run.
      return input.client.sessions.update(sessionId, {
        time: archived ? { archived: Date.now() } : {},
      })
    if (pinned !== undefined)
      // Merge, never replace: foreign native metadata keys must survive.
      return input.client.sessions.update(sessionId, {
        metadata: { ...native.metadata, [OPENCODE_PIN_METADATA_KEY]: pinned },
      })
    // `unread` has no native read state to write, so it stays unavailable.
    throw new OpenCodeWorkspaceUnavailableError()
  }

  type InviteResolution = { sessionId: string; created: false } | undefined
  const invitedResolutions = new Map<string, Promise<InviteResolution>>()

  async function resolveInvite(
    agentId: string,
    ref: string,
    create?: { firstTurnInstruction?: string }
  ): Promise<InviteResolution> {
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
    // OpenCode v2 creates only an unmarked Session, and the reserved invitation
    // title would need a second, non-atomic rename that can leave an untitled
    // Session behind. Invited creation therefore stays unavailable.
    throw new OpenCodeWorkspaceUnavailableError()
  }

  return {
    capabilities: () => ({
      models: {
        status: "available" as const,
        scope: "attached-session" as const,
        selection: "native-session" as const,
        choices: "provider-reported" as const,
      },
      context: {
        status: "unavailable" as const,
        reason: "native-context-accounting-unavailable",
      },
      // OpenCode owns the list: the native Todo route restores it and the
      // native Todo tool's own input publishes every change during a run.
      todos: {
        status: "available" as const,
        scope: "session" as const,
        mode: "read-only-projection" as const,
        source: "latest-completed-todo-tool-result" as const,
      },
      activity: {
        status: "unavailable" as const,
        reason: "native-activity-unavailable",
      },
      agentVisibility: {
        status: "unavailable" as const,
        reason: "native-agent-catalog-read-only",
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
      return (await readSession(agentId, sessionId)).session
    },

    patchSession,

    async deleteSession(agentId: string, sessionId: string) {
      await readSession(agentId, sessionId)
      await input.client.sessions.delete(sessionId)
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

    resolveInvitedSession(
      agentId: string,
      ref: string,
      create?: { firstTurnInstruction?: string }
    ) {
      const key = `${agentId}\u0000${ref}`
      const existing = invitedResolutions.get(key)
      if (existing) return existing
      const pending = resolveInvite(agentId, ref, create)
      invitedResolutions.set(key, pending)
      const release = () => {
        if (invitedResolutions.get(key) === pending)
          invitedResolutions.delete(key)
      }
      void pending.then(release, release)
      return pending
    },
  }
}
