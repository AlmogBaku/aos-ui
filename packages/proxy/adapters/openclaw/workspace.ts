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

function ownerFromKey(sessionKey: string) {
  const match = /^agent:([^:]+):/u.exec(sessionKey)
  return match?.[1]
}

function verifyOwnership(agentId: string, row: OpenClawSession) {
  const embedded = ownerFromKey(row.key)
  if (
    (embedded !== undefined && embedded !== agentId) ||
    (row.agentId !== undefined && row.agentId !== agentId) ||
    (embedded !== undefined &&
      row.agentId !== undefined &&
      embedded !== row.agentId)
  )
    throw new OpenClawWorkspaceOwnershipError()
  if (embedded === undefined && row.agentId === undefined)
    throw new OpenClawWorkspaceOwnershipError()
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
  if (!INVITATION_REFERENCE.test(agentId) || !INVITATION_REFERENCE.test(ref))
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
      )
    )
  }
  const listSessions = async (
    agentId: string,
    limit: number,
    offset: number
  ) => {
    const page = await rows(agentId, limit, offset)
    const sessions = page.map((row) => projectSession(agentId, row))
    return { sessions, total: offset + sessions.length, limit, offset }
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
      const pages = await Promise.all(
        agents.map(async (agent) => {
          const native = parseOpenClawSessions(
            await input.client.request(
              "sessions.list",
              openClawSessionsParams(agent.id, MAX_SESSION_PAGE, 0)
            )
          )
          return native.map((row) => projectSession(agent.id, row))
        })
      )
      const sessions = pages
        .flat()
        .sort(
          (left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
            left.id.localeCompare(right.id)
        )
      return {
        sessions: sessions.slice(offset, offset + limit),
        total: sessions.length,
        limit,
        offset,
      }
    },
    async getSession(agentId, sessionKey) {
      const page = await rows(agentId, MAX_SESSION_PAGE, 0)
      const matches = page.filter((row) => row.key === sessionKey)
      if (matches.length !== 1) throw new OpenClawWorkspaceOwnershipError()
      return projectSession(agentId, matches[0]!)
    },
    resolveSessionId(agentId, publicSessionId) {
      return ownerFromKey(publicSessionId) === agentId
        ? publicSessionId
        : undefined
    },
    async resolveInvitedSession(agentId, ref) {
      const sessionKey = invitedOpenClawSessionKey(agentId, ref)
      await requireVisibleAgent(agentId)
      const page = parseOpenClawSessions(
        await input.client.request(
          "sessions.list",
          openClawInvitedSessionsParams(agentId, sessionKey)
        )
      )
      const matches = page.filter((row) => row.key === sessionKey)
      if (!matches.length) return undefined
      if (matches.length !== 1) throw new OpenClawWorkspaceOwnershipError()
      verifyOwnership(agentId, matches[0]!)
      return { sessionId: sessionKey, created: false }
    },
  }
}
