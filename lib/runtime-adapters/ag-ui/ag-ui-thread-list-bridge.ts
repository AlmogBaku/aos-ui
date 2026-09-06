import type { AbstractAgent } from "@ag-ui/client"
import {
  fromThreadMessageLike,
  type ThreadHistoryAdapter,
  type ThreadMessage,
} from "@assistant-ui/react"
import {
  fromAgUiMessages,
  type UseAgUiThreadListAdapter,
} from "@assistant-ui/react-ag-ui"

import type {
  AgUiSessionMetadata,
  AgUiSessionSnapshot,
  AgUiWorkspaceTransport,
} from "./ag-ui-workspace"

type BridgeSnapshot = {
  isLoading: boolean
  sessions: readonly AgUiSessionMetadata[]
  activeThreadId: string | undefined
}

const initialSnapshot: BridgeSnapshot = {
  isLoading: true,
  sessions: [],
  activeThreadId: undefined,
}

function newestFirst(sessions: readonly AgUiSessionMetadata[]) {
  return [...sessions].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.threadId.localeCompare(right.threadId)
  )
}

function toThreadMessages(snapshot: AgUiSessionSnapshot): ThreadMessage[] {
  return fromAgUiMessages(snapshot.messages).map((message, index) =>
    fromThreadMessageLike(message, `ag-ui-history-${index}`, {
      type: "complete",
      reason: "unknown",
    })
  )
}

function toRepository(snapshot: AgUiSessionSnapshot) {
  const messages = toThreadMessages(snapshot)
  let parentId: string | null = null
  const repositoryMessages = messages.map((message) => {
    const item = { parentId, message }
    parentId = message.id
    return item
  })

  return {
    headId: parentId,
    messages: repositoryMessages,
    ...(snapshot.state === undefined ? {} : { state: snapshot.state }),
    ...(snapshot.unstableResume === undefined
      ? {}
      : { unstable_resume: snapshot.unstableResume }),
  }
}

function sameSessions(
  left: readonly AgUiSessionMetadata[],
  right: readonly AgUiSessionMetadata[]
) {
  return (
    left.length === right.length &&
    left.every((session, index) => {
      const other = right[index]
      return (
        other !== undefined &&
        session.threadId === other.threadId &&
        session.agentId === other.agentId &&
        session.title === other.title &&
        session.updatedAt === other.updatedAt &&
        session.status === other.status
      )
    })
  )
}

/**
 * Bridges host-owned Session metadata into the official AG-UI thread-list
 * adapter. Messages are converted into Assistant UI's repository only at the
 * official history/switch boundaries; no parallel conversation state exists.
 */
export class AgUiThreadListBridge {
  readonly #agent: AbstractAgent
  readonly #transport: AgUiWorkspaceTransport
  readonly #listeners = new Set<() => void>()
  readonly #createdSessions = new Map<string, AgUiSessionMetadata>()
  #snapshot = initialSnapshot
  #initialization: Promise<void> | undefined
  #switchGeneration = 0

  readonly workspaceTransport: AgUiWorkspaceTransport

  constructor(agent: AbstractAgent, transport: AgUiWorkspaceTransport) {
    this.#agent = agent
    this.#transport = transport
    this.workspaceTransport = {
      listAgents: () => this.#transport.listAgents(),
      listSessions: async () => {
        const sessions = await this.#transport.listSessions()
        this.#replaceSessions(sessions)
        return sessions
      },
      createSession: async (agentId, options) => {
        const session = await this.#transport.createSession(agentId, options)
        if (session.agentId !== agentId) {
          throw new Error(
            `Session ownership mismatch: requested ${agentId}, received ${session.agentId}`
          )
        }
        this.#addSession(session)
        return session
      },
      loadSession: (threadId) => this.#transport.loadSession(threadId),
    }
  }

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getSnapshot = () => this.#snapshot

