import type {
  AgentCatalogEntry,
  SessionMetadata,
  TodoItem,
  TodoStatus,
  WorkspaceAdapter,
} from "../contracts"
import type { HermesNativeClient } from "./hermes-native-client"

function sessionMetadata(
  client: HermesNativeClient,
  requested: ReadonlySet<string>
): SessionMetadata[] {
  return client
    .getSnapshot()
    .sessions.filter(({ threadId }) => requested.has(threadId))
    .map(({ threadId, agentId, updatedAt, status }) => ({
      threadId,
      agentId,
      updatedAt,
      status,
    }))
}

function sessionTodos(
  client: HermesNativeClient,
  threadId: string
): TodoItem[] {
  const session = client.session(threadId)
  const todo = session?.messages
    .flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content
        : []
    )
    .findLast(
      (part) =>
        part.type === "tool-call" &&
        ["todo", "todos", "todo_write"].includes(part.toolName) &&
        part.result !== undefined
    )
  const value = todo?.type === "tool-call" ? todo.result : undefined
  const rows =
    value &&
    typeof value === "object" &&
    Array.isArray((value as { todos?: unknown }).todos)
      ? (value as { todos: unknown[] }).todos
      : []
  return rows.flatMap((row, index) => {
    if (!row || typeof row !== "object") return []
    const item = row as Record<string, unknown>
    const label = String(item.label ?? item.content ?? "").trim()
    if (!label) return []
    const rawStatus = String(item.status ?? "pending")
    const status: TodoStatus = [
      "pending",
      "active",
      "completed",
      "failed",
    ].includes(rawStatus)
      ? (rawStatus as TodoStatus)
      : "pending"
    return [{ id: String(item.id ?? index), label, status }]
  })
}

/** Provider projection only; Hermes owns identities, visibility, and Sessions. */
export function createHermesWorkspace(
  client: HermesNativeClient
): WorkspaceAdapter {
  const agents = async () => {
    await client.start()
    return [...client.getSnapshot().agents]
  }

  return {
    listAgents: agents,
    async refreshAgents() {
      await client.start()
      await client.refreshCatalog()
      return [...client.getSnapshot().agents]
    },
    async listAgentCatalog(): Promise<AgentCatalogEntry[]> {
      return (await agents())
        .filter(({ role }) => role !== "creator")
        .map((summary) => ({
          summary,
          visibility: summary.visibility ?? "visible",
          selectable: summary.visibility !== "hidden",
          editable: true,
        }))
    },
    async updateAgentVisibility(agentId, visibility) {
      await client.start()
      await client.updateProfileVisibility(agentId, visibility)
    },
    async getSessionMetadata(threadIds) {
      await client.start()
      const requested = new Set(threadIds)
      return sessionMetadata(client, requested)
    },
    async createSession(agentId, options) {
      await client.start()
      const session = await client.createSession(
        agentId,
        options?.title ?? "New Session"
      )
      return { threadId: session.threadId }
    },
    subscribeAgentCatalog(listener, onError) {
      return client.subscribeCatalog(listener, onError)
    },
    subscribeSessionMetadata(threadIds, listener, onError) {
      const requested = new Set(threadIds)
      let signature: string | undefined
      const publish = () => {
        const next = sessionMetadata(client, requested)
        const nextSignature = JSON.stringify(next)
        if (signature === nextSignature) return
        signature = nextSignature
        listener(next)
      }
      const unsubscribe = client.subscribe(publish)
      try {
        publish()
      } catch (reason) {
        onError?.(reason instanceof Error ? reason : new Error(String(reason)))
      }
      return unsubscribe
    },
    subscribeTodos(threadId, listener) {
      let signature: string | undefined
      const publish = () => {
        const next = sessionTodos(client, threadId)
        const nextSignature = JSON.stringify(next)
        if (signature === nextSignature) return
        signature = nextSignature
        listener(next)
      }
      publish()
      return client.subscribe(publish)
    },
    subscribeActivity(listener, onError) {
      return client.subscribeActivity(listener, onError)
    },
  }
}
