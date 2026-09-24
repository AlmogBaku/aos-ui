import type {
  AgentApp,
  AuthMethod,
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
import type { AosActivityNotification, AosExtensions } from "../../protocol/acp"
import type {
  ExecutionEvent,
  PendingRequest,
  RequestReply,
  TurnEvent,
} from "../core/events"
import type { RuntimeInstance, ServerAttachmentStages } from "../core/runtime"
import type { SessionRows } from "../core/session-rows"
import type { PresenceRegistry } from "../push/presence"
import type { Channel } from "../core/channel"
import type { Feed, Member } from "../core/member"

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
type AcpConnectionBase = {
  connectionId: string
  principalId: string
  runtimeInstance: RuntimeInstance
  sessionRows: SessionRows
  translators: Translators
  /** Server-staged attachment batches, shared with the REST upload route. */
  attachmentStages: ServerAttachmentStages
  /**
   * The one room registry per proxy process, shared by both lanes so an
   * operator and a guest on the same provider Session land in one room.
   */
  rooms: Channel
  /**
   * Where this connection reports the workspace it shows, shared across the
   * principal's connections. Absent means nothing observes presence, which is
   * every guest connection and any deployment without push.
   */
  presence?: PresenceRegistry
  logger?: AcpLogger
  /** The feeds this connection's member is given, chosen at join. */
  feeds: ReadonlySet<Feed>
}

/**
 * One connection's context, typed by its lane: only an operator reads the
 * activity feed and owns read state, since a guest learns nothing about the
 * rest of the Agent, and only a guest authenticates over ACP rather than at
 * its upgrade.
 */
export type AcpConnectionContext = AcpConnectionBase &
  (
    | {
        lane: "operator"
        activityFeed: ActivityFeed
        readState: ReadState
        authentication?: never
      }
    | {
        lane: "guest"
        authentication: ConnectionAuthentication
        activityFeed?: never
        readState?: never
      }
  )

/**
 * How a connection that authenticates over ACP proves who it acts as. It
 * reaches nothing, and learns nothing about the deployment, until a credential
 * yields its member; the connection closes when that credential lapses.
 */
export type ConnectionAuthentication = {
  /** What `initialize` offers to authenticate with. */
  authMethods: readonly AuthMethod[]
  /** The AOS extensions this connection is served. */
  extensions: AosExtensions
  /** Redeems one credential; `false` means it is not usable. */
  authenticate(token: string): Promise<boolean>
  /** Who the credential acts as, and its stack; absent before it is redeemed. */
  member(): Omit<Member, "connection"> | undefined
  /** Whether a redeemed credential still holds, before its close arrives. */
  live(): boolean
  /**
   * Whether a redeemed credential has lapsed: from then on no frame passes
   * either way, and the connection closes.
   */
  lapsed(): boolean
  /** Schedules the close the credential's lapse owes, returning its canceller. */
  expire(close: () => void): () => void
}

/** Builds the per-connection ACP v2 agent app. Implemented in `agent.ts`. */
export type AosAcpAgentFactory = (context: AcpConnectionContext) => AgentApp

/** Inputs every turn-event translation needs besides the event itself. */
export type TranslateContext = {
  turnId: string
  sequence: number
  /** Stop was acknowledged for this turn and the provider has not settled. */
  stopping: boolean
  /** The clock a state update stamps itself with; the system clock by default. */
  now?: () => number
}

/**
 * State the turn-event reducer carries between events of one turn segment:
 * the assistant message currently streaming, the arguments text streamed so
 * far per open tool call, the tool call each announced terminal belongs to,
 * and the tool call that spawned each subagent. Starts as
 * `initialTranslateState`.
 */
export type TranslateState = {
  messageId: string | undefined
  toolArgsText: Readonly<Record<string, string>>
  /** terminalId → toolCallId, for every terminal the segment announced. */
  terminals: Readonly<Record<string, string>>
  /** subagentId → the toolCallId that spawned it. */
  subagents: Readonly<Record<string, string>>
  /**
   * Acknowledgements a from-start replay drops because authoritative history
   * already carried those corrections.
   */
  replayedCorrections: number
}
export const initialTranslateState: TranslateState = {
  messageId: undefined,
  toolArgsText: {},
  terminals: {},
  subagents: {},
  replayedCorrections: 0,
}

/**
 * One thing to send after translating a turn event. Session-scoped updates and
 * notifications omit `sessionId`; the attachment adds it when sending.
 */
export type AcpOutbound =
  | { kind: "update"; update: SessionUpdate }
  | {
      kind: "steer-accepted"
      turnId: string
      requestId: string
      text: string
      delivery: "steered" | "queued"
    }
  | { kind: "composer-prefill"; turnId: string; text: string }
  /**
   * The Session now runs `modelId`. ACP restates the whole option set, which
   * only the attachment can read, so it sends the `config_option_update`.
   */
  | { kind: "model-changed"; modelId: string }
  | {
      kind: "request-permission"
      requestId: string
      request: WithoutSession<RequestPermissionRequest>
    }
  | {
      kind: "elicitation"
      requestId: string
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

/** `translate/turn-events.ts` → `translateTurnEvent` (pure reducer) */
export type TranslateTurnEvent = (
  state: TranslateState,
  event: TurnEvent,
  context: TranslateContext
) => { state: TranslateState; outbound: AcpOutbound[] }

/**
 * `translate/history.ts` → `translateHistory`. A replay sends the same outbound
 * kinds a run segment does, so a stored artifact reaches the browser as the
 * same `resource_link` chunk the live one did.
 */
export type TranslateHistory = (
  history: SessionHistoryResponse
) => AcpOutbound[]

/** `translate/requests.ts` → `pendingRequestToOutbound` */
export type PendingRequestToOutbound = (
  request: PendingRequest
) => Extract<AcpOutbound, { kind: "request-permission" | "elicitation" }>

/** `translate/requests.ts` → `replyFromPermission` */
export type ReplyFromPermission = (
  request: PendingRequest,
  response: RequestPermissionResponse
) => RequestReply

/** `translate/requests.ts` → `replyFromElicitation` */
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
  translateTurnEvent: TranslateTurnEvent
  translateHistory: TranslateHistory
  pendingRequestToOutbound: PendingRequestToOutbound
  replyFromPermission: ReplyFromPermission
  replyFromElicitation: ReplyFromElicitation
  configOptionsOf: ConfigOptionsOf
  configWriteOf: ConfigWriteOf
}
