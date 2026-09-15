import { createHash } from "node:crypto"
import type {
  AgentCatalogResponse,
  Session,
  SessionCatalogResponse,
} from "../../../protocol"

import {
  openClawAgentsParams,
  openClawInvitedSessionsParams,
  openClawSessionsParams,
  parseOpenClawAgents,
  parseOpenClawSessions,
  type OpenClawAgent,
  type OpenClawSession,
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

function revision(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function agentName(agent: OpenClawAgent) {
  return agent.identity?.name ?? agent.name ?? agent.id
}

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
    updatedAt: updatedAt(row),
    status: sessionStatus(row),
  }
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

  return {
    async listAgents() {
      const agents = (await listNativeAgents())
        .filter((agent) => isVisiblePrimaryAgent(agent, hidden))
        .sort((left, right) => left.id.localeCompare(right.id))
      return {
        revision: revision(agents),
        agents: agents.map((agent) => ({
          summary: {
            kind: "ready" as const,
            id: agent.id,
            name: agentName(agent),
          },
          visibility: "visible" as const,
          selectable: true,
          editable: false,
          revision: revision(agent),
        })),
      }
    },
    listSessions,
    async listAllSessions(limit, offset) {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SESSION_PAGE)
        throw new OpenClawWorkspaceUnavailableError()
      if (!Number.isInteger(offset) || offset < 0)
        throw new OpenClawWorkspaceUnavailableError()
      const agents = (await listNativeAgents())
        .filter((agent) => isVisiblePrimaryAgent(agent, hidden))
        .sort((left, right) => left.id.localeCompare(right.id))
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
    async getSession(agentId, sessionKey) {
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