  async initialize() {
    if (!this.#initialization) {
      const initialization = this.#transport
        .listSessions()
        .then((sessions) => {
          const ordered = newestFirst(sessions)
          const configuredThreadId = this.#agent.threadId || undefined
          const activeThreadId = ordered.some(
            ({ threadId }) => threadId === configuredThreadId
          )
            ? configuredThreadId
            : ordered[0]?.threadId
          this.#retargetAgent(activeThreadId, ordered)
          this.#setSnapshot({
            isLoading: false,
            sessions: ordered,
            activeThreadId,
          })
        })
        .catch((error: unknown) => {
          if (this.#initialization === initialization) {
            this.#initialization = undefined
          }
          this.#setSnapshot({ ...this.#snapshot, isLoading: false })
          throw error
        })
      this.#initialization = initialization
      if (!this.#snapshot.isLoading) {
        this.#setSnapshot({ ...this.#snapshot, isLoading: true })
      }
    }
    return this.#initialization
  }

  readonly history: ThreadHistoryAdapter = {
    load: async () => {
      await this.initialize()
      const threadId = this.#snapshot.activeThreadId
      if (!threadId) return { headId: null, messages: [] }
      return toRepository(await this.#transport.loadSession(threadId))
    },
    append: async () => {
      // AG-UI sends the canonical message history with every run. Durable
      // storage, when present, remains the provider's responsibility.
    },
  }

  getThreadListAdapter(
    snapshot: BridgeSnapshot = this.#snapshot
  ): UseAgUiThreadListAdapter {
    return {
      isLoading: snapshot.isLoading,
      threadId: snapshot.activeThreadId,
      threads: snapshot.sessions.map((session) => ({
        id: session.threadId,
        remoteId: session.threadId,
        externalId: session.threadId,
        title: session.title,
        status: "regular",
      })),
      onSwitchToThread: async (threadId) => {
        const generation = ++this.#switchGeneration
        await this.initialize()
        let sessions = this.#snapshot.sessions
        let session = sessions.find((item) => item.threadId === threadId)
        if (!session) {
          sessions = newestFirst(await this.#transport.listSessions())
          session = sessions.find((item) => item.threadId === threadId)
        }
        if (!session) throw new Error(`AG-UI Session not found: ${threadId}`)

        const content = await this.#transport.loadSession(threadId)
        if (generation !== this.#switchGeneration) {
          throw new Error(`Stale AG-UI Session switch ignored: ${threadId}`)
        }
        this.#retargetAgent(threadId, sessions)
        this.#setSnapshot({
          isLoading: false,
          sessions,
          activeThreadId: threadId,
        })
        return {
          messages: toThreadMessages(content),
          ...(content.state === undefined ? {} : { state: content.state }),
          ...(content.unstableResume === undefined
            ? {}
            : { unstable_resume: content.unstableResume }),
        }
      },
    }
  }

  #replaceSessions(sessions: readonly AgUiSessionMetadata[]) {
    const providerThreadIds = new Set(sessions.map(({ threadId }) => threadId))
    for (const threadId of providerThreadIds) {
      this.#createdSessions.delete(threadId)
    }
    const ordered = newestFirst([
      ...sessions,
      ...[...this.#createdSessions.values()].filter(
        ({ threadId }) => !providerThreadIds.has(threadId)
      ),
    ])
    const activeThreadId = this.#snapshot.activeThreadId
    if (
      sameSessions(ordered, this.#snapshot.sessions) &&
      this.#snapshot.isLoading === false
    ) {
      return
    }
    this.#setSnapshot({ isLoading: false, sessions: ordered, activeThreadId })
  }

  #addSession(session: AgUiSessionMetadata) {
    this.#createdSessions.set(session.threadId, session)
    this.#replaceSessions(this.#snapshot.sessions)
  }

  #retargetAgent(
    threadId: string | undefined,
    sessions: readonly AgUiSessionMetadata[]
  ) {
    if (!threadId) return
    this.#agent.threadId = threadId
    this.#agent.agentId = sessions.find(
      (session) => session.threadId === threadId
    )?.agentId
  }

  #setSnapshot(snapshot: BridgeSnapshot) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}
