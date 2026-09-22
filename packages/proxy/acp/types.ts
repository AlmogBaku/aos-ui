import type {
  AgentApp,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import type { z } from "zod"

import type {
  SessionHistoryResponse,
  SessionModelsResponse,
  SessionWorkspaceCapabilitiesResponseSchema,
} from "../../protocol"
import type {
  AosActivityNotification,
  AosArtifactDescriptor,
} from "../../protocol/acp"
import type {
  ExecutionEvent,
  PendingRequest,
  RequestReply,
  RunEvent,
} from "../core/events"
import type {
  RuntimeInstance,
  ServerAttachmentStages,
  SessionScope,
} from "../core/runtime"
import type { CoordinatorAccess } from "../core/session-coordinator"
import type { SessionRows } from "../core/session-rows"
import type { PresenceRegistry } from "../push/presence"

export type Lane = "operator" | "guest"

/**
 * Where the ACP lanes write their structured lines, in the shape the proxy
 * composition already receives. Every value passes through `redactForLog`
 * first. A context built without one logs nothing, which is what a harness
 * asserting only protocol behavior wants.
 */
export type AcpLogger = {
  info(value: unknown): void
  error(value: unknown): void
}

export type WorkspaceCapabilities = z.infer<
  typeof SessionWorkspaceCapabilitiesResponseSchema
>

/** What the proxy knows about one accepted WebSocket connection. */
export type AcpConnectionContext = {
  connectionId: string
  principalId: string
  lane: Lane
  runtimeInstance: RuntimeInstance
  sessionRows: SessionRows
  readState: ReadState
  activityFeed: ActivityFeed
  translators: Translators
  /** Server-staged attachment batches, shared with the REST upload route. */
  attachmentStages: ServerAttachmentStages
  /** Present only on the guest lane; absent means an operator connection. */
  guest?: GuestPolicy
  /**
   * Where this connection reports the workspace it shows, shared across the
   * principal's connections. Absent means nothing observes presence, which is
   * every guest connection and any deployment without push.
   */
  presence?: PresenceRegistry
  logger?: AcpLogger
}

/**
 * One redeemed invitation, shaped after the claims `GuestInvitationService`
 * verifies: the single Agent and conversation reference it grants, the
 * controller identity the coordinator knows this guest by, and the moment the
 * connection must close.
 */
export type GuestGrant = {
  agentId: string
  ref: string
  principalId: string
  /** Unix milliseconds; the connection closes when it passes. */
  expiresAt: number
  /** Non-secret setup text the runtime receives once, on creation. */
  firstTurnInstruction?: string
}

/**
 * The guest lane's per-connection authorization and projection, implemented in
 * `guest/acp.ts`. Every projection fails closed before an invitation is
 * redeemed.
 */
export type GuestPolicy = {
  /** Redeems one invitation token; `undefined` means it is not usable. */
  authenticate(token: string): Promise<GuestGrant | undefined>
  grant(): GuestGrant | undefined
  project: {
    /** Wraps one coordinator subscription in the guest run projection. */
    access(
      base: CoordinatorAccess,
      scope: SessionScope,
      runId: string
    ): CoordinatorAccess
    history(value: SessionHistoryResponse): SessionHistoryResponse
    capabilities(value: WorkspaceCapabilities): WorkspaceCapabilities
    /** Refuses an approval answer that would widen the grant past this request. */
    permissionReply(request: PendingRequest, reply: RequestReply): RequestReply
  }
  /** Schedules the close the invitation's expiry owes, returning its canceller. */
  expire(close: () => void): () => void
}

/** Builds the per-connection ACP v2 agent app. Implemented in `agent.ts`. */
export type AosAcpAgentFactory = (context: AcpConnectionContext) => AgentApp

/** Inputs every run-event translation needs besides the event itself. */
export type TranslateContext = {
  runId: string
  sequence: number
  lane: Lane
  /** Stop was acknowledged for this run and the provider has not settled. */
  stopping: boolean
  /** The clock a state update stamps itself with; the system clock by default. */
  now?: () => number
}

/**
 * State the run-event reducer carries between events of one run segment:
 * the assistant message currently streaming and the arguments text streamed
 * so far per open tool call. Starts as `initialTranslateState`.
 */
export type TranslateState = {
  messageId: string | undefined
  toolArgsText: Readonly<Record<string, string>>
  /**
   * Acknowledgements a from-start replay drops because authoritative history
   * already carried those corrections.
   */
  replayedCorrections: number
}
export const initialTranslateState: TranslateState = {
  messageId: undefined,
  toolArgsText: {},
  replayedCorrections: 0,
}

/**
 * One thing to send after translating a run event. Session-scoped updates and
 * notifications omit `sessionId`; the attachment adds it when sending.
 */
export type AcpOutbound =
  | { kind: "update"; update: SessionUpdate }
  | {
      kind: "artifact"
      runId: string
      messageId?: string
      artifact: AosArtifactDescriptor
    }
  | {
      kind: "steer-accepted"
      runId: string
      requestId: string
      text: string
      delivery: "steered" | "queued"
    }
  | { kind: "composer-prefill"; runId: string; text: string }
  | {
      kind: "request-permission"
      interruptId: string
      request: WithoutSession<RequestPermissionRequest>
    }
  | {
      kind: "elicitation"
      interruptId: string
      request: WithoutSession<CreateElicitationRequest>
    }

/** `Omit` that distributes over a union so mode-specific fields stay typed. */
type WithoutSession<T> = T extends unknown ? Omit<T, "sessionId"> : never

/**
 * Per-connection read-state service. The browser reports exposure through
 * `_aos/session/focus`; this service arms the watermark, re-acks activity in
 * the focused Session with a floor and debounce, and swallows failures.
 * Implemented in `read-state.ts`.
 */
export interface ReadState {
  focus(agentId: string, sessionId: string): void
  blur(): void
  onExecution(event: ExecutionEvent): void
  markRead(agentId: string, sessionId: string): Promise<void>
  close(): void
}

/**
 * Per-connection, bounded, in-memory activity feed hydrated from coordinator
 * snapshots and the session list. Implemented in `activity-feed.ts`.
 */
export interface ActivityFeed {
  snapshot(): readonly AosActivityNotification[]
  subscribe(listener: (event: AosActivityNotification) => void): () => void
  close(): void
}

// ---------------------------------------------------------------------------
// Translator signatures shared by `translate/*` (implementers) and `agent.ts`
// (consumer). Each translator module exports a function that `satisfies` one
// of these types under the name given in the comment.
// ---------------------------------------------------------------------------

/** `translate/run-events.ts` → `translateRunEvent` (pure reducer) */
export type TranslateRunEvent = (
  state: TranslateState,
  event: RunEvent,
  context: TranslateContext
) => { state: TranslateState; outbound: AcpOutbound[] }

/**
 * `translate/history.ts` → `translateHistory`. A replay sends the same outbound
 * kinds a run segment does, so a stored artifact reaches the browser through
 * `_aos/artifact` exactly as the live one did.
 */
export type TranslateHistory = (
  history: SessionHistoryResponse,
  lane: Lane
) => AcpOutbound[]

/**
 * `translate/history.ts` → `persistedCorrections`. How many of the run journal's
 * steer acknowledgements the replayed history already carried as user turns.
 */
export type PersistedCorrections = (history: SessionHistoryResponse) => number

/** `translate/interrupts.ts` → `pendingRequestToOutbound` */
export type PendingRequestToOutbound = (
  request: PendingRequest,
  lane: Lane
) => Extract<AcpOutbound, { kind: "request-permission" | "elicitation" }>

/** `translate/interrupts.ts` → `replyFromPermission` */
export type ReplyFromPermission = (
  request: PendingRequest,
  response: RequestPermissionResponse
) => RequestReply

/** `translate/interrupts.ts` → `replyFromElicitation` */
export type ReplyFromElicitation = (
  request: PendingRequest,
  response: CreateElicitationResponse,
  lane: Lane
) => RequestReply

/** `config-options.ts` → `configOptionsOf` */
export type ConfigOptionsOf = (
  models: SessionModelsResponse
) => SessionConfigOption[]

/** `config-options.ts` → `configWriteOf`; `undefined` means unknown configId. */
export type ConfigWriteOf = (
  configId: string,
  value: unknown
) => { selectedId: string } | { effortId: string } | undefined

/** All translators, injected into the agent so lanes and tests stay decoupled. */
export type Translators = {
  translateRunEvent: TranslateRunEvent
  translateHistory: TranslateHistory
  persistedCorrections: PersistedCorrections
  pendingRequestToOutbound: PendingRequestToOutbound
  replyFromPermission: ReplyFromPermission
  replyFromElicitation: ReplyFromElicitation
  configOptionsOf: ConfigOptionsOf
  configWriteOf: ConfigWriteOf
}
