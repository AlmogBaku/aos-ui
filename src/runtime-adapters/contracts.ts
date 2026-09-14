import type { AssistantRuntime, Toolkit } from "@assistant-ui/react"
import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import type { VoiceMediaController } from "@/components/assistant-ui/voice/voice-media"
import type { ArtifactMessage } from "@/artifacts/artifacts"
export type { RuntimeMode } from "@shared/runtime-modes"

export type AgentStatus =
  "idle" | "active" | "running" | "attention" | "unknown"

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
  /** Native roster activity, distinct from exact Session execution. */
  activity?: "active" | "idle" | "unknown"
  icon?: AgentIcon
  visibility?: AgentVisibility
  role?: "creator"
}

export type ReadyAgentSummary = AgentSummaryBase & { kind: "ready" }

export type AgentSummary = ReadyAgentSummary

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

/** Provider-filtered normal Agents; dedicated creator stays outside management. */
export type AgentCatalogEntry = {
  summary: ReadyAgentSummary
  visibility: AgentVisibility
  selectable: boolean
  editable: boolean
}

export type SessionStatus =
  "idle" | "running" | "waiting-for-input" | "failed" | "unknown"

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

export type WorkspaceAdapter = {
  /** All supported native identities, including hidden Agents and creators. */
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
  subscribeActivity?: (
    listener: (event: WorkspaceActivityEvent) => void,
    onError?: (error: Error) => void
  ) => () => void
}

export type RuntimeQuestionOption = {
  label: string
  /** Opaque provider value; absent options submit their rendered label. */
  value?: string
  description?: string
}

export type RuntimeQuestion = {
  /** Provider-stable item identity for batched interaction responses. */
  id?: string
  header: string
  prompt: string
  options: readonly RuntimeQuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export type RuntimeQuestionRequest = {
  kind: "question"
  requestId: string
  sessionId: string
  questions: readonly RuntimeQuestion[]
  /** Non-actionable native requests remain inspectable after expiry/recovery. */
  status?: "expired" | "recovered"
}

export type RuntimeQuestionResponse = {
  kind: "question"
  answers: string[][]
}

/** Snapshots are immutable and stable until subscribe signals a change. */
export type RuntimeInteractionAdapter = {
  respond(
    request: RuntimeQuestionRequest,
    response: RuntimeQuestionResponse
  ): Promise<void>
  reject(request: RuntimeQuestionRequest): Promise<void>
  dismiss?(request: RuntimeQuestionRequest): void
  getPending(threadId: string): RuntimeQuestionRequest | undefined
  subscribe(
    threadId: string,
    listener: () => void,
    onError?: (error: Error) => void
  ): () => void
}

export type ArtifactSource =
  | { type: "inline"; data: string; encoding: "utf8" | "base64" }
  | { type: "url"; url: string }
  | { type: "provider"; reference: string }

export type ArtifactDescriptor = {
  id: string
  filename: string
  mimeType?: string
  sizeBytes?: number
  source: ArtifactSource
}

export type ArtifactResolveOptions = {
  artifact: ArtifactDescriptor
  agentId: string
  threadId: string
  signal: AbortSignal
}

export type ArtifactAdapter = {
  resolve(input: ArtifactResolveOptions): Promise<Blob>
}

/** The complete provider-neutral browser interface consumed by the workspace. */
export type HarnessRuntime = {
  assistantRuntime: AssistantRuntime
  workspace: WorkspaceAdapter
  /** The selected thread runtime carries standard AG-UI interrupt state. */
  agUiInterrupts?: true
  interactions?: RuntimeInteractionAdapter
  artifacts?: {
    resolver: ArtifactAdapter
    projectMessages?: (
      messages: readonly ArtifactMessage[]
    ) => readonly ArtifactMessage[]
    htmlAssetOrigins?: readonly string[]
  }
  composer?: ComposerFeatureViewModel
  /** Omit for ordinary local branches; false hides durable Edit and Retry. */
  messageRewind?:
    | false
    | {
        runConfig(sourceUserId: string): {
          custom: Record<string, unknown>
        }
      }
  media?: VoiceMediaController
  assistantConfig?: { instructions?: string; toolkit?: Toolkit }
  activityCoverage: "workspace" | "active-session"
  environmentLabel?: string
}

export type WorkspaceCapabilities = {
  agentCatalog: boolean
  agentVisibilityUpdates: boolean
  agentUpdates: boolean
  todos: boolean
  agentCreation: boolean
  activityEvents: boolean
}

export type WorkspaceProviderEvent<TPayload = unknown> = {
  agentId: string
  threadId: string
  sequence: number
  payload: TPayload
}
