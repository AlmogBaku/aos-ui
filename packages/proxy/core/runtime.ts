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
import type {
  CallToolResult,
  McpAppView,
  ReadResourceResult,
} from "../../protocol/mcp-apps"

export type SessionScope = {
  agentId: string
  /** Provider-resolved Session identity; never supplied by the browser. */
  sessionId: string
  /** Opaque public Session identity supplied by the browser. */
  threadId: string
  /** Command routing is limited to plain text-only submissions. */
  hasAttachments?: boolean
}

/** Exactly one Session field a write changes, as the wire request carries it. */
export type SessionPatch =
  | { title: string }
  | { archived: boolean }
  | { pinned: boolean }
  | { unread: boolean }

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
   * Reconstructs provider-authoritative execution state after process loss, or
   * adopts a turn the runtime started by itself. A repeated call refreshes an
   * existing waiting execution; `undefined` authoritatively clears that
   * recovered wait. A turn this adapter admitted, including one still settling,
   * is never discovered: the coordinator already owns it.
   */
  discover?(
    scope: SessionScope,
    turnId: string
  ): Promise<
    | {
        handle: ServerTurnHandle
        state: "running" | "waiting-for-input"
        requests?: PendingRequest[]
        /** The handle's events begin at the native turn's first event. */
        fromStart?: boolean
      }
    | undefined
  >
  /**
   * Watches one Session for turns this adapter did not start: a subagent
   * result, a loop tick, a heartbeat, cron, or another native client. Rules:
   * - `onTurn` fires when such a turn starts, and whenever the watch
   *   (re)subscribes, at setup or after a reconnect or rebind, while one is
   *   running;
   * - it stays silent for the adapter's own turns; a foreign turn that starts
   *   during one is found by the `discover` that follows every turn's end;
   * - it fires at most once per native turn, however often the runtime
   *   announces it;
   * - setup may be asynchronous: the adapter owns reconnect retries and reports
   *   failures through `onError`, never by throwing.
   * The returned stop function may be called more than once and ends retries.
   */
  watch?(scope: SessionScope, watcher: ServerTurnWatcher): () => void
}

export type ServerTurnWatcher = {
  onTurn(): void
  onError(cause: unknown): void
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
  updateSession(
    agentId: string,
    runtimeSessionId: string,
    patch: SessionPatch
  ): Promise<void>
  deleteSession(agentId: string, runtimeSessionId: string): Promise<void>
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
  /**
   * MCP Apps hosting. Absent when the runtime cannot resolve a tool's UI
   * resource; every call is keyed by the tool call that opened the view, so
   * the browser never names a server, tool, or resource URI to open one.
   */
  mcpApps?: ServerMcpApps
}

/** A tool call of a running turn, before the runtime has stored it. */
export type LiveMcpToolCall = {
  toolCallId: string
  toolName: string
  input?: Record<string, unknown>
  result?: CallToolResult
}

/** MCP Apps operations, each scoped to one Session's tool call. */
export type ServerMcpApps = {
  /**
   * Hears a flagged call of this Session's own run as it streams, so a host
   * that reads calls from stored history opens the view before the turn is
   * stored. A host that holds its views natively leaves it out.
   */
  observe?(scope: SessionScope, call: LiveMcpToolCall): void
  /** Whether the call's tool declares a view (`_meta.ui.resourceUri`). */
  describe(
    scope: SessionScope,
    call: { toolCallId: string; toolName: string; result?: unknown }
  ): Promise<boolean>
  open(
    scope: SessionScope,
    toolCallId: string,
    signal?: AbortSignal
  ): Promise<McpAppView>
  /** A view's `tools/call`, limited to its own server's app-visible tools. */
  callTool(
    scope: SessionScope,
    toolCallId: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult>
  /** A view's `resources/read` on its own server. */
  readResource(
    scope: SessionScope,
    toolCallId: string,
    uri: string
  ): Promise<ReadResourceResult>
}
