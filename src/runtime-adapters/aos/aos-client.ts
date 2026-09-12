import type { z } from "zod"

import {
  AgentCatalogResponseSchema,
  OperatorAuthStateSchema,
  RuntimeInfoSchema,
  SessionCatalogResponseSchema,
  SessionCreateResponseSchema,
  SessionHistoryResponseSchema,
  SessionSchema,
  VisibilityUpdateResponseSchema,
} from "../../../packages/protocol"
import type {
  Session,
  SessionHistoryResponse,
} from "../../../packages/protocol"
import type {
  AgentCatalogEntry,
  AgentVisibility,
  WorkspaceAdapter,
} from "../contracts"

type Schema<T> = Pick<z.ZodType<T>, "safeParse">

export type AosRemoteClientOptions = {
  fetcher?: typeof fetch
}

export class AosRemoteClient implements WorkspaceAdapter {
  readonly #fetch: typeof fetch
  readonly #revisions = new Map<string, string>()
  readonly #sessions = new Map<string, Session>()
  readonly #sessionOwners = new Map<string, string>()

  constructor(options: AosRemoteClientOptions = {}) {
    this.#fetch = options.fetcher ?? globalThis.fetch.bind(globalThis)
  }

  async #read<T>(
    path: string,
    schema: Schema<T>,
    init?: RequestInit
  ): Promise<T> {
    let response: Response
    try {
      response = await this.#fetch(`/api/aos/v1${path}`, {
        ...init,
        credentials: "same-origin",
        headers: { accept: "application/json", ...init?.headers },
      })
    } catch {
      throw new Error("AOS proxy request failed")
    }
    if (!response.ok)
      throw new Error(`AOS proxy request failed (${response.status})`)
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new Error("Invalid AOS proxy response")
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success) throw new Error("Invalid AOS proxy response")
    return parsed.data
  }

  operatorAuth() {
    return this.#read("/auth/operator", OperatorAuthStateSchema)
  }

  runtimeInfo() {
    return this.#read("/runtime", RuntimeInfoSchema)
  }

  async #catalog() {
    const catalog = await this.#read("/agents", AgentCatalogResponseSchema)
    this.#revisions.clear()
    for (const entry of catalog.agents)
      this.#revisions.set(entry.summary.id, entry.revision)
    return catalog
  }

  async listAgents() {
    return (await this.#catalog()).agents.map(({ summary }) =>
      structuredClone(summary)
    )
  }

  refreshAgents() {
    return this.listAgents()
  }

  async listAgentCatalog(): Promise<AgentCatalogEntry[]> {
    return (await this.#catalog()).agents.map(
      ({ summary, visibility, selectable, editable }) =>
        structuredClone({ summary, visibility, selectable, editable })
    )
  }

  async updateAgentVisibility(agentId: string, visibility: AgentVisibility) {
    const revision = this.#revisions.get(agentId)
    if (!revision || revision === "unavailable")
      throw new Error("Agent visibility requires a fresh catalog revision")
    const result = await this.#read(
      `/agents/${encodeURIComponent(agentId)}/visibility`,
      VisibilityUpdateResponseSchema,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility, revision }),
      }
    )
    this.#revisions.set(agentId, result.agent.revision)
  }

  async listSessions(agentId: string, limit = 50, offset = 0) {
    const page = await this.#read(
      `/agents/${encodeURIComponent(agentId)}/sessions?limit=${limit}&offset=${offset}`,
      SessionCatalogResponseSchema
    )
    if (page.sessions.some((session) => session.agentId !== agentId))
      throw new Error("Invalid AOS proxy response")
    for (const session of page.sessions) this.#rememberSession(session)
    return page
  }

  async listSessionCatalog(limit = 50, offset = 0) {
    const page = await this.#read(
      `/sessions?limit=${limit}&offset=${offset}`,
      SessionCatalogResponseSchema
    )
    for (const session of page.sessions) this.#rememberSession(session)
    return page
  }

  async getSession(threadId: string) {
    const agentId = this.#owner(threadId)
    const session = await this.#read(
      `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}`,
      SessionSchema
    )
    if (session.id !== threadId || session.agentId !== agentId)
      throw new Error("Invalid AOS proxy response")
    this.#rememberSession(session)
    return session
  }

  async getSessionMetadata(threadIds: string[]) {
    const sessions = await Promise.all(
      threadIds.map(async (threadId) => {
        const cached = this.#sessions.get(threadId)
        if (cached) return cached
        return this.#sessionOwners.has(threadId)
          ? this.getSession(threadId)
          : undefined
      })
    )
    return sessions.flatMap((session) => {
      return session
        ? [
            {
              threadId: session.id,
              agentId: session.agentId,
              updatedAt: session.updatedAt,
              status: session.status,
            },
          ]
        : []
    })
  }

  async createSession(
    agentId: string,
    options?: { title: string }
  ): Promise<{ threadId: string }> {
    const result = await this.#read(
      `/agents/${encodeURIComponent(agentId)}/sessions`,
      SessionCreateResponseSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options ? { title: options.title } : {}),
      }
    )
    if (result.session.agentId !== agentId)
      throw new Error("Invalid AOS proxy response")
    this.#sessionOwners.set(result.session.id, agentId)
    return { threadId: result.session.id }
  }

  async loadHistory(threadId: string): Promise<SessionHistoryResponse> {
    const agentId = this.#owner(threadId)
    const messages: SessionHistoryResponse["messages"] = []
    const seen = new Set<string>()
    let offset = 0
    let total = 0
    do {
      const page = await this.#read(
        `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}/history?limit=200&offset=${offset}`,
        SessionHistoryResponseSchema
      )
      if (
        page.sessionId !== threadId ||
        page.offset !== offset ||
        page.nextOffset < offset ||
        (page.nextOffset === offset && page.nextOffset < page.total)
      )
        throw new Error("Invalid AOS proxy response")
      for (const message of page.messages) {
        if (seen.has(message.id)) throw new Error("Invalid AOS proxy response")
        seen.add(message.id)
        messages.push(message)
      }
      total = page.total
      offset = page.nextOffset
    } while (offset < total)
    return {
      sessionId: threadId,
      messages,
      total,
      limit: 200,
      offset: 0,
      nextOffset: offset,
    }
  }

  renameSession(threadId: string, title: string) {
    return this.#patchSession(threadId, { title })
  }

  archiveSession(threadId: string) {
    return this.#patchSession(threadId, { archived: true })
  }

  unarchiveSession(threadId: string) {
    return this.#patchSession(threadId, { archived: false })
  }

  async deleteSession(threadId: string) {
    const agentId = this.#owner(threadId)
    await this.#writeVoid(
      `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}`,
      { method: "DELETE" }
    )
    this.#sessions.delete(threadId)
    this.#sessionOwners.delete(threadId)
  }

  async #patchSession(
    threadId: string,
    patch: { title: string } | { archived: boolean }
  ) {
    const agentId = this.#owner(threadId)
    await this.#writeVoid(
      `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }
    )
    const current = this.#sessions.get(threadId)
    if (current) this.#sessions.set(threadId, { ...current, ...patch })
  }

  async #writeVoid(path: string, init: RequestInit) {
    let response: Response
    try {
      response = await this.#fetch(`/api/aos/v1${path}`, {
        ...init,
        credentials: "same-origin",
        headers: { accept: "application/json", ...init.headers },
      })
    } catch {
      throw new Error("AOS proxy request failed")
    }
    if (!response.ok)
      throw new Error(`AOS proxy request failed (${response.status})`)
  }

  #rememberSession(session: Session) {
    this.#sessions.set(session.id, structuredClone(session))
    this.#sessionOwners.set(session.id, session.agentId)
  }

  #owner(threadId: string) {
    const owner = this.#sessionOwners.get(threadId)
    if (!owner) throw new Error("Session ownership is unknown")
    return owner
  }
}
