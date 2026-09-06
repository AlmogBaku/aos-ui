import type {
  AgentBuilderCreationOptions,
  AgentLifecycleEvent,
  AgentSummary,
  AgentCatalogEntry,
  AgentVisibility,
  SessionCreationOptions,
  SessionMetadata,
  TodoItem,
  WorkspaceActivityEvent,
  WorkspaceAdapter,
} from "../contracts"
import {
  AGENT_BUILDER_KICKOFF,
  AGENT_DRAFT_DESCRIPTION,
  AGENT_DRAFT_TITLE,
  AGENT_FIRST_SESSION_TITLE,
  draftAgentId,
  draftIcon,
} from "../opencode/agent-draft"
import {
  buildFixtureActivityScenario,
  type FixtureActivityScenarioName,
} from "./fixture-activity"

export const FIXTURE_NOW = new Date("2026-09-03T12:00:00.000Z")

export type FixtureClock = () => Date

export const fixtureAgents: AgentSummary[] = [
  {
    kind: "ready",
    id: "agent-aster",
    name: "Aster",
    description: "General analysis and synthesis",
    status: "running",
    icon: { kind: "symbol", symbol: "spark", tone: "indigo" },
  },
  {
    kind: "ready",
    id: "agent-mica",
    name: "Mica",
    description: "Long-form synthesis",
    status: "idle",
    icon: { kind: "symbol", symbol: "layers", tone: "purple" },
  },
  {
    kind: "ready",
    id: "agent-lumen",
    name: "Lumen",
    description: "Planning and review",
    status: "attention",
    icon: { kind: "symbol", symbol: "compass", tone: "teal" },
  },
  {
    kind: "ready",
    id: "agent-vela",
    name: "Vela",
    description: "Data interpretation",
    status: "idle",
    icon: { kind: "symbol", symbol: "chart", tone: "ochre" },
  },
  {
    kind: "ready",
    id: "agent-nori",
    name: "Nori",
    description: "Writing and editing",
    status: "idle",
    icon: { kind: "symbol", symbol: "pen", tone: "slate" },
  },
]

export const fixtureSessionTitles = new Map<string, string>([
  ["thread-aster-market", "Market brief"],
  ["thread-aster-launch", "Launch review"],
  ["thread-aster-scan", "Competitive scan"],
  ["thread-aster-pricing", "Pricing analysis"],
  ["thread-aster-interviews", "Customer interviews"],
  ["thread-mica-quarterly", "Quarterly synthesis"],
  ["thread-lumen-roadmap", "Roadmap review"],
  ["thread-vela-metrics", "Activation metrics"],
  ["thread-nori-copy", "Launch copy"],
])

export const fixtureSessions: SessionMetadata[] = [
  {
    threadId: "thread-aster-market",
    agentId: "agent-aster",
    updatedAt: "2026-09-03T11:00:00.000Z",
    status: "running",
  },
  {
    threadId: "thread-aster-launch",
    agentId: "agent-aster",
    updatedAt: "2026-09-03T07:00:00.000Z",
    status: "idle",
  },
  {
    threadId: "thread-aster-scan",
    agentId: "agent-aster",
    updatedAt: "2026-09-03T01:00:00.000Z",
    status: "idle",
  },
  {
    threadId: "thread-aster-pricing",
    agentId: "agent-aster",
    updatedAt: "2026-09-03T00:00:00.000Z",
    status: "idle",
  },
  {
    threadId: "thread-aster-interviews",
    agentId: "agent-aster",
    updatedAt: "2026-09-02T10:00:00.000Z",
    status: "idle",
  },
  {
    threadId: "thread-mica-quarterly",
    agentId: "agent-mica",
    updatedAt: "2026-09-03T10:00:00.000Z",
    status: "idle",
  },
  {
    threadId: "thread-lumen-roadmap",
    agentId: "agent-lumen",
    updatedAt: "2026-08-30T12:00:00.000Z",
    status: "waiting-for-input",
  },
  {
    threadId: "thread-vela-metrics",
    agentId: "agent-vela",
    updatedAt: "2026-08-28T12:00:00.000Z",
    status: "idle",
  },
  {
    threadId: "thread-nori-copy",
    agentId: "agent-nori",
    updatedAt: "2026-08-27T12:00:00.000Z",
    status: "failed",
  },
]

