import type { AGUIEvent, ResumeEntry } from "@ag-ui/core"
import type {
  AgentCatalogResponse,
  RuntimeAuthState,
  RuntimeInfo,
  Session,
  SessionCatalogResponse,
  SessionCommandsResponse,
  SessionHistoryResponse,
  SessionInteractionSnapshotResponse,
  SessionAttachmentStageRequest,
  SessionAttachmentStageResponse,
  VisibilityUpdateResponse,
} from "../protocol"

export type ServerRunScope = {
  agentId: string
  /** Provider-resolved Session identity; never supplied by the browser. */
  sessionId: string
  /** Opaque public Session identity supplied by the browser. */
  threadId: string
  /** Command routing is limited to plain text-only submissions. */
  hasAttachments?: boolean
}

export type ServerRunHandle = {
  events: AsyncIterable<AGUIEvent>
  stop(): Promise<"stopping" | "idle">
  disconnect(): void
  recoveryPosition(): { epoch: string; lastSeen: number }
}

export type ServerReconnectRequest = {
  threadId: string
  runId: string
  position?: { epoch: string; lastSeen: number }
}

export type ServerRunEngine = {
  start(scope: ServerRunScope, input: unknown): Promise<ServerRunHandle>
  reconnect(
    scope: ServerRunScope,
    request: ServerReconnectRequest
  ): Promise<ServerRunHandle>
}

export class ServerRunConflictError extends Error {
  constructor() {
    super("An AOS run is already active for this Session")
    this.name = "ServerRunConflictError"
  }
}

export class ServerSessionNotFoundError extends Error {
  constructor() {
    super("Session not found")
    this.name = "ServerSessionNotFoundError"
  }
}

export type ServerAttachmentStage = {
  public: Readonly<SessionAttachmentStageResponse["attachments"]>
  appendTo(text: string): string
  cleanup(): Promise<void>
}

export type ServerAttachmentStages = {
  create(
    agentId: string,
    sessionId: string,
    stage: ServerAttachmentStage
  ): string | undefined
  take(
    agentId: string,
    sessionId: string,
    stageId: string
  ): ServerAttachmentStage | undefined
}

export type ServerRuntimePublicError = {
  code:
    | "runtime_authentication_required"
    | "invalid_request"
    | "not_found"
    | "revision_conflict"
    | "temporarily_unavailable"
  status: 400 | 401 | 404 | 409 | 503
}

/** Provider-neutral operations consumed by normalized HTTP and event routes. */
export interface ServerRuntime {
  readonly runs: ServerRunEngine
  resolveSessionId(agentId: string, publicSessionId: string): string | undefined
  publicError(cause: unknown): ServerRuntimePublicError | undefined
  authState(): Promise<RuntimeAuthState>
  runtimeInfo(): Promise<RuntimeInfo>
  listAgents(): Promise<AgentCatalogResponse>
  updateAgentVisibility(
    agentId: string,
    visibility: "visible" | "hidden",
    observedRevision: string
  ): Promise<VisibilityUpdateResponse>
  listAllSessions(
    limit: number,
    offset: number
  ): Promise<SessionCatalogResponse>
  listSessions(
    agentId: string,
    limit: number,
    offset: number
  ): Promise<SessionCatalogResponse>
  history(
    agentId: string,
    runtimeSessionId: string,
    limit: number,
    offset: number
  ): Promise<SessionHistoryResponse>
  getSession(agentId: string, runtimeSessionId: string): Promise<Session>
  createSession(agentId: string, title?: string): Promise<unknown>
  mutateSession(
    agentId: string,
    runtimeSessionId: string,
    method: "PATCH" | "DELETE",
    body?: unknown
  ): Promise<void>
  workspaceCapabilities(): unknown
  slashCommands(
    agentId: string,
    publicSessionId: string
  ): Promise<SessionCommandsResponse>
  models(agentId: string, publicSessionId: string): Promise<unknown>
  selectModel(
    agentId: string,
    publicSessionId: string,
    selectedId: string
  ): Promise<unknown>
  context(agentId: string, publicSessionId: string): Promise<unknown>
  todos(agentId: string, publicSessionId: string): Promise<unknown>
  activity(agentId: string, publicSessionId: string): Promise<unknown>
  pendingInteractions(
    agentId: string,
    publicSessionId: string,
    requestedRunId?: string
  ): Promise<SessionInteractionSnapshotResponse>
  respondInteraction(
    scope: ServerRunScope & { runId: string },
    response: ResumeEntry
  ): Promise<{ status: string }>
  stageAttachments(
    agentId: string,
    publicSessionId: string,
    attachments: SessionAttachmentStageRequest["attachments"]
  ): Promise<ServerAttachmentStage>
  artifact(
    agentId: string,
    publicSessionId: string,
    artifactId: string
  ): Promise<{ bytes: Uint8Array; mimeType?: string; filename: string }>
  audio(agentId: string, publicSessionId: string): Promise<unknown>
  transcribe(
    agentId: string,
    publicSessionId: string,
    bytes: Uint8Array,
    mimeType: string,
    signal?: AbortSignal
  ): Promise<string>
  speak(
    agentId: string,
    publicSessionId: string,
    text: string,
    signal?: AbortSignal
  ): Promise<{ bytes: Uint8Array; mimeType: string }>
  resume(scope: ServerRunScope): Promise<{ liveSessionId: string }>
  observe(
    liveSessionId: string,
    listener: (event: unknown) => void,
    disconnected?: (error?: Error) => void
  ): Promise<() => void>
}
