import type { AssistantRuntime } from "@assistant-ui/react"

export type AgentStatus = "idle" | "running" | "attention"

export type AgentIconName =
  "spark" | "layers" | "compass" | "chart" | "pen" | "unassigned"

export type AgentIcon =
  | {
      kind: "symbol"
      symbol: AgentIconName
      tone: "indigo" | "purple" | "teal" | "ochre" | "slate"
    }
  | { kind: "image"; src: string; alt?: string }

type AgentSummaryBase = {
  id: string
  name: string
  description?: string
  status?: AgentStatus
  icon?: AgentIcon
}

export type ReadyAgentSummary = AgentSummaryBase & { kind: "ready" }

export type ProvisionalAgentPhase =
  "interview" | "start-failed" | "activating" | "activation-failed"

export type ProvisionalAgentSummary = AgentSummaryBase & {
  kind: "provisional"
  builderThreadId: string
  phase: ProvisionalAgentPhase
  lastError?: string
}

export type AgentSummary = ReadyAgentSummary | ProvisionalAgentSummary

export type AgentVisibility = "visible" | "hidden"

/** Actionable visibility outcomes; all other failures remain ordinary Errors. */
export class AgentVisibilityUpdateError extends Error {
  constructor(
    readonly code: "provider-active" | "pending-reload",
    message: string
  ) {
    super(message)
    this.name = "AgentVisibilityUpdateError"
  }
}

/** Provider-filtered normal Agents; Builder drafts remain in the roster only. */
export type AgentCatalogEntry = {
  summary: ReadyAgentSummary
  visibility: AgentVisibility
  selectable: boolean
  editable: boolean
}

export type AgentBuilderResult = {
  threadId: string
  draftAgentId: string
}

export type AgentLifecycleEvent =
  | {
      type: "draft-created"
      draftAgentId: string
      threadId: string
      revision: number
    }
  | { type: "draft-updated"; draftAgentId: string; revision: number }
  | {
      type: "draft-promoted"
      draftAgentId: string
      agentId: string
      threadId: string
      revision: number
    }
  | { type: "draft-deleted"; draftAgentId: string; revision: number }

export type SessionStatus = "idle" | "running" | "waiting-for-input" | "failed"

export type ActivityBase = {
  id: string
  agentId: string
  threadId: string
  occurredAt: string
}

export type WorkspaceActivityEvent =
  | (ActivityBase & { type: "run-started"; lifecycleId: string })
  | (ActivityBase & {
      type: "run-finished" | "run-failed"
      lifecycleId: string
    })
  | (ActivityBase & {
      type: "attention-requested"
      attentionKind: "question" | "permission"
      requestId: string
    })
  | (ActivityBase & { type: "attention-resolved"; requestId: string })
  | (ActivityBase & { type: "agent-ready" | "agent-activation-failed" })

export type SessionMetadata = {
  threadId: string
  agentId: string
  updatedAt: string
  status: SessionStatus
}

export type TodoStatus = "pending" | "active" | "completed" | "failed"

export type TodoItem = {
  id: string
  label: string
  status: TodoStatus
}

export type PlanStep = {
  id: string
  label: string
  status: TodoStatus
}

export type PlanArtifact = {
  id: string
  title: string
  steps: PlanStep[]
}

export type AgentPatch = Partial<Pick<AgentSummary, "name" | "description">>

export type SessionCreationOptions = {
  title: string
}

export type AgentBuilderCreationOptions = {
  draftTitle: string
  draftDescription: string
  firstSessionTitle: string
}

export type WorkspaceAdapter = {
  listAgents(): Promise<AgentSummary[]>
  refreshAgents(): Promise<AgentSummary[]>
  listAgentCatalog?: () => Promise<AgentCatalogEntry[]>
  updateAgentVisibility?: (
    agentId: string,
    visibility: AgentVisibility
  ) => Promise<void>
  getSessionMetadata(threadIds: string[]): Promise<SessionMetadata[]>
  createSession(
    agentId: string,
    options?: SessionCreationOptions
  ): Promise<{ threadId: string }>
  updateAgent?: (agentId: string, patch: AgentPatch) => Promise<void>
  subscribeTodos?: (
    threadId: string,
    listener: (todos: TodoItem[]) => void,
    onError?: (error: Error) => void
  ) => () => void
  subscribeAgentCatalog?: (
    listener: () => void,
    onError?: (error: Error) => void
  ) => () => void
  subscribeSessionMetadata?: (
    threadIds: readonly string[],
    listener: (metadata: SessionMetadata[]) => void,
    onError?: (error: Error) => void
  ) => () => void
  openAgentBuilder?: (
    options?: AgentBuilderCreationOptions
  ) => Promise<AgentBuilderResult>
  deleteAgentDraft?: (draftAgentId: string) => Promise<void>
  retryAgentDraft?: (draftAgentId: string) => Promise<void>
  subscribeAgentLifecycle?: (
    listener: (event: AgentLifecycleEvent) => void,
    onError?: (error: Error) => void
  ) => () => void
  subscribeActivity?: (
    listener: (event: WorkspaceActivityEvent) => void,
    onError?: (error: Error) => void
  ) => () => void
}

export type RuntimeBundle = {
  assistantRuntime: AssistantRuntime
  workspace: WorkspaceAdapter
}

export type RuntimeMode = "fixture" | "opencode" | "ag-ui"

export type WorkspaceCapabilities = {
  agentCatalog: boolean
  agentVisibilityUpdates: boolean
  agentUpdates: boolean
  todos: boolean
  builderChat: boolean
  agentDraftDeletion: boolean
  agentDraftRetry: boolean
  agentLifecycle: boolean
  activityEvents: boolean
}

export type WorkspaceProviderEvent<TPayload = unknown> = {
  agentId: string
  threadId: string
  sequence: number
  payload: TPayload
}