const fixtureTodos = new Map<string, TodoItem[]>([
  [
    "thread-aster-market",
    [
      {
        id: "todo-scope",
        label: "Define scope and coverage",
        status: "completed",
      },
      { id: "todo-trends", label: "Aggregate spend trends", status: "active" },
      { id: "todo-segments", label: "Segment the market", status: "pending" },
      { id: "todo-drivers", label: "Identify key drivers", status: "pending" },
      { id: "todo-summary", label: "Summarize takeaways", status: "pending" },
    ],
  ],
])

type FixtureWorkspaceOptions = {
  clock?: FixtureClock
  activityIdFactory?: () => string
}

type ActivitySubscription = {
  listener: (event: WorkspaceActivityEvent) => void
  onError?: (error: Error) => void
}

type FixtureRunActivity = {
  agentId: string
  threadId: string
  lifecycleId: string
}

export class FixtureWorkspace implements WorkspaceAdapter {
  readonly #clock: FixtureClock
  readonly #activityIdFactory: () => string
  readonly #agents: AgentSummary[] = [
    ...structuredClone(fixtureAgents),
    {
      kind: "ready",
      id: "agent-sable",
      name: "Sable",
      description: "Research and discovery",
      status: "idle",
      icon: { kind: "symbol", symbol: "compass", tone: "slate" },
    },
  ]
  readonly #hiddenAgents = new Set(["agent-sable"])
  readonly #sessions = structuredClone(fixtureSessions)
  readonly #todos = new Map(
    [...fixtureTodos].map(([threadId, todos]) => [
      threadId,
      structuredClone(todos),
    ])
  )
  readonly #todoListeners = new Map<string, Set<(todos: TodoItem[]) => void>>()
  readonly #agentCatalogListeners = new Set<() => void>()
  readonly #lifecycleListeners = new Set<(event: AgentLifecycleEvent) => void>()
  readonly #activityListeners = new Set<ActivitySubscription>()
  readonly #sessionTitles = new Map(fixtureSessionTitles)
  readonly #builderKickoffs = new Map<string, string>()
  readonly #retryPromotions = new Map<
    string,
    Extract<AgentSummary, { kind: "ready" }>
  >()
  readonly #draftFirstSessionTitles = new Map<string, string>()
  #sessionSequence = 0
  #draftSequence = 0

  constructor({
    clock = () => new Date(),
    activityIdFactory = () => globalThis.crypto.randomUUID(),
  }: FixtureWorkspaceOptions = {}) {
    this.#clock = clock
    this.#activityIdFactory = activityIdFactory
  }

  async listAgents() {
    return structuredClone(
      this.#agents.filter((agent) => !this.#hiddenAgents.has(agent.id))
    )
  }

  async listAgentCatalog(): Promise<AgentCatalogEntry[]> {
    return this.#agents.flatMap((summary) =>
      summary.kind === "ready"
        ? [
            {
              summary: structuredClone(summary),
              visibility: this.#hiddenAgents.has(summary.id)
                ? "hidden"
                : "visible",
              selectable: !this.#hiddenAgents.has(summary.id),
              editable: true,
            },
          ]
        : []
    )
  }

  async updateAgentVisibility(agentId: string, visibility: AgentVisibility) {
    if (
      !this.#agents.some(
        (agent) => agent.id === agentId && agent.kind === "ready"
      )
    )
      throw new Error("Agent visibility cannot be changed")
    if (visibility === "hidden") this.#hiddenAgents.add(agentId)
    else if (visibility === "visible") this.#hiddenAgents.delete(agentId)
    else throw new Error("Invalid Agent visibility")
    this.#publishCatalog()
  }

  async refreshAgents() {
    return this.listAgents()
  }

  async getSessionMetadata(threadIds: string[]) {
    const requested = new Set(threadIds)
    return structuredClone(
      this.#sessions.filter(({ threadId }) => requested.has(threadId))
    )
  }

  async createSession(agentId: string, options?: SessionCreationOptions) {
    const agent = this.#agents.find(({ id }) => id === agentId)
    if (!agent) {
      throw new Error(`Unknown Agent: ${agentId}`)
    }
    if (agent.kind !== "ready") {
      throw new Error(`Agent is not ready: ${agentId}`)
    }

    this.#sessionSequence += 1
    const threadId = `fixture-session-${String(this.#sessionSequence).padStart(3, "0")}`
    this.#sessions.push({
      threadId,
      agentId,
      status: "idle",
      updatedAt: this.#clock().toISOString(),
    })
    this.#sessionTitles.set(
      threadId,
      options?.title ?? AGENT_FIRST_SESSION_TITLE
    )
    return { threadId }
  }

  listAllSessionMetadata() {
    return structuredClone(this.#sessions)
  }

  getSessionTitle(threadId: string) {
    return this.#sessionTitles.get(threadId)
  }

  setSessionTitle(threadId: string, title: string) {
    if (!this.#sessions.some((session) => session.threadId === threadId)) {
      throw new Error(`Session not found: ${threadId}`)
    }
    this.#sessionTitles.set(threadId, title)
  }

  subscribeTodos(threadId: string, listener: (todos: TodoItem[]) => void) {
    const listeners = this.#todoListeners.get(threadId) ?? new Set()
    listeners.add(listener)
    this.#todoListeners.set(threadId, listeners)
    listener(structuredClone(this.#todos.get(threadId) ?? []))

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#todoListeners.delete(threadId)
    }
  }

  emitTodos(threadId: string, todos: TodoItem[]) {
    this.#todos.set(threadId, structuredClone(todos))
    for (const listener of this.#todoListeners.get(threadId) ?? []) {
      listener(structuredClone(todos))
    }
  }

  async openAgentBuilder(options?: AgentBuilderCreationOptions) {
    this.#draftSequence += 1
    const suffix = String(this.#draftSequence).padStart(3, "0")
    const threadId = `fixture-agent-draft-${suffix}`
    const provisionalId = draftAgentId(threadId)
    this.#agents.push({
      kind: "provisional",
      id: provisionalId,
      name: options?.draftTitle ?? AGENT_DRAFT_TITLE,
      description: options?.draftDescription ?? AGENT_DRAFT_DESCRIPTION,
      status: "idle",
      icon: draftIcon(threadId),
      builderThreadId: threadId,
      phase: "interview",
    })
    this.#sessions.push({
      threadId,
      agentId: provisionalId,
      status: "waiting-for-input",
      updatedAt: this.#clock().toISOString(),
    })
    this.#sessionTitles.set(threadId, options?.draftTitle ?? AGENT_DRAFT_TITLE)
    this.#draftFirstSessionTitles.set(
      provisionalId,
      options?.firstSessionTitle ?? AGENT_FIRST_SESSION_TITLE
    )
    this.#builderKickoffs.set(threadId, AGENT_BUILDER_KICKOFF)
    this.#publishCatalog()
    this.#publishLifecycle({
      type: "draft-created",
      draftAgentId: provisionalId,
      threadId,
      revision: 1,
    })
    return { threadId, draftAgentId: provisionalId }
  }

  getBuilderKickoff(threadId: string) {
    return this.#builderKickoffs.get(threadId)
  }

  subscribeAgentLifecycle(listener: (event: AgentLifecycleEvent) => void) {
    this.#lifecycleListeners.add(listener)
    return () => this.#lifecycleListeners.delete(listener)
  }

  subscribeActivity(
    listener: (event: WorkspaceActivityEvent) => void,
    onError?: (error: Error) => void
  ) {
    const entry = { listener, ...(onError ? { onError } : {}) }
    this.#activityListeners.add(entry)
    return () => this.#activityListeners.delete(entry)
  }

  publishActivityScenario(name: FixtureActivityScenarioName) {
    for (const event of buildFixtureActivityScenario(name)) {
      this.#publishActivity(event)
    }
  }

  beginRunActivity(
    threadId: string,
    providerRunId?: string
  ): FixtureRunActivity | undefined {
    const session = this.#sessions.find((item) => item.threadId === threadId)
    if (!session) return undefined
    const runId = providerRunId || this.#activityIdFactory()
    const lifecycleId = `fixture:runtime:${encodeURIComponent(threadId)}:${encodeURIComponent(runId)}`
    const activity = { agentId: session.agentId, threadId, lifecycleId }
    this.#publishActivity({
      id: `${lifecycleId}:started`,
      ...activity,
      occurredAt: this.#clock().toISOString(),
      type: "run-started",
    })
    return activity
  }

  createAttentionRequestId(
    threadId: string,
    kind: "question" | "permission",
    providerRunId?: string
  ) {
    const requestId = providerRunId || this.#activityIdFactory()
    return `fixture:${kind}:${encodeURIComponent(threadId)}:${encodeURIComponent(requestId)}`
  }

  finishRunActivity(
    activity: FixtureRunActivity | undefined,
    result: "finished" | "failed"
  ) {
    if (!activity) return
    this.#publishActivity({
      id: `${activity.lifecycleId}:${result}`,
      ...activity,
      occurredAt: this.#clock().toISOString(),
      type: result === "finished" ? "run-finished" : "run-failed",
    })
  }

  publishAttention(
    threadId: string,
    kind: "question" | "permission" | "resolved",
    requestId: string
  ) {
    const session = this.#sessions.find((item) => item.threadId === threadId)
    if (!session) return
    const eventBase = {
      id: `fixture:runtime:${encodeURIComponent(threadId)}:attention:${encodeURIComponent(requestId)}:${kind === "resolved" ? "resolved" : "requested"}`,
      agentId: session.agentId,
      threadId,
      occurredAt: this.#clock().toISOString(),
    }
    this.#publishActivity(
      kind === "resolved"
        ? {
            ...eventBase,
            type: "attention-resolved",
            requestId,
          }
        : {
            ...eventBase,
            type: "attention-requested",
            attentionKind: kind,
            requestId,
          }
    )
  }

  async deleteAgentDraft(provisionalId: string) {
    const agentIndex = this.#agents.findIndex(
      (agent) => agent.id === provisionalId && agent.kind === "provisional"
    )
    if (agentIndex < 0)
      throw new Error(`Agent draft not found: ${provisionalId}`)
    const draft = this.#agents[agentIndex]!
    if (
      draft.kind !== "provisional" ||
      (draft.phase !== "interview" && draft.phase !== "start-failed")
    ) {
      throw new Error("This Agent draft can no longer be deleted")
    }
    this.#agents.splice(agentIndex, 1)
    const sessionIndex = this.#sessions.findIndex(
      ({ threadId }) => threadId === draft.builderThreadId
    )
    if (sessionIndex >= 0) this.#sessions.splice(sessionIndex, 1)
    this.#sessionTitles.delete(draft.builderThreadId)
    this.#builderKickoffs.delete(draft.builderThreadId)
    this.#retryPromotions.delete(provisionalId)
    this.#draftFirstSessionTitles.delete(provisionalId)
    this.#publishCatalog()
    this.#publishLifecycle({
      type: "draft-deleted",
      draftAgentId: provisionalId,
      revision: 2,
    })
  }

  async retryAgentDraft(provisionalId: string) {
    const draft = this.#agents.find(
      (agent) => agent.id === provisionalId && agent.kind === "provisional"
    )
    if (!draft || draft.kind !== "provisional") {
      throw new Error(`Agent draft not found: ${provisionalId}`)
    }
    if (draft.phase !== "start-failed" && draft.phase !== "activation-failed") {
      return
    }
    const retryPromotion = this.#retryPromotions.get(provisionalId)
    if (retryPromotion) {
      this.promoteAgentDraft(provisionalId, retryPromotion)
      return
    }
    draft.phase = "interview"
    draft.status = "idle"
    delete draft.lastError
    this.#publishCatalog()
    this.#publishLifecycle({
      type: "draft-updated",
      draftAgentId: provisionalId,
      revision: 2,
    })
  }

  subscribeAgentCatalog(listener: () => void) {
    this.#agentCatalogListeners.add(listener)
    return () => this.#agentCatalogListeners.delete(listener)
  }

  promoteAgentDraft(
    provisionalId: string,
    agent: Extract<AgentSummary, { kind: "ready" }>
  ) {
    const draftIndex = this.#agents.findIndex(
      (item) => item.id === provisionalId && item.kind === "provisional"
    )
    if (draftIndex < 0)
      throw new Error(`Agent draft not found: ${provisionalId}`)
    const draft = this.#agents[draftIndex]!
    if (draft.kind !== "provisional") throw new Error("Invalid Agent draft")
    const threadId = `fixture-session-${agent.id}-001`
    this.#retryPromotions.delete(provisionalId)
    const firstSessionTitle =
      this.#draftFirstSessionTitles.get(provisionalId) ??
      AGENT_FIRST_SESSION_TITLE
    this.#draftFirstSessionTitles.delete(provisionalId)
    this.#agents.splice(draftIndex, 1, structuredClone(agent))
    this.#sessions.push({
      threadId,
      agentId: agent.id,
      status: "idle",
      updatedAt: this.#clock().toISOString(),
    })
    this.#sessionTitles.set(threadId, firstSessionTitle)
    this.#publishCatalog()
    this.#publishLifecycle({
      type: "draft-promoted",
      draftAgentId: provisionalId,
      agentId: agent.id,
      threadId,
      revision: 3,
    })
    return { threadId }
  }

  failAgentDraftActivation(
    provisionalId: string,
    message: string,
    retryAgent: Extract<AgentSummary, { kind: "ready" }>
  ) {
    const draft = this.#agents.find(
      (agent) => agent.id === provisionalId && agent.kind === "provisional"
    )
    if (!draft || draft.kind !== "provisional") {
      throw new Error(`Agent draft not found: ${provisionalId}`)
    }
    draft.phase = "activation-failed"
    draft.status = "idle"
    draft.lastError = message
    const builderSession = this.#sessions.find(
      ({ threadId }) => threadId === draft.builderThreadId
    )
    if (builderSession) builderSession.status = "failed"
    this.#retryPromotions.set(provisionalId, structuredClone(retryAgent))
    this.#publishCatalog()
    this.#publishLifecycle({
      type: "draft-updated",
      draftAgentId: provisionalId,
      revision: 2,
    })
  }

  #publishCatalog() {
    for (const listener of this.#agentCatalogListeners) listener()
  }

  #publishLifecycle(event: AgentLifecycleEvent) {
    for (const listener of this.#lifecycleListeners) {
      listener(structuredClone(event))
    }
    if (event.type === "draft-promoted") {
      this.#publishActivity({
        id: `fixture:agent-ready:${encodeURIComponent(event.draftAgentId)}:${event.revision}`,
        agentId: event.agentId,
        threadId: event.threadId,
        occurredAt: this.#clock().toISOString(),
        type: "agent-ready",
      })
      return
    }
    if (event.type !== "draft-updated") return
    const draft = this.#agents.find(
      (agent) =>
        agent.id === event.draftAgentId &&
        agent.kind === "provisional" &&
        agent.phase === "activation-failed"
    )
    if (!draft || draft.kind !== "provisional") return
    this.#publishActivity({
      id: `fixture:agent-activation-failed:${encodeURIComponent(event.draftAgentId)}:${event.revision}`,
      agentId: event.draftAgentId,
      threadId: draft.builderThreadId,
      occurredAt: this.#clock().toISOString(),
      type: "agent-activation-failed",
    })
  }

  #publishActivity(event: WorkspaceActivityEvent) {
    for (const entry of this.#activityListeners) {
      try {
        entry.listener(structuredClone(event))
      } catch (reason) {
        try {
          entry.onError?.(
            reason instanceof Error ? reason : new Error(String(reason))
          )
        } catch {
          // Fixture observers are isolated like real provider observers.
        }
      }
    }
  }
}

declare global {
  interface Window {
    __AOS_UI_FIXTURE_WORKSPACE__?: FixtureWorkspace
  }
}

export function createFixtureWorkspace(options?: FixtureWorkspaceOptions) {
  return new FixtureWorkspace(options)
}
