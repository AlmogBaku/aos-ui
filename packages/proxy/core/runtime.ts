import type {
  AGUIEvent,
  Interrupt,
  ResumeEntry,
  RunAgentInput,
} from "@ag-ui/core"
import type {
  AgentCatalogResponse,
  RuntimeAuthState,
  RuntimeInfo,
  Session,
  SessionCatalogResponse,
  SessionHistoryResponse,
  SessionAttachmentStageRequest,
  SessionAttachmentStageResponse,
  VisibilityUpdateResponse,
} from "../../protocol"

export type SessionScope = {
  agentId: string
  /** Provider-resolved Session identity; never supplied by the browser. */
  sessionId: string
  /** Opaque public Session identity supplied by the browser. */
  threadId: string
  /** Command routing is limited to plain text-only submissions. */
  hasAttachments?: boolean
}

export type ServerRunScope = SessionScope

export type NewTurnRunInput = RunAgentInput & {
  resume?: undefined
  /** User turn to rewind before Edit or Retry; validated authoritatively. */
  rewindSourceId?: string
}
export type ResumeRunInput = RunAgentInput & {
  messages: []
  resume: ResumeEntry[]
}

export type ServerRunHandle = {
  events: AsyncIterable<AGUIEvent>
  /** Resolves only when the provider segment is terminal. */
  settled: Promise<void>
  /** Idempotently requests Stop or rechecks an already-stopping native run. */
  stop(): Promise<"stopping" | "idle">
  steer?(
    request: Readonly<{ requestId: string; text: string }>
  ): Promise<"steered" | "queued">
  recoveryPosition(): { epoch: string; lastSeen: number }
}

export type RecoveryRequest = {
  threadId: string
  runId: string
  position?: { epoch: string; lastSeen: number }
}

export type ServerReconnectRequest = RecoveryRequest

export type ServerRunEngine = {
  start(
    scope: SessionScope,
    input: NewTurnRunInput | ResumeRunInput,
    /** One-shot server-owned content staged for this native admission. */
    attachments?: ServerAttachmentStage
  ): Promise<ServerRunHandle>
  recover(
    scope: SessionScope,
    request: RecoveryRequest
  ): Promise<ServerRunHandle>
  /**
   * Reconstructs provider-authoritative execution state after process loss.
   * A repeated call refreshes an existing waiting execution; `undefined`
   * authoritatively clears that recovered wait.
   */
  discover?(
    scope: SessionScope,
    runId: string
  ): Promise<
    | {
        handle: ServerRunHandle
        state: "running" | "waiting-for-input"
        interrupts?: Interrupt[]
      }
    | undefined
  >
}

export type RuntimeInstance = {
  id: string
  runtime: ServerRuntime
  sessions: import("./session-coordinator").SessionCoordinator
  close(): Promise<void>
}

export class ServerRunConflictError extends Error {
  constructor() {
    super("An AOS run is already active for this Session")
    this.name = "ServerRunConflictError"
  }
}

export class ServerRunCapacityError extends Error {
  constructor(readonly lane: "global" | "guest" = "global") {
    super("AOS execution capacity exceeded")
    this.name = "ServerRunCapacityError"
  }
}

export class ServerRunControlError extends Error {
  constructor() {
    super("Run control is not authorized")
    this.name = "ServerRunControlError"
  }
}

export class ServerRunSteerUnavailableError extends Error {
  constructor() {
    super("Active-turn steering is unavailable")
    this.name = "ServerRunSteerUnavailableError"
  }
}

export class ServerRunSteerUncertainError extends Error {
  constructor() {
    super("The steering request may have been accepted")
    this.name = "ServerRunSteerUncertainError"
  }
}

/** Signals that Stop failed before native dispatch and may be attempted again. */
export class ServerRunStopNotDispatchedError extends Error {
  constructor(readonly failure: unknown) {
    super("Stop was not dispatched")
    this.name = "ServerRunStopNotDispatchedError"
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
  appendTo(text: string): string | Promise<string>
  cleanup(): Promise<void>
}

export type ServerAttachmentStages = {
  create(
    agentId: string,
    sessionId: string,
    stage: ServerAttachmentStage,
    sizeBytes?: number
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
    | "connection_interrupted"
    | "uncertain_mutation"
  status: 400 | 401 | 404 | 409 | 503
}

/** Provider-neutral operations consumed by normalized HTTP and event routes. */
export interface ServerRuntime {
  readonly runs: ServerRunEngine
  resolveInvitedSession(
    agentId: string,
    ref: string,
    create?: { firstTurnInstruction?: string }
  ): Promise<{ sessionId: string; created: boolean } | undefined>
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
  workspaceCapabilities(
    agentId: string,
    publicSessionId: string
  ): Promise<unknown>
  models(agentId: string, publicSessionId: string): Promise<unknown>
  selectModel(
    agentId: string,
    publicSessionId: string,
    selectedId: string
  ): Promise<unknown>
  context(agentId: string, publicSessionId: string): Promise<unknown>
  subscribeSessionInvalidation(
    agentId: string,
    publicSessionId: string,
    listener: () => void,
    reset?: () => void
  ): Promise<() => void>
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
  transcribe(
    agentId: string,
    bytes: Uint8Array,
    mimeType: string,
    signal?: AbortSignal
  ): Promise<string>
  speak(
    agentId: string,
    text: string,
    signal?: AbortSignal
  ): Promise<{ bytes: Uint8Array; mimeType: string }>
}
