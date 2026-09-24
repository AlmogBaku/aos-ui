import { createHash } from "node:crypto"
import type {
  AgentCatalogResponse,
  AgentUpdatePatch,
  AgentUpdateResponse,
  Session,
  SessionCatalogResponse,
} from "../../../protocol"
import {
  AgentAvatarSchema,
  AgentUpdateResponseSchema,
  SessionCreateResponseSchema,
} from "../../../protocol"
import {
  ServerAgentUpdateUnsupportedError,
  type SessionPatch,
} from "../../core/runtime"

import {
  openClawAgentAvatarPatchParams,
  openClawAgentsParams,
  openClawConfigGetParams,
  openClawCreateSessionParams,
  openClawDeleteSessionParams,
  openClawInvitedSessionsParams,
  openClawPatchSessionParams,
  openClawSessionsParams,
  parseOpenClawAgents,
  parseOpenClawConfiguredAgents,
  parseOpenClawCreatedSession,
  parseOpenClawSessions,
  type OpenClawAgent,
  type OpenClawSession,
  type OpenClawSessionPatch,
} from "./native-schemas"

const INVITATION_REFERENCE = /^[A-Za-z0-9_-]{1,128}$/u
const MAX_SESSION_PAGE = 100
const MAX_SESSION_KEY_LENGTH = 4_096

export interface OpenClawWorkspaceClient {
  request<T>(method: string, params?: unknown): Promise<T>
}

export class OpenClawWorkspaceOwnershipError extends Error {
  constructor() {
    super("OpenClaw Session ownership could not be verified")
    this.name = "OpenClawWorkspaceOwnershipError"
  }
}

export class OpenClawWorkspaceUnavailableError extends Error {
  constructor() {
    super("OpenClaw workspace data is temporarily unavailable")
    this.name = "OpenClawWorkspaceUnavailableError"
  }
}

export class OpenClawWorkspaceRevisionConflictError extends Error {
  constructor() {
    super("Agent revision conflict")
    this.name = "OpenClawWorkspaceRevisionConflictError"
  }
}

