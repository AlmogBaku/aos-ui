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

import type {
  AgentCatalogResponseSchema,
  VisibilityUpdateResponseSchema,
} from "@aos/protocol"
import type {
  AosInitializeMetaSchema,
  AosPromptMetaSchema,
  AosSessionListMetaSchema,
  AosSessionNewMetaSchema,
  AosSessionNewResponseMetaSchema,
  AosSessionResumeResponseMetaSchema,
  AosSessionUpdateRequestSchema,
  AosSetVisibilityRequestSchema,
  AosSteerRequestSchema,
  AosSteerResponseSchema,
} from "@aos/protocol/acp"

/**
 * The browser-side seam over one ACP v2 WebSocket connection to the proxy.
 * `connection.ts` implements it; the runtime, thread list, interactions, and
 * workspace client consume it and are tested against a fake.
 */

export type AcpConnectionStatus =
  "connecting" | "ready" | "reconnecting" | "closed"

/** A server→client request awaiting the operator's answer. */
export type AcpPendingRequest =
  | {
      kind: "permission"
      sessionId: string
      request: RequestPermissionRequest
      respond(response: RequestPermissionResponse): void
    }
  | {
      kind: "elicitation"
      sessionId: string | undefined
      request: CreateElicitationRequest
      respond(response: CreateElicitationResponse): void
    }

export type AcpSessionUpdateListener = (
  update: SessionUpdate,
  meta: Record<string, unknown> | undefined
) => void

export type AcpResumeOptions = {
  replayFromStart: boolean
  /** Owning Agent when known before listing, e.g. from a deep link. */
  agentId?: string
  after?: number
  runId?: string
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

  /**
   * Redeems a guest invitation. The connection keeps the token and replays the
   * login before it resumes attached Sessions on a recovered transport.
   */
  login(token: string): Promise<void>

  newSession(meta: z.infer<typeof AosSessionNewMetaSchema>): Promise<{
    sessionId: string
    configOptions: SessionConfigOption[]
    meta: z.infer<typeof AosSessionNewResponseMetaSchema>
  }>
  listSessions(
    meta: z.infer<typeof AosSessionListMetaSchema>,
    cursor?: string
  ): Promise<{ sessions: SessionInfo[]; nextCursor?: string }>
  resumeSession(
    sessionId: string,
    options: AcpResumeOptions
  ): Promise<{
    configOptions: SessionConfigOption[]
    meta: z.infer<typeof AosSessionResumeResponseMetaSchema>
  }>
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
  closeSession(sessionId: string): Promise<void>
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
  setVisibility(
    request: z.infer<typeof AosSetVisibilityRequestSchema>
  ): Promise<z.infer<typeof VisibilityUpdateResponseSchema>>

  /** `session/update` notifications for one Session, with `_meta.aos`. */
  onSessionUpdate(
    sessionId: string,
    listener: AcpSessionUpdateListener
  ): () => void
  /**
   * Fires just before a from-start replay is requested, so whoever projects the
   * Session can drop the transcript that replay is about to resend.
   */
  onSessionReplay(sessionId: string, listener: () => void): () => void
  /** Extension notifications by method name (`AOS_METHODS.notify.*`). */
  onNotification(
    method: string,
    listener: (params: unknown) => void
  ): () => void
  onPendingRequest(listener: (request: AcpPendingRequest) => void): () => void
  /** Last `_meta.aos.sequence` seen for a Session's run, for resume. */
  lastSequence(sessionId: string): { runId: string; after: number } | undefined
  close(): void
}
