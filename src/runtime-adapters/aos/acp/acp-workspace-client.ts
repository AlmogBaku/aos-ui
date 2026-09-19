import { AOS_METHODS, type AosSessionInfoMeta } from "@aos/protocol/acp"
import type {
  SessionModelUpdateRequest,
  SessionModelUpdateResponse,
} from "@aos/protocol"

import type { AgentVisibility, SessionCreationOptions } from "../../contracts"
import type { AosRemoteClient } from "../aos-client"
import { createAcpComposerStore } from "./acp-workspace-client-composer"
import { createAcpSessionStore, rowOf } from "./acp-workspace-client-sessions"
import type { AcpConnection } from "./types"

/**
 * The workspace surface over one ACP connection: Agent and Session ownership,
 * read state, focus, Todos, activity, and the composer's Session projection.
 * Bytes stay on REST, which the normalized client already owns.
 */

/** What the workspace still reads over REST, delegated to the AOS client. */
type AcpRestClient = Pick<
  AosRemoteClient,
  | "adoptSessionOwnership"
  | "readArtifact"
  | "runtimeInfo"
  | "speak"
  | "speakForAgent"
  | "stageAttachments"
  | "transcribe"
  | "transcribeForAgent"
>

export type AcpWorkspaceClientOptions = {
  connection: AcpConnection
  rest: AcpRestClient
  /** Ownership for a Session the row cache has not seen yet. */
  agentIdFor?: (threadId: string) => string | undefined
  now?: () => number
}

