import { createBrowserId } from "@/lib/browser-id"

import { createRuntimeClock } from "@shared/runtime-modes"
import type {
  AgentSummary,
  AgentCatalogEntry,
  AgentUpdate,
  SessionCreationOptions,
  SessionMetadata,
  TodoItem,
  WorkspaceActivityEvent,
  WorkspaceAdapter,
} from "../contracts"
import {
  buildFixtureActivityScenario,
  type FixtureActivityScenarioName,
} from "./fixture-activity"

export const FIXTURE_NOW = createRuntimeClock("fixture").now

export type FixtureClock = () => Date

export const fixtureAgents: AgentSummary[] = [
  {
    kind: "ready",
    id: "agent-aster",
    name: "Aster",
    description: "Executive assistant",
    status: "running",
    avatar: "ring/blue",
  },
  {
    kind: "ready",
    id: "agent-mica",
    name: "Mica",
    description: "Accounting and finance",
    status: "idle",
    avatar: "chamfer-crop/amber",
  },
  {
    kind: "ready",
    id: "agent-lumen",
    name: "Lumen",
    description: "Product strategy",
    status: "attention",
    avatar: "hexagon/green",
  },
  {
    kind: "ready",
    id: "agent-vela",
    name: "Vela",
    description: "Marketing analysis",
    status: "idle",
    avatar: "arch/violet",
  },
  {
    kind: "ready",
    id: "agent-nori",
    name: "Nori",
    description: "Ghostwriting and editing",
    status: "idle",
    avatar: "disc/rose",
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
  ["thread-vela-retrospective", "Campaign retrospective"],
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
    unread: true,
  },
  {
    threadId: "thread-vela-metrics",
    agentId: "agent-vela",
    updatedAt: "2026-08-28T12:00:00.000Z",
    status: "idle",
    pinned: true,
  },
  {
    threadId: "thread-nori-copy",
    agentId: "agent-nori",
    updatedAt: "2026-08-27T12:00:00.000Z",
    status: "failed",
    unread: true,
  },
  {
    threadId: "thread-vela-retrospective",
    agentId: "agent-vela",
    updatedAt: "2026-08-20T12:00:00.000Z",
    status: "idle",
    archived: true,
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
      {
        id: "todo-trends",
        label: "Aggregate spend trends",
        status: "completed",
      },
      {
        id: "todo-segments",
        label: "Segment the market",
        status: "completed",
      },
      { id: "todo-drivers", label: "Identify key drivers", status: "active" },
      { id: "todo-summary", label: "Summarize takeaways", status: "pending" },
    ],
  ],
])

export type FixtureWorkspaceOptions = {
  clock?: FixtureClock
  activityIdFactory?: () => string
  enableAgentCreator?: boolean
  /** Test-only seeds let UI tests describe ownership without demo identities. */
  agents?: readonly AgentSummary[]
  hiddenAgentIds?: readonly string[]
  sessions?: readonly SessionMetadata[]
  todos?: Readonly<Record<string, readonly TodoItem[]>>
  sessionTitles?: Readonly<Record<string, string>>
}

type ActivitySubscription = {
  listener: (event: WorkspaceActivityEvent) => void
  onError?: (error: Error) => void
}

type FixtureTurnActivity = {
  agentId: string
  threadId: string
  turnId: string
}

export class FixtureWorkspace implements WorkspaceAdapter {
  /** Test fixtures derive creator identity from the same catalog as the UI. */
  get agentCreator() {
    return this.#agents.find((agent) => agent.role === "creator")
  }

  readonly #clock: FixtureClock
  readonly #activityIdFactory: () => string
  readonly #agents: AgentSummary[]
  readonly #hiddenAgents: Set<string>
  readonly #sessions: SessionMetadata[]
  readonly #todos: Map<string, TodoItem[]>
  readonly #todoListeners = new Map<string, Set<(todos: TodoItem[]) => void>>()
  readonly #agentCatalogListeners = new Set<() => void>()

