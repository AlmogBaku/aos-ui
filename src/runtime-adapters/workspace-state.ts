import type {
  PlanArtifact,
  AgentSummary,
  TodoItem,
  WorkspaceAdapter,
  WorkspaceCapabilities,
  WorkspaceProviderEvent,
} from "./contracts"

export function getWorkspaceCapabilities(
  workspace: WorkspaceAdapter,
  agents: readonly AgentSummary[] = []
): WorkspaceCapabilities {
  return {
    agentCatalog: typeof workspace.listAgentCatalog === "function",
    agentVisibilityUpdates:
      typeof workspace.updateAgentVisibility === "function",
    agentUpdates: typeof workspace.updateAgent === "function",
    todos: typeof workspace.subscribeTodos === "function",
    agentCreation:
      agents.filter((agent) => agent.role === "creator").length === 1,
    activityEvents: typeof workspace.subscribeActivity === "function",
    sessionReadState: typeof workspace.markSessionRead === "function",
  }
}

export class WorkspaceArtifactStore {
  readonly #plansByMessage = new Map<string, PlanArtifact>()
  readonly #todosByThread = new Map<string, TodoItem[]>()

  setPlan(messageId: string, plan: PlanArtifact) {
    this.#plansByMessage.set(messageId, structuredClone(plan))
  }

  getPlan(messageId: string) {
    const plan = this.#plansByMessage.get(messageId)
    return plan ? structuredClone(plan) : undefined
  }

  setTodos(threadId: string, todos: TodoItem[]) {
    this.#todosByThread.set(threadId, structuredClone(todos))
  }

  getTodos(threadId: string) {
    return structuredClone(this.#todosByThread.get(threadId) ?? [])
  }
}

type Selection = { agentId: string; threadId: string }

export class WorkspaceEventCache<TPayload = unknown> {
  #selection: Selection | null = null
  readonly #eventsByOrigin = new Map<
    string,
    WorkspaceProviderEvent<TPayload>[]
  >()
  readonly #lastSequenceByOrigin = new Map<string, number>()

  select(selection: Selection) {
    this.#selection = selection
  }

  apply(event: WorkspaceProviderEvent<TPayload>) {
    const key = this.#key(event.agentId, event.threadId)
    const lastSequence = this.#lastSequenceByOrigin.get(key) ?? -1
    if (event.sequence <= lastSequence) return false

    const events = this.#eventsByOrigin.get(key) ?? []
    events.push(structuredClone(event))
    this.#eventsByOrigin.set(key, events)
    this.#lastSequenceByOrigin.set(key, event.sequence)
    return true
  }

  eventsFor(agentId: string, threadId: string) {
    const key = this.#key(agentId, threadId)
    return (this.#eventsByOrigin.get(key) ?? []).map((event) =>
      structuredClone(event)
    )
  }

  visibleEvents() {
    if (!this.#selection) return []
    const key = this.#key(this.#selection.agentId, this.#selection.threadId)
    return (this.#eventsByOrigin.get(key) ?? []).map((event) =>
      structuredClone(event)
    )
  }

  #key(agentId: string, threadId: string) {
    return `${agentId}\u0000${threadId}`
  }
}