export function createAcpWorkspaceClient({
  connection,
  rest,
  agentIdFor,
  now,
}: AcpWorkspaceClientOptions) {
  const store = createAcpSessionStore({
    connection,
    ...(now ? { now } : {}),
  })
  const composer = createAcpComposerStore(connection)
  const revisions = new Map<string, string>()

  function remember(
    threadId: string,
    info: AosSessionInfoMeta,
    updatedAt?: string | null
  ) {
    store.put(threadId, info, updatedAt)
    try {
      rest.adoptSessionOwnership(threadId, info.agentId)
    } catch {
      // The proxy's row is authoritative; REST ownership is only a byte route.
    }
  }

  function knownAgentOf(threadId: string) {
    return store.agentIdOf(threadId) ?? agentIdFor?.(threadId)
  }

  function agentOf(threadId: string) {
    const agentId = knownAgentOf(threadId)
    if (!agentId) throw new Error("Session ownership is unknown")
    return agentId
  }

  async function catalog() {
    const response = await connection.listAgents()
    revisions.clear()
    for (const entry of response.agents)
      revisions.set(entry.summary.id, entry.revision)
    return response
  }

  async function listSessions(agentId?: string, cursor?: string) {
    const page = await connection.listSessions(
      agentId === undefined ? {} : { agentId },
      cursor
    )
    for (const session of page.sessions) {
      const row = rowOf(session)
      remember(row.threadId, row.info, row.updatedAt)
    }
    return {
      sessions: store.rowsFor(page.sessions.map(({ sessionId }) => sessionId)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    }
  }

  const client = {
    // Agents
    async listAgents() {
      return (await catalog()).agents.map(({ summary }) => summary)
    },
    async refreshAgents() {
      return (await catalog()).agents.map(({ summary }) => summary)
    },
    async listAgentCatalog() {
      return (await catalog()).agents.map(
        ({ summary, visibility, selectable, editable }) => ({
          summary,
          visibility,
          selectable,
          editable,
        })
      )
    },
    async updateAgentVisibility(agentId: string, visibility: AgentVisibility) {
      const revision = revisions.get(agentId)
      if (!revision || revision === "unavailable")
        throw new Error("Agent visibility requires a fresh catalog revision")
      const result = await connection.setVisibility({
        agentId,
        visibility,
        revision,
      })
      revisions.set(agentId, result.agent.revision)
    },
    subscribeAgentCatalog: (listener: () => void) =>
      connection.onNotification(AOS_METHODS.notify.catalogInvalidated, () =>
        listener()
      ),

    // Sessions
    listSessions,
    async getSessionMetadata(threadIds: string[]) {
      if (threadIds.some((threadId) => !store.knows(threadId)))
        await listSessions()
      return store.rowsFor(threadIds)
    },
    subscribeSessionMetadata: store.subscribeMetadata,
    async createSession(agentId: string, options?: SessionCreationOptions) {
      const created = await connection.newSession({
        agentId,
        ...(options?.title ? { title: options.title } : {}),
      })
      if (created.meta.session.agentId !== agentId)
        throw new Error("Invalid AOS Session ownership")
      store.observe(created.sessionId)
      remember(created.sessionId, created.meta.session)
      composer.attach(created.sessionId, {
        configOptions: created.configOptions,
        capabilities: created.meta.capabilities,
      })
      return { threadId: created.sessionId }
    },
    /**
     * Attaches a Session: the proxy replays it and the workspace records the
     * capabilities, config options, and execution state it reports. Naming the
     * owning Agent lets a deep link attach before any list.
     */
    async attachSession(
      threadId: string,
      resume?: { replayFromStart?: boolean }
    ) {
      store.observe(threadId)
      const agentId = knownAgentOf(threadId)
      const resumed = await connection.resumeSession(threadId, {
        replayFromStart: resume?.replayFromStart ?? false,
        ...(agentId ? { agentId } : {}),
        ...connection.lastSequence(threadId),
      })
      remember(threadId, resumed.meta.session)
      store.setStatus(threadId, resumed.meta.execution.status)
      composer.attach(threadId, {
        configOptions: resumed.configOptions,
        capabilities: resumed.meta.capabilities,
      })
      return resumed
    },
    async markSessionRead(threadId: string) {
      store.setUnread(threadId, false)
      await connection.updateSession({ sessionId: threadId, unread: false })
    },
    reportFocus: (threadId: string | null) => connection.focus(threadId),
    sessionStatus: store.status,
    subscribeSessionStatus: store.subscribeStatus,
    subscribeSessionInvalidation: store.subscribeInvalidation,
    subscribeTodos: store.subscribeTodos,
    subscribeActivity: store.subscribeActivity,

    // Composer
    async workspaceCapabilities(threadId: string) {
      return composer.capabilities(threadId)
    },
    async models(threadId: string) {
      return composer.models(threadId)
    },
    async context(threadId: string) {
      return composer.context(threadId)
    },
    selectModel: composer.selectModel,
    selectEffort: composer.selectEffort,
    /** One provider write per half; the response settles what the Session runs. */
    async updateModel(
      threadId: string,
      patch: SessionModelUpdateRequest
    ): Promise<SessionModelUpdateResponse> {
      let models =
        patch.selectedId === undefined
          ? composer.models(threadId)
          : await composer.selectModel(threadId, patch.selectedId)
      if (patch.effortId !== undefined)
        models = await composer.selectEffort(threadId, patch.effortId)
      return {
        selectedId: models.selectedId,
        ...(models.effortId === undefined ? {} : { effortId: models.effortId }),
      }
    },
    steerRun: (
      threadId: string,
      request: { requestId: string; text: string }
    ) => connection.steer({ sessionId: threadId, ...request }),

    // Bytes and runtime metadata stay on REST.
    runtimeInfo: rest.runtimeInfo.bind(rest),
    stageAttachments: rest.stageAttachments.bind(rest),
    readArtifact: rest.readArtifact.bind(rest),
    transcribe: rest.transcribe.bind(rest),
    transcribeForAgent: rest.transcribeForAgent.bind(rest),
    speak: rest.speak.bind(rest),
    speakForAgent: rest.speakForAgent.bind(rest),
    /** REST authorizes byte reads per Agent, so ownership must be known. */
    agentIdOf: agentOf,
  }

  return client
}

export type AcpWorkspaceClient = ReturnType<typeof createAcpWorkspaceClient>
