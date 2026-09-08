import type {
  AgentSummary,
  AgentCatalogEntry,
  AgentVisibility,
  SessionCreationOptions,
  SessionMetadata,
  WorkspaceAdapter,
} from "../contracts"
import type { ReadonlyJSONValue } from "assistant-stream/utils"
import type { ThreadHistoryAdapter } from "@assistant-ui/react"

import type { AgUiActivityPublisher } from "./ag-ui-activity"

export type AgUiSessionMetadata = SessionMetadata & { title?: string }

export type AgUiSessionSnapshot = {
  messages: readonly unknown[]
  state?: ReadonlyJSONValue
  unstableResume?: boolean
}

export type AgUiWorkspaceTransport = {
  subscribeSessions?: (
    listener: () => void,
    onError?: (error: Error) => void
  ) => () => void
  resumeSession?: (
    threadId: string,
    options: Parameters<NonNullable<ThreadHistoryAdapter["resume"]>>[0]
  ) => ReturnType<NonNullable<ThreadHistoryAdapter["resume"]>>
  listAgents(): Promise<
    readonly (AgentSummary & {
      visibility?: AgentVisibility
      selectable?: boolean
      editable?: boolean
    })[]
  >
  updateAgentVisibility?: (
    agentId: string,
    visibility: AgentVisibility
  ) => Promise<void>
  listSessions(): Promise<readonly AgUiSessionMetadata[]>
  createSession(
    agentId: string,
    options?: SessionCreationOptions
  ): Promise<AgUiSessionMetadata>
  loadSession(threadId: string): Promise<AgUiSessionSnapshot>
}

export type AgUiWorkspaceOptions = {
  transport: AgUiWorkspaceTransport
  activityPublisher?: AgUiActivityPublisher
}

export class AgUiWorkspace implements WorkspaceAdapter {
  readonly updateAgentVisibility?: (
    agentId: string,
    visibility: AgentVisibility
  ) => Promise<void>
  readonly #transport: AgUiWorkspaceTransport
  readonly #createdSessions = new Map<string, SessionMetadata>()

  readonly subscribeActivity?: WorkspaceAdapter["subscribeActivity"]

  constructor({ transport, activityPublisher }: AgUiWorkspaceOptions) {
    this.#transport = transport
    if (transport.updateAgentVisibility) {
      this.updateAgentVisibility = async (agentId, visibility) => {
        const entry = (await this.listAgentCatalog()).find(
          (entry) => entry.summary.id === agentId
        )
        if (!entry?.editable)
          throw new Error("This Agent is managed by its provider")
        await transport.updateAgentVisibility!(agentId, visibility)
        const confirmed = (await this.listAgentCatalog()).find(
          (entry) => entry.summary.id === agentId
        )
        if (confirmed?.visibility !== visibility)
          throw new Error("AG-UI did not confirm Agent visibility")
      }
    }
    if (activityPublisher) {
      this.subscribeActivity =
        activityPublisher.subscribe.bind(activityPublisher)
    }
  }

  async listAgents() {
    return structuredClone(
      (await this.#transport.listAgents()).map((agent) => {
          const summary = { ...agent }
          if (summary.selectable === false) summary.visibility = "hidden"
          delete summary.selectable
          delete summary.editable
          return summary
        })
    )
  }

  async listAgentCatalog(): Promise<AgentCatalogEntry[]> {
    return (await this.#transport.listAgents()).flatMap(
      ({
        visibility = "visible",
        selectable = true,
        editable = false,
        ...summary
      }) =>
        summary.kind === "ready" && summary.role !== "creator"
          ? [
              {
                summary: structuredClone(summary),
                visibility,
                selectable: visibility === "visible" && selectable,
                editable: editable && Boolean(this.updateAgentVisibility),
              },
            ]
          : []
    )
  }

  async refreshAgents() {
    return this.listAgents()
  }

  async getSessionMetadata(threadIds: string[]) {
    const requested = new Set(threadIds)
    const sessions = await this.#transport.listSessions()
    const byThread = new Map<string, SessionMetadata>()

    for (const session of sessions) {
      if (requested.has(session.threadId)) {
        byThread.set(session.threadId, structuredClone(session))
      }
    }
    for (const [threadId, session] of this.#createdSessions) {
      if (requested.has(threadId) && !byThread.has(threadId)) {
        byThread.set(threadId, structuredClone(session))
      }
    }

    return threadIds.flatMap((threadId) => {
      const session = byThread.get(threadId)
      return session ? [structuredClone(session)] : []
    })
  }

  async createSession(agentId: string, options?: SessionCreationOptions) {
    const session = await this.#transport.createSession(agentId, options)
    if (session.agentId !== agentId) {
      throw new Error(
        `Session ownership mismatch: requested ${agentId}, received ${session.agentId}`
      )
    }

    this.#createdSessions.set(session.threadId, structuredClone(session))
    return { threadId: session.threadId }
  }
}

export function createAgUiWorkspace(options: AgUiWorkspaceOptions) {
  return new AgUiWorkspace(options)
}
