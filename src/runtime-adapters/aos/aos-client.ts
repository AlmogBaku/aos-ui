import type { z } from "zod"

import {
  AgentCatalogResponseSchema,
  HermesAuthStateSchema,
  OperatorAuthStateSchema,
  RuntimeInfoSchema,
  VisibilityUpdateResponseSchema,
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

  runtimeAuth() {
    return this.#read("/auth/hermes", HermesAuthStateSchema)
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

  async getSessionMetadata() {
    return []
  }

  async createSession(): Promise<{ threadId: string }> {
    throw new Error("Session creation is not available from this runtime yet")
  }
}
