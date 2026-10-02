import type {
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import type { z } from "zod"

import type { AgentCatalogResponseSchema } from "@aos/protocol"
import type {
  AosAgentUpdateRequest,
  AosAgentUpdateResponseSchema,
  AosHistoryCursor,
  AosInitializeMetaSchema,
  AosPromptMetaSchema,
  AosSessionListMetaSchema,
  AosSessionSearchMetaSchema,
  AosSessionNewMetaSchema,
  AosSessionUpdateRequestSchema,
  AosSteerRequestSchema,
  AosSteerResponseSchema,
} from "@aos/protocol/acp"

/**
 * The browser-side seam over one ACP v2 WebSocket connection to the proxy.
 * `connection.ts` implements it; the runtime, thread list, interactions, and
 * workspace client consume it and are tested against a fake.
 */

/** `capacity` is a reconnect the proxy asked to wait out, being full. */
export type AcpConnectionStatus =
  "connecting" | "ready" | "reconnecting" | "capacity" | "closed"

/** Why the connection is recovering, as `AcpConnectionStatus` names it. */
export type AcpConnectionOutage = "reconnecting" | "capacity"

/** A server→client request awaiting the operator's answer. */
export type AcpPendingRequest =
  | {
      kind: "permission"
      sessionId: string
      request: RequestPermissionRequest
      respond(response: RequestPermissionResponse): void
      /** Aborts when the proxy withdraws the request, which needs no answer. */
      signal: AbortSignal
    }
  | {
      kind: "elicitation"
      sessionId: string | undefined
      request: CreateElicitationRequest
      respond(response: CreateElicitationResponse): void
      signal: AbortSignal
    }

export type AcpSessionUpdateListener = (
  update: SessionUpdate,
  meta: Record<string, unknown> | undefined
) => void

/** One older page of a Session, read without resuming it again. */
export type AcpHistoryPage = {
  /** The page's updates in arrival order, each with its `_meta.aos`. */
  readonly updates: readonly {
    readonly update: SessionUpdate
    readonly meta: Record<string, unknown> | undefined
  }[]
  /** Where the page before this one starts, or that none can be read. */
  readonly history: AosHistoryCursor
}

/**
 * Told a from-start replay is starting; may return its settle callback, told
 * whether the replay completed.
 */
export type AcpSessionReplayListener = () =>
  ((replayed: boolean) => void) | void

/**
 * Where one opened Session stands: `joining` until the proxy has joined it,
 * `joined` while it follows the Session, `unavailable` while a failed join
 * waits out its backoff or one the transport refuses waits for the next, and
 * `gone` once the provider no longer has it.
 */
export type AcpSessionState = "joining" | "joined" | "unavailable" | "gone"

/** One consumer of an opened Session; it takes only the parts it names. */
export type AcpSessionListener = {
  /** The owning Agent, when known before any list, e.g. from a deep link. */
  agentId?: string
  /** `session/update` notifications for the Session, with `_meta.aos`. */
  update?: AcpSessionUpdateListener
  /**
   * Fires just before a from-start replay is requested, so whoever projects
   * the Session can drop the transcript that replay is about to resend. It
   * may return a callback, called once that replay has settled either way.
   */
  replay?: AcpSessionReplayListener
  state?: (state: AcpSessionState) => void
}

export interface AcpConnection {
  readonly status: AcpConnectionStatus
  /**
   * Opens the transport. Creating a connection performs no I/O, so a render
   * React discards leaks no socket; an effect owns the transport's lifetime.
   * Calling it again while the connection lives, or after `close`, does
   * nothing: reconnection belongs to the connection alone.
   */
  start(): void
  /** Resolves with `InitializeResponse._meta.aos` once the handshake settles. */
  readonly initialized: Promise<z.infer<typeof AosInitializeMetaSchema>>
  subscribeStatus(listener: (status: AcpConnectionStatus) => void): () => void
  /** Set from a close until every resumed Session has rejoined. */
  readonly outage: AcpConnectionOutage | undefined
  subscribeOutage(
    listener: (outage: AcpConnectionOutage | undefined) => void
  ): () => void

  /**
   * Redeems a guest invitation. The connection keeps the token and replays the
   * login before it rejoins its Sessions on a recovered transport.
   */
  login(token: string): Promise<void>

  /**
   * The new Session's row, capabilities and config options follow as updates.
   * The browser holds the shared address, so it names the Agent.
   */
  newSession(
    meta: z.infer<typeof AosSessionNewMetaSchema> & { agentId: string }
  ): Promise<{ sessionId: string }>
  listSessions(
    meta: z.infer<typeof AosSessionListMetaSchema>,
    cursor?: string
  ): Promise<{ sessions: SessionInfo[]; nextCursor?: string }>
  /** Search sessions at the provider. Returns matching SessionInfo entries. */
  searchSessions(
    meta: z.infer<typeof AosSessionSearchMetaSchema>
  ): Promise<{ sessions: SessionInfo[] }>
  /**
   * Opens the Session while any listener subscribes. The connection joins it,
   * replaying it from the start the first time, rejoins it from its own
   * position after a reconnect, and retries a refused join on backoff. It
   * parts, with `_aos/session/part`, 2 s after the last listener leaves, so a
   * listener back within that grace costs neither a part nor a resume. A
   * listener that subscribes before anything of a from-start replay under way
   * has arrived takes part in that replay.
   */
  subscribe(sessionId: string, listener: AcpSessionListener): () => void
  /** Resolves once the opened Session is joined; rejects once it is gone or parts. */
  joined(sessionId: string): Promise<void>
  /**
   * Replays the opened Session from the start, after the join in flight, and
   * resolves once it is joined again. A from-start replay that nothing has
   * arrived for yet, under way or still owed, serves the call instead.
   */
  replay(sessionId: string): Promise<void>
  /** Where the opened Session stands; undefined for one no listener holds. */
  sessionState(sessionId: string): AcpSessionState | undefined
  /**
   * Reads the page before `cursor` of an opened Session, once it is joined.
   * Its updates come back here and never reach a listener or the rejoin
   * position, so a page cannot disturb the live turn.
   */
  resumePage(sessionId: string, cursor: string): Promise<AcpHistoryPage>
  /**
   * The history cursor the latest from-start replay of this opened Session
   * reported; a join that replays nothing leaves it as it was.
   */
  history(sessionId: string): AosHistoryCursor | undefined
  /** Prompts an opened Session once it is joined, as `setConfigOption` and `steer` write. */
  prompt(
    sessionId: string,
    blocks: ContentBlock[],
    meta: z.infer<typeof AosPromptMetaSchema>
  ): Promise<{ messageId: string }>
  cancel(sessionId: string): void
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<SessionConfigOption[]>
  deleteSession(sessionId: string): Promise<void>

  updateSession(
    request: z.infer<typeof AosSessionUpdateRequestSchema>
  ): Promise<void>
  steer(
    request: z.infer<typeof AosSteerRequestSchema>
  ): Promise<z.infer<typeof AosSteerResponseSchema>>
  /** The exposed Session plus this connection's presence, re-sent on reconnect. */
  focus(
    sessionId: string | null,
    presence: { foreground: boolean; idle: boolean }
  ): void
  listAgents(): Promise<z.infer<typeof AgentCatalogResponseSchema>>
  /** Unsupported and revision-conflict refusals reject as `AgentUpdateError`. */
  updateAgent(
    request: AosAgentUpdateRequest
  ): Promise<z.infer<typeof AosAgentUpdateResponseSchema>>

  /** Extension notifications by method name (`AOS_METHODS.notify.*`). */
  subscribeNotification(
    method: string,
    listener: (params: unknown) => void
  ): () => void
  subscribePendingRequests(
    listener: (request: AcpPendingRequest) => void
  ): () => void
  close(): void
}
