import type {
  AgentApp,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"

import type {
  SessionHistoryResponse,
  SessionModelsResponse,
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
import type { RuntimeInstance } from "../core/runtime"
import type { SessionRows } from "../core/session-rows"

export type Lane = "operator" | "guest"

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
}

/**
 * State the run-event reducer carries between events of one run segment:
 * the assistant message currently streaming and the arguments text streamed
 * so far per open tool call. Starts as `initialTranslateState`.
 */
export type TranslateState = {
  messageId: string | undefined
  toolArgsText: Readonly<Record<string, string>>
}
export const initialTranslateState: TranslateState = {
  messageId: undefined,
  toolArgsText: {},
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

/** `translate/history.ts` → `translateHistory` */
export type TranslateHistory = (
  history: SessionHistoryResponse,
  lane: Lane
) => SessionUpdate[]

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
  response: CreateElicitationResponse
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
  pendingRequestToOutbound: PendingRequestToOutbound
  replyFromPermission: ReplyFromPermission
  replyFromElicitation: ReplyFromElicitation
  configOptionsOf: ConfigOptionsOf
  configWriteOf: ConfigWriteOf
}