function revision(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function agentName(agent: OpenClawAgent) {
  return agent.identity?.name ?? agent.name ?? agent.id
}

/**
 * OpenClaw's closed Agent summary has no field for a role, so the operator
 * installs the AOS creator under this reserved Agent id.
 */
export const OPENCLAW_CREATOR_AGENT_ID = "aos-agent-creator"

function isVisiblePrimaryAgent(
  agent: OpenClawAgent,
  hidden: ReadonlySet<string>
) {
  return (
    agent.kind !== "system" &&
    agent.createdVia !== "agent" &&
    agent.creatorAgentId == null &&
    !hidden.has(agent.id)
  )
}

function projectAgent(agent: OpenClawAgent, configured: ReadonlySet<string>) {
  const creator = agent.id === OPENCLAW_CREATOR_AGENT_ID
  const visibility = creator ? ("hidden" as const) : ("visible" as const)
  // A stored value that is not a token (a file path, a URL) reads as none.
  const avatar = AgentAvatarSchema.safeParse(agent.identity?.avatar)
  return {
    summary: {
      kind: "ready" as const,
      id: agent.id,
      name: agentName(agent),
      ...(avatar.success ? { avatar: avatar.data } : {}),
      ...(creator ? { visibility, role: "creator" as const } : {}),
    },
    visibility,
    selectable: !creator,
    editable: false,
    // Only an Agent with its own authored entry can take a merge-by-id patch;
    // the implicit default Agent has none.
    avatarEditable: !creator && configured.has(agent.id),
    revision: revision(agent),
  }
}

function verifyOwnership(agentId: string, row: OpenClawSession) {
  if (row.agentId !== agentId) throw new OpenClawWorkspaceOwnershipError()
}

function isBoundedSessionKey(value: string) {
  return (
    value.length > 0 &&
    value.length <= MAX_SESSION_KEY_LENGTH &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
}

function updatedAt(row: OpenClawSession) {
  const timestamp = row.lastInteractionAt ?? row.updatedAt ?? 0
  return new Date(timestamp).toISOString()
}

function sessionStatus(row: OpenClawSession): Session["status"] {
  return row.hasActiveRun === true || (row.activeRunIds?.length ?? 0) > 0
    ? "running"
    : "idle"
}

function projectSession(agentId: string, row: OpenClawSession): Session {
  verifyOwnership(agentId, row)
  return {
    id: row.key,
    agentId,
    title: row.label ?? row.displayName ?? row.key,
    archived: row.archived ?? false,
    ...(row.createdAt === undefined
      ? {}
      : { createdAt: new Date(row.createdAt).toISOString() }),
    updatedAt: updatedAt(row),
    status: sessionStatus(row),
    // Absent pin state stays absent: it never overwrites a known value.
    ...(typeof row.pinned === "boolean" ? { pinned: row.pinned } : {}),
  }
}

/**
 * Maps one normalized Session intent to its proven native equivalent. `unread`
 * and every rejected body stay unavailable rather than emulated.
 */
function nativeSessionPatch(patch: SessionPatch): OpenClawSessionPatch {
  if ("title" in patch) return { label: patch.title }
  if ("archived" in patch) return { archived: patch.archived }
  if ("pinned" in patch) return { pinned: patch.pinned }
  // OpenClaw has no native read state to write.
  throw new OpenClawWorkspaceUnavailableError()
}

export function invitedOpenClawSessionKey(agentId: string, ref: string) {
  if (
    typeof agentId !== "string" ||
    agentId.length === 0 ||
    agentId.length > 4_096 ||
    !INVITATION_REFERENCE.test(ref)
  )
    throw new OpenClawWorkspaceOwnershipError()
  return `agent:${agentId}:aos-invite:${ref}`
}

export type OpenClawWorkspace = Readonly<{
  listAgents(): Promise<AgentCatalogResponse>
  updateAgent(
    agentId: string,
    patch: AgentUpdatePatch,
    observedRevision: string
  ): Promise<AgentUpdateResponse>
  listSessions(
    agentId: string,
    limit: number,
    offset: number
  ): Promise<SessionCatalogResponse>
  listAllSessions(
    limit: number,
    offset: number
  ): Promise<SessionCatalogResponse>
  getSession(agentId: string, sessionKey: string): Promise<Session>
  createSession(agentId: string): Promise<unknown>
  updateSession(
    agentId: string,
    sessionKey: string,
    patch: SessionPatch
  ): Promise<void>
  deleteSession(agentId: string, sessionKey: string): Promise<void>
  resolveSessionId(agentId: string, publicSessionId: string): string | undefined
  resolveInvitedSession(
    agentId: string,
    ref: string
  ): Promise<{ sessionId: string; created: false } | undefined>
}>

export function createOpenClawWorkspace(input: {
  client: OpenClawWorkspaceClient
  hiddenAgentIds?: readonly string[]
}): OpenClawWorkspace {
  const hidden = new Set(input.hiddenAgentIds ?? [])
  const listNativeAgents = async () =>
    parseOpenClawAgents(
      await input.client.request("agents.list", openClawAgentsParams())
    )
  const listVisibleAgents = async () =>
    (await listNativeAgents())
      .filter((agent) => isVisiblePrimaryAgent(agent, hidden))
      .sort((left, right) => left.id.localeCompare(right.id))
  // `config.get` carries credentials: it is reduced on arrival and nothing
  // else from it is kept, logged, returned, or put in an error.
  const readConfiguredAgents = async () =>
    parseOpenClawConfiguredAgents(
      await input.client.request("config.get", openClawConfigGetParams())
    )
  const listAgents = async () => {
    const [agents, configured] = await Promise.all([
      listVisibleAgents(),
      // An unreadable config only means no Agent can take an avatar write.
      readConfiguredAgents().then(
        ({ agentIds }) => agentIds,
        () => new Set<string>()
      ),
    ])
    const entries = agents.map((agent) => projectAgent(agent, configured))
    return { revision: revision(entries), agents: entries }
  }
  const requireVisibleAgent = async (agentId: string) => {
    const agents = await listNativeAgents()
    const matches = agents.filter(
      (agent) => agent.id === agentId && isVisiblePrimaryAgent(agent, hidden)
    )
    if (matches.length !== 1) throw new OpenClawWorkspaceOwnershipError()
    return matches[0]!
  }
  const rows = async (agentId: string, limit: number, offset: number) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SESSION_PAGE)
      throw new OpenClawWorkspaceUnavailableError()
    if (!Number.isInteger(offset) || offset < 0)
      throw new OpenClawWorkspaceUnavailableError()
    await requireVisibleAgent(agentId)
    return parseOpenClawSessions(
      await input.client.request(
        "sessions.list",
        openClawSessionsParams(agentId, limit, offset)
      ),
      limit
    )
  }
  const listSessions = async (
    agentId: string,
    limit: number,
    offset: number
  ) => {
    const page = await rows(agentId, limit, offset)
    const sessions = page.map((row) => projectSession(agentId, row))
    return {
      sessions,
      total: offset + sessions.length + (page.length === limit ? 1 : 0),
      limit,
      offset,
    }
  }
  const getSession = async (agentId: string, sessionKey: string) => {
    await requireVisibleAgent(agentId)
    const page = parseOpenClawSessions(
      await input.client.request(
        "sessions.list",
        openClawInvitedSessionsParams(agentId, sessionKey)
      ),
      MAX_SESSION_PAGE
    )
    const matches = page.filter((row) => row.key === sessionKey)
    if (matches.length !== 1) throw new OpenClawWorkspaceOwnershipError()
    return projectSession(agentId, matches[0]!)
  }

  return {
    listAgents,
    async updateAgent(agentId, patch, observedRevision) {
      // A patch that touches visibility is unsupported as a whole, and the
      // avatar is re-checked so no caller reaches the native write unchecked.
      const avatar = AgentAvatarSchema.nullable().safeParse(patch.avatar)
      if (patch.visibility !== undefined || !avatar.success)
        throw new ServerAgentUpdateUnsupportedError()
      const agent = await requireVisibleAgent(agentId)
      if (agent.id === OPENCLAW_CREATOR_AGENT_ID)
        throw new ServerAgentUpdateUnsupportedError()
      if (revision(agent) !== observedRevision)
        throw new OpenClawWorkspaceRevisionConflictError()
      const configured = await readConfiguredAgents()
      if (!configured.agentIds.has(agent.id))
        throw new ServerAgentUpdateUnsupportedError()
      if (configured.hash === undefined)
        throw new OpenClawWorkspaceUnavailableError()
      await input.client.request(
        "config.patch",
        openClawAgentAvatarPatchParams(agent.id, avatar.data, configured.hash)
      )
      const confirmed = await listAgents()
      const updated = confirmed.agents.find(
        (entry) => entry.summary.id === agent.id
      )
      if ((updated?.summary.avatar ?? null) !== avatar.data)
        throw new OpenClawWorkspaceUnavailableError()
      return AgentUpdateResponseSchema.parse({
        revision: confirmed.revision,
        agent: updated,
      })
    },
    listSessions,
    async listAllSessions(limit, offset) {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SESSION_PAGE)
        throw new OpenClawWorkspaceUnavailableError()
      if (!Number.isInteger(offset) || offset < 0)
        throw new OpenClawWorkspaceUnavailableError()
      const agents = await listVisibleAgents()
      const prefix = offset + limit
      const fetchPrefix = async (agentId: string) => {
        const sessions: Session[] = []
        let pageOffset = 0
        let hasMore = false
        while (sessions.length < prefix) {
          const pageLimit = Math.min(MAX_SESSION_PAGE, prefix - sessions.length)
          const native = parseOpenClawSessions(
            await input.client.request(
              "sessions.list",
              openClawSessionsParams(agentId, pageLimit, pageOffset)
            ),
            pageLimit
          )
          sessions.push(...native.map((row) => projectSession(agentId, row)))
          if (native.length < pageLimit) break
          pageOffset += native.length
          hasMore = true
        }
        return { sessions, hasMore }
      }
      const pages: Array<{ sessions: Session[]; hasMore: boolean }> = []
      for (let start = 0; start < agents.length; start += 8)
        pages.push(
          ...(await Promise.all(
            agents.slice(start, start + 8).map((agent) => fetchPrefix(agent.id))
          ))
        )
      const sessions = pages
        .flat()
        .flatMap((page) => page.sessions)
        .sort(
          (left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
            left.id.localeCompare(right.id)
        )
      return {
        sessions: sessions.slice(offset, offset + limit),
        total: sessions.length + (pages.some((page) => page.hasMore) ? 1 : 0),
        limit,
        offset,
      }
    },
    getSession,
    async createSession(agentId) {
      await requireVisibleAgent(agentId)
      const created = parseOpenClawCreatedSession(
        await input.client.request(
          "sessions.create",
          openClawCreateSessionParams(agentId)
        )
      )
      await getSession(agentId, created.key)
      return SessionCreateResponseSchema.parse({
        session: { id: created.key, agentId },
      })
    },
    async updateSession(agentId, sessionKey, patch) {
      await getSession(agentId, sessionKey)
      await input.client.request(
        "sessions.patch",
        openClawPatchSessionParams(
          agentId,
          sessionKey,
          nativeSessionPatch(patch)
        )
      )
    },
    async deleteSession(agentId, sessionKey) {
      await getSession(agentId, sessionKey)
      await input.client.request(
        "sessions.delete",
        openClawDeleteSessionParams(agentId, sessionKey)
      )
    },
    resolveSessionId(_agentId, publicSessionId) {
      return isBoundedSessionKey(publicSessionId) ? publicSessionId : undefined
    },
    async resolveInvitedSession(agentId, ref) {
      const sessionKey = invitedOpenClawSessionKey(agentId, ref)
      await requireVisibleAgent(agentId)
      const page = parseOpenClawSessions(
        await input.client.request(
          "sessions.list",
          openClawInvitedSessionsParams(agentId, sessionKey)
        ),
        MAX_SESSION_PAGE
      )
      const matches = page.filter((row) => row.key === sessionKey)
      if (!matches.length) return undefined
      if (matches.length !== 1) throw new OpenClawWorkspaceOwnershipError()
      verifyOwnership(agentId, matches[0]!)
      return { sessionId: sessionKey, created: false }
    },
  }
}