  readonly #activityListeners = new Set<ActivitySubscription>()
  readonly #sessionMetadataListeners = new Set<{
    threadIds: ReadonlySet<string>
    listener: (metadata: SessionMetadata[]) => void
  }>()
  readonly #sessionTitles: Map<string, string>
  #sessionSequence = 0

  constructor({
    clock = () => new Date(),
    activityIdFactory = createBrowserId,
    enableAgentCreator = true,
    agents,
    hiddenAgentIds,
    sessions,
    todos,
    sessionTitles,
  }: FixtureWorkspaceOptions = {}) {
    this.#clock = clock
    this.#activityIdFactory = activityIdFactory
    this.#agents = structuredClone([
      ...(agents ?? [
        ...fixtureAgents,
        {
          kind: "ready" as const,
          id: "agent-sable",
          name: "Sable",
          description: "Research and discovery",
          status: "idle" as const,
        },
      ]),
    ])
    this.#hiddenAgents = new Set(
      hiddenAgentIds ??
        (agents
          ? this.#agents
              .filter((agent) => agent.visibility === "hidden")
              .map((agent) => agent.id)
          : ["agent-sable"])
    )
    this.#sessions = structuredClone([...(sessions ?? fixtureSessions)])
    this.#todos = new Map(
      Object.entries(todos ?? Object.fromEntries(fixtureTodos)).map(
        ([threadId, items]) => [threadId, structuredClone([...items])]
      )
    )
    this.#sessionTitles = new Map(
      Object.entries(sessionTitles ?? Object.fromEntries(fixtureSessionTitles))
    )
    if (
      enableAgentCreator &&
      !this.#agents.some((agent) => agent.role === "creator")
    )
      this.#agents.push({
        kind: "ready",
        id: "agent-builder",
        name: "Agent Creator",
        visibility: "hidden",
        role: "creator",
        description: "Create a native Agent",
      })
  }

  async listAgents() {
    return structuredClone(
      this.#agents.map((agent) => ({
        ...agent,
        visibility: this.#hiddenAgents.has(agent.id)
          ? ("hidden" as const)
          : (agent.visibility ?? ("visible" as const)),
      }))
    )
  }

  async listAgentCatalog(): Promise<AgentCatalogEntry[]> {
    return this.#agents.flatMap((summary) =>
      summary.kind === "ready" && summary.role !== "creator"
        ? [
            {
              summary: structuredClone(summary),
              visibility: this.#hiddenAgents.has(summary.id)
                ? "hidden"
                : "visible",
              selectable: !this.#hiddenAgents.has(summary.id),
              editable: true,
              avatarEditable: true,
            },
          ]
        : []
    )
  }

  async updateAgent(agentId: string, { visibility, avatar }: AgentUpdate) {
    if (agentId === this.agentCreator?.id)
      throw new Error("The creator is managed by the provider")
    const agent = this.#agents.find(
      (agent) => agent.id === agentId && agent.kind === "ready"
    )
    if (!agent) throw new Error("Agent cannot be changed")
    if (visibility === "hidden") this.#hiddenAgents.add(agentId)
    else if (visibility === "visible") this.#hiddenAgents.delete(agentId)
    else if (visibility !== undefined)
      throw new Error("Invalid Agent visibility")
    if (avatar === null) delete agent.avatar
    else if (avatar !== undefined) agent.avatar = avatar
    this.#publishCatalog()
  }

  async refreshAgents() {
    return this.listAgents()
  }

  async getSessionMetadata(threadIds: string[]) {
    return this.#projectSessions(new Set(threadIds))
  }

  subscribeSessionMetadata(
    threadIds: readonly string[],
    listener: (metadata: SessionMetadata[]) => void
  ) {
    const entry = { threadIds: new Set(threadIds), listener }
    this.#sessionMetadataListeners.add(entry)
    return () => this.#sessionMetadataListeners.delete(entry)
  }

  async markSessionRead(threadId: string) {
    const session = this.#sessions.find((item) => item.threadId === threadId)
    if (!session || session.unread === false) return
    session.unread = false
    this.#publishSessions()
  }

  async setSessionPinned(threadId: string, pinned: boolean) {
    const session = this.#requireSession(threadId)
    if (session.pinned === pinned) return
    session.pinned = pinned
    this.#publishSessions()
  }

  setSessionArchived(threadId: string, archived: boolean) {
    const session = this.#requireSession(threadId)
    if (session.archived === archived) return
    session.archived = archived
    this.#publishSessions()
  }

  /** Assistant UI drops the deleted thread itself, so nothing republishes. */
  deleteSession(threadId: string) {
    const session = this.#requireSession(threadId)
    this.#sessions.splice(this.#sessions.indexOf(session), 1)
    this.#sessionTitles.delete(threadId)
  }

  /** The preview performs every Session action the workspace offers. */
  async sessionActionCapabilities() {
    return { rename: true, archive: true, delete: true, pin: true }
  }

  /** Native runtimes debounce exposure; the preview has no read-state clock. */
  reportFocus() {}

  async createSession(agentId: string, options?: SessionCreationOptions) {
    const agent =
      agentId === this.agentCreator?.id
        ? this.agentCreator
        : this.#agents.find(({ id }) => id === agentId)
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
      unread: false,
    })
    this.#sessionTitles.set(threadId, options?.title ?? "New session")
    return { threadId }
  }

  listAllSessionMetadata() {
    return structuredClone(this.#sessions)
  }

  getSessionTitle(threadId: string) {
    return this.#sessionTitles.get(threadId)
  }

  setSessionTitle(threadId: string, title: string) {
    this.#requireSession(threadId)
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
    providerTurnId?: string
  ): FixtureTurnActivity | undefined {
    const session = this.#sessions.find((item) => item.threadId === threadId)
    if (!session) return undefined
    const turnKey = providerTurnId || this.#activityIdFactory()
    const turnId = `fixture:runtime:${encodeURIComponent(threadId)}:${encodeURIComponent(turnKey)}`
    const activity = { agentId: session.agentId, threadId, turnId }
    this.#publishActivity({
      id: `${turnId}:started`,
      ...activity,
      occurredAt: this.#clock().toISOString(),
      type: "turn-started",
    })
    return activity
  }

  createAttentionRequestId(
    threadId: string,
    kind: "question" | "permission",
    providerTurnId?: string
  ) {
    const requestId = providerTurnId || this.#activityIdFactory()
    return `fixture:${kind}:${encodeURIComponent(threadId)}:${encodeURIComponent(requestId)}`
  }

  finishRunActivity(
    activity: FixtureTurnActivity | undefined,
    result: "finished" | "failed"
  ) {
    if (!activity) return
    this.#publishActivity({
      id: `${activity.turnId}:${result}`,
      ...activity,
      occurredAt: this.#clock().toISOString(),
      type: result === "finished" ? "turn-finished" : "turn-failed",
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

  subscribeAgentCatalog(listener: () => void) {
    this.#agentCatalogListeners.add(listener)
    return () => this.#agentCatalogListeners.delete(listener)
  }

  completeAgentCreation(creatorThreadId: string, agent: AgentSummary) {
    this.#addCreatedAgent(creatorThreadId, agent)
    this.#publishCatalog()
    this.#publishCreatedAgent(creatorThreadId, agent.id, "agent-ready")
  }

  /** A created Agent the provider cannot activate without an operator. */
  failAgentSetup(creatorThreadId: string, agentId: string, name = agentId) {
    this.#addCreatedAgent(creatorThreadId, {
      kind: "ready",
      id: agentId,
      name,
      visibility: "hidden",
    })
    this.#hiddenAgents.add(agentId)
    this.#publishCatalog()
    this.#publishCreatedAgent(
      creatorThreadId,
      agentId,
      "agent-activation-failed"
    )
  }

  #addCreatedAgent(creatorThreadId: string, agent: AgentSummary) {
    const creatorSession = this.#sessions.find(
      ({ threadId }) => threadId === creatorThreadId
    )
    if (!this.agentCreator || creatorSession?.agentId !== this.agentCreator.id)
      throw new Error("Only creator Sessions can create Agents")
    if (
      this.#agents.some(({ id }) => id === agent.id) ||
      agent.id === this.agentCreator.id
    )
      throw new Error("Agent already exists")
    this.#agents.push(structuredClone(agent))
  }

  /** A created Agent, as the browser store reports one the catalog lists. */
  #publishCreatedAgent(
    creatorThreadId: string,
    agentId: string,
    type: "agent-ready" | "agent-activation-failed"
  ) {
    this.#publishActivity({
      id: `fixture:creator:${encodeURIComponent(creatorThreadId)}:${encodeURIComponent(agentId)}:${type}`,
      agentId,
      threadId: creatorThreadId,
      occurredAt: this.#clock().toISOString(),
      type,
    })
  }

  #projectSessions(requested: ReadonlySet<string>) {
    return structuredClone(
      this.#sessions.filter(({ threadId }) => requested.has(threadId))
    )
  }

  /** Every Session write names a Session the provider already has. */
  #requireSession(threadId: string) {
    const session = this.#sessions.find((item) => item.threadId === threadId)
    if (!session) throw new Error(`Session not found: ${threadId}`)
    return session
  }

  #publishSessions() {
    for (const entry of this.#sessionMetadataListeners)
      entry.listener(this.#projectSessions(entry.threadIds))
  }

  #publishCatalog() {
    for (const listener of this.#agentCatalogListeners) listener()
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
