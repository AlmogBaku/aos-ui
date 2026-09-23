import type { PendingRequest, TurnEvent, TurnInput } from "./events"
import type {
  AgentCatalogResponse,
  RuntimeAuthState,
  RuntimeInfo,
  Session,
  SessionCatalogResponse,
  SessionHistoryResponse,
  SessionAttachmentStageRequest,
  SessionAttachmentStageResponse,
  SessionModelUpdateRequest,
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

export type ServerTurnHandle = {
  events: AsyncIterable<TurnEvent>
  /** Resolves only when the provider segment is terminal. */
  settled: Promise<void>
  /** Idempotently requests Stop or rechecks an already-stopping native turn. */
  stop(): Promise<"stopping" | "idle">
  steer?(
    request: Readonly<{ requestId: string; text: string }>
  ): Promise<"steered" | "queued">
  /**
   * Where this segment stopped reading the provider stream, or `undefined` when
   * it has no comparable position: recovery then starts without one instead of
   * naming an epoch no provider can match.
   */
  recoveryPosition(): { epoch: string; lastSeen: number } | undefined
}

export type RecoveryRequest = {
  threadId: string
  turnId: string
  position?: { epoch: string; lastSeen: number }
}

export type ServerTurnEngine = {
  start(
    scope: SessionScope,
    input: TurnInput,
    /** One-shot server-owned content staged for this native admission. */
    attachments?: ServerAttachmentStage
  ): Promise<ServerTurnHandle>
  /**
   * Reattaches to a turn this process already admitted. The returned handle must
   * speak for that turn: it either publishes at least one event or ends its
   * stream. Coordination of an uncertain turn waits on that signal, so a handle
   * that attaches silently and stays silent leaves the turn unanswered.
   */
  recover(
    scope: SessionScope,
    request: RecoveryRequest
  ): Promise<ServerTurnHandle>
  /**
   * Reconstructs provider-authoritative execution state after process loss.
   * A repeated call refreshes an existing waiting execution; `undefined`
   * authoritatively clears that recovered wait.
   */
  discover?(
    scope: SessionScope,
    turnId: string
  ): Promise<
    | {
        handle: ServerTurnHandle
        state: "running" | "waiting-for-input"
        requests?: PendingRequest[]
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

export class ServerTurnConflictError extends Error {
  constructor() {
    super("An AOS turn is already active for this Session")
    this.name = "ServerTurnConflictError"
  }
}

export class ServerTurnCapacityError extends Error {
  constructor(readonly lane: "global" | "guest" = "global") {
    super("AOS execution capacity exceeded")
    this.name = "ServerTurnCapacityError"
  }
}

export class ServerTurnControlError extends Error {
  constructor() {
    super("Turn control is not authorized")
    this.name = "ServerTurnControlError"
  }
}

export class ServerTurnSteerUnavailableError extends Error {
  constructor() {
    super("Active-turn steering is unavailable")
    this.name = "ServerTurnSteerUnavailableError"
  }
}

export class ServerTurnSteerUncertainError extends Error {
  constructor() {
    super("The steering request may have been accepted")
    this.name = "ServerTurnSteerUncertainError"
  }
}

/** Signals that Stop failed before native dispatch and may be attempted again. */
export class ServerTurnStopNotDispatchedError extends Error {
  constructor(readonly failure: unknown) {
    super("Stop was not dispatched")
    this.name = "ServerTurnStopNotDispatchedError"
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
  readonly turns: ServerTurnEngine
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
  /**
   * Updates the model, its reasoning effort, or both in one write. A provider
   * may resolve the request to a different model, so the response carries the
   * Session's model state the write actually settled on.
   */
  updateModel(
    agentId: string,
    publicSessionId: string,
    patch: SessionModelUpdateRequest
  ): Promise<unknown>
  context(agentId: string, publicSessionId: string): Promise<unknown>
  subscribeSessionInvalidation(
    agentId: string,
    publicSessionId: string,
    listener: () => void,
    reset?: () => void
  ): Promise<() => void>
  /**
   * Payload-less wake when the provider's Session catalog changed (Hermes
   * `sessions.changed`). Absent when the provider has no such signal.
   */
  subscribeCatalogChanges?(listener: () => void): Promise<() => void>
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
