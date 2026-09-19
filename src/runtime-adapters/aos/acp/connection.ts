import {
  client,
  methods,
  type AgentApp,
  type AnyWireMessage,
  type ClientConnection,
  type ClientContext,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ParamsParser,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2"
import {
  createWebSocketStream,
  type WebSocketConstructor,
} from "@agentclientprotocol/sdk/experimental/ws-client"
import { z } from "zod"

import {
  ACP_PROTOCOL_VERSION,
  AOS_ACP_OPERATOR_PATH,
  AOS_AUTH_METHOD_INVITE,
  AOS_JSONRPC_ERRORS,
  AOS_METHODS,
  AOS_META_KEY,
  AosActivityNotificationSchema,
  AosAgentsListResponseSchema,
  AosArtifactNotificationSchema,
  AosChunkMetaSchema,
  AosComposerPrefillNotificationSchema,
  AosErrorNotificationSchema,
  AosInitializeMetaSchema,
  AosPromptResponseMetaSchema,
  AosSessionInvalidatedNotificationSchema,
  AosSessionNewResponseMetaSchema,
  AosSessionResumeResponseMetaSchema,
  AosSetVisibilityResponseSchema,
  AosSteerAcceptedNotificationSchema,
  AosSteerResponseSchema,
  type AosInitializeMeta,
} from "@aos/protocol/acp"

import type {
  AcpConnection,
  AcpConnectionStatus,
  AcpPendingRequest,
  AcpResumeOptions,
  AcpSessionUpdateListener,
} from "./types"

/**
 * The browser end of one ACP v2 connection to the proxy: the AOS extension
 * handlers, the handshake, the agent-side calls, and transport recovery.
 * Everything above this module consumes `AcpConnection`, never the SDK.
 */

const INITIAL_RECONNECT_MS = 250
const MAX_RECONNECT_MS = 5_000

/**
 * ACP requires a workspace root on `session/new` and `session/resume`. Agent
 * worktrees are server-owned, so the browser sends the root and the proxy
 * resolves the Session's real cwd from the Agent.
 */
const SERVER_OWNED_CWD = "/"

/** Run position of one `session/update`; richer metas carry more fields. */
const RunPositionSchema = z.object(AosChunkMetaSchema.shape)

/** An ACP payload's `_meta`, keyed by extension; only AOS's half is read. */
const AosEnvelopeSchema = z.object({
  [AOS_META_KEY]: z.record(z.string(), z.unknown()),
})

/** Session-scoped elicitations name their Session; request-scoped ones do not. */
const ElicitationScopeSchema = z.object({ sessionId: z.string().min(1) })

const NOTIFICATION_PARSERS: Readonly<Record<string, ParamsParser<unknown>>> = {
  [AOS_METHODS.notify.activity]: AosActivityNotificationSchema,
  [AOS_METHODS.notify.artifact]: AosArtifactNotificationSchema,
  [AOS_METHODS.notify.steerAccepted]: AosSteerAcceptedNotificationSchema,
  [AOS_METHODS.notify.composerPrefill]: AosComposerPrefillNotificationSchema,
  [AOS_METHODS.notify.sessionInvalidated]:
    AosSessionInvalidatedNotificationSchema,
  [AOS_METHODS.notify.catalogInvalidated]: z.unknown().optional(),
  [AOS_METHODS.notify.error]: AosErrorNotificationSchema,
}

export type AcpConnectionOptions = {
  clientInfo: { name: string; version: string }
  /** Defaults to the same-origin operator endpoint. */
  url?: string
  /** Defaults to `globalThis.WebSocket`; tests inject a fake. */
  socketConstructor?: WebSocketConstructor
  /** Pairs in process with an agent app instead of opening a socket. */
  connectAgent?: AgentApp
  schedule?: (delayMs: number, task: () => void) => void
}

/** The code the proxy refuses an invitation it cannot redeem with. */
function isAuthenticationRequired(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === AOS_JSONRPC_ERRORS.authenticationRequired
  )
}

/** `_meta.aos` of an ACP payload, when it carries one. */
function aosMetaOf(meta: unknown): Record<string, unknown> | undefined {
  const parsed = AosEnvelopeSchema.safeParse(meta)
  return parsed.success ? parsed.data[AOS_META_KEY] : undefined
}

/** One of the proxy's ACP lane paths as a same-origin WebSocket URL. */
export function acpSocketUrl(path: string) {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

function subscribeTo<Listener>(listeners: Set<Listener>, listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function subscribeKeyed<Listener>(
  listeners: Map<string, Set<Listener>>,
  key: string,
  listener: Listener
) {
  const keyed = listeners.get(key) ?? new Set<Listener>()
  keyed.add(listener)
  listeners.set(key, keyed)
  return () => {
    keyed.delete(listener)
    if (!keyed.size) listeners.delete(key)
  }
}

export function createAcpConnection(
  options: AcpConnectionOptions
): AcpConnection {
  const { clientInfo, connectAgent } = options
  const schedule =
    options.schedule ??
    ((delayMs, task) => {
      setTimeout(task, delayMs)
    })
  const updateListeners = new Map<string, Set<AcpSessionUpdateListener>>()
  const notificationListeners = new Map<
    string,
    Set<(params: unknown) => void>
  >()
  const pendingListeners = new Set<(request: AcpPendingRequest) => void>()
  const statusListeners = new Set<(status: AcpConnectionStatus) => void>()
  const positions = new Map<string, { runId: string; after: number }>()
  // The proxy answers `notFound` for a Session a fresh connection has not
  // listed or created, so every resume names the Agent that owns it.
  const owners = new Map<string, string>()

  let status: AcpConnectionStatus = "connecting"
  let closed = false
  let live: { connection: ClientConnection; ready: Promise<void> } | undefined
  let reconnectDelayMs = INITIAL_RECONNECT_MS
  let reconnecting = false
  let recovering = false
  // The guest lane's principal, replayed whenever a new transport redeems it.
  let invitation: string | undefined
  let settleInitialized: ((meta: AosInitializeMeta) => void) | undefined
  let failInitialized: ((error: Error) => void) | undefined
  const initialized = new Promise<AosInitializeMeta>((resolve, reject) => {
    settleInitialized = resolve
    failInitialized = reject
  })
  // Closing before the handshake settles must not raise an unhandled rejection
  // in a consumer that never awaited it.
  void initialized.catch(() => {})

  function setStatus(next: AcpConnectionStatus) {
    if (status === next) return
    status = next
    for (const listener of statusListeners) listener(next)
  }

  function emitPending(request: AcpPendingRequest) {
    for (const listener of pendingListeners)
      try {
        listener(request)
      } catch {
        // A consumer that cannot show one request must not fail it for the
        // others: an unanswered request stays pending for the proxy to
        // re-issue, which never answers the runtime on the operator's behalf.
      }
  }

  function permissionRequest(request: RequestPermissionRequest) {
    return new Promise<RequestPermissionResponse>((respond) => {
      emitPending({
        kind: "permission",
        sessionId: request.sessionId,
        request,
        respond,
      })
    })
  }

  function elicitationRequest(request: CreateElicitationRequest) {
    const scope = ElicitationScopeSchema.safeParse(request)
    return new Promise<CreateElicitationResponse>((respond) => {
      emitPending({
        kind: "elicitation",
        sessionId: scope.success ? scope.data.sessionId : undefined,
        request,
        respond,
      })
    })
  }

  const app = client({ name: clientInfo.name })
    .onNotification(methods.client.session.update, ({ params }) => {
      // Every `_meta.aos` the protocol defines for an update belongs to the
      // update itself, not to the notification carrying it.
      const meta = aosMetaOf(params.update._meta)
      const position = RunPositionSchema.safeParse(meta)
      if (position.success)
        positions.set(params.sessionId, {
          runId: position.data.runId,
          after: position.data.sequence,
        })
      for (const listener of updateListeners.get(params.sessionId) ?? [])
        listener(params.update, meta)
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) =>
      permissionRequest(params)
    )
    .onRequest(methods.client.elicitation.create, ({ params }) =>
      elicitationRequest(params)
    )
  for (const [method, parser] of Object.entries(NOTIFICATION_PARSERS))
    app.onNotification(method, parser, ({ params }) => {
      for (const listener of notificationListeners.get(method) ?? [])
        listener(params)
    })

  async function withAgent(): Promise<ClientContext> {
    const current = live
    if (closed || !current) throw new Error("The ACP connection is not open")
    await current.ready
    return current.connection.agent
  }

  /** Notifications have no reply; the proxy reports failures as `_aos/error`. */
  function notifyAgent(send: (agent: ClientContext) => Promise<void>) {
    void withAgent()
      .then(send)
      .catch(() => {})
  }

  async function handshake(connection: ClientConnection) {
    const response = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      info: { name: clientInfo.name, version: clientInfo.version },
      capabilities: {},
    })
    const meta = AosInitializeMetaSchema.parse(aosMetaOf(response._meta))
    settleInitialized?.(meta)
    settleInitialized = undefined
    failInitialized = undefined
  }

  async function login(token: string) {
    const agent = await withAgent()
    await agent.request(methods.agent.auth.login, {
      methodId: AOS_AUTH_METHOD_INVITE,
      _meta: { [AOS_META_KEY]: { token } },
    })
    invitation = token
  }

  /**
   * Redeems the invitation on a recovered transport. A refused one stays
   * refused, so the connection ends instead of reconnecting against it.
   */
  async function reloginOrClose(token: string) {
    try {
      await login(token)
      return true
    } catch (error) {
      if (!isAuthenticationRequired(error)) throw error
      closeConnection()
      return false
    }
  }

  async function resumeSession(sessionId: string, resume: AcpResumeOptions) {
    const agent = await withAgent()
    const agentId = resume.agentId ?? owners.get(sessionId)
    const response = await agent.request(methods.agent.session.resume, {
      sessionId,
      cwd: SERVER_OWNED_CWD,
      ...(resume.replayFromStart ? { replayFrom: { type: "start" } } : {}),
      _meta: {
        [AOS_META_KEY]: {
          ...(agentId === undefined ? {} : { agentId }),
          ...(resume.after === undefined ? {} : { after: resume.after }),
          ...(resume.runId === undefined ? {} : { runId: resume.runId }),
        },
      },
    })
    const meta = AosSessionResumeResponseMetaSchema.parse(
      aosMetaOf(response._meta)
    )
    owners.set(sessionId, meta.session.agentId)
    return { configOptions: response.configOptions ?? [], meta }
  }

  /** The proxy replays every attached Session from the sequence last seen. */
  async function resumeAttached() {
    for (const sessionId of [...updateListeners.keys()]) {
      const resumed = await resumeSession(sessionId, {
        replayFromStart: false,
        ...positions.get(sessionId),
      })
      if (resumed.meta.resync)
        await resumeSession(sessionId, { replayFromStart: true })
    }
  }

  function scheduleReconnect() {
    if (reconnecting) return
    reconnecting = true
    const delayMs = reconnectDelayMs
    reconnectDelayMs = Math.min(delayMs * 2, MAX_RECONNECT_MS)
    schedule(delayMs, () => {
      reconnecting = false
      if (!closed) open()
    })
  }

  function open() {
    const connection = connectAgent
      ? app.connect(connectAgent)
      : app.connect(
          createWebSocketStream<AnyWireMessage>(
            options.url ?? acpSocketUrl(AOS_ACP_OPERATOR_PATH),
            options.socketConstructor
              ? { WebSocket: options.socketConstructor }
              : {}
          )
        )
    const current = { connection, ready: handshake(connection) }
    live = current
    // A handshake or replay that cannot complete leaves an unusable
    // connection; closing it runs the same recovery as a dropped transport.
    void current.ready
      .then(async () => {
        reconnectDelayMs = INITIAL_RECONNECT_MS
        setStatus("ready")
        // Consumers attach Sessions on the first connection themselves; only a
        // recovered transport owes them a replay.
        if (!recovering) return
        recovering = false
        // The new transport is unauthenticated, so a guest connection redeems
        // its invitation again before anything that login authorizes.
        if (invitation !== undefined && !(await reloginOrClose(invitation)))
          return
        await resumeAttached()
      })
      .catch((error: unknown) => connection.close(error))
    const onClosed = () => {
      if (live === current) live = undefined
      if (closed) return
      // In-process pairing has no transport to reopen.
      if (connectAgent) {
        setStatus("closed")
        return
      }
      recovering = true
      setStatus("reconnecting")
      scheduleReconnect()
    }
    void connection.closed.then(onClosed, onClosed)
  }

  function closeConnection() {
    if (closed) return
    closed = true
    setStatus("closed")
    failInitialized?.(new Error("The ACP connection closed"))
    failInitialized = undefined
    settleInitialized = undefined
    live?.connection.close()
    live = undefined
  }

  open()

  return {
    get status() {
      return status
    },
    initialized,
    subscribeStatus: (listener) => subscribeTo(statusListeners, listener),

    login,

    async newSession(meta) {
      const agent = await withAgent()
      const response = await agent.request(methods.agent.session.new, {
        cwd: SERVER_OWNED_CWD,
        _meta: { [AOS_META_KEY]: meta },
      })
      const created = AosSessionNewResponseMetaSchema.parse(
        aosMetaOf(response._meta)
      )
      owners.set(response.sessionId, created.session.agentId)
      return {
        sessionId: response.sessionId,
        configOptions: response.configOptions ?? [],
        meta: created,
      }
    },

    async listSessions(meta, cursor) {
      const agent = await withAgent()
      const response = await agent.request(methods.agent.session.list, {
        ...(cursor === undefined ? {} : { cursor }),
        _meta: { [AOS_META_KEY]: meta },
      })
      return {
        sessions: response.sessions,
        ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
      }
    },

    resumeSession,

    async prompt(sessionId, blocks: ContentBlock[], meta) {
      const agent = await withAgent()
      const response = await agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: blocks,
        _meta: { [AOS_META_KEY]: meta },
      })
      return AosPromptResponseMetaSchema.parse(aosMetaOf(response._meta))
    },

    cancel(sessionId) {
      notifyAgent((agent) =>
        agent.notify(methods.agent.session.cancel, { sessionId })
      )
    },

    async setConfigOption(sessionId, configId, value) {
      const agent = await withAgent()
      const response = await agent.request(
        methods.agent.session.setConfigOption,
        { sessionId, configId, type: "id", value }
      )
      return response.configOptions
    },

    async closeSession(sessionId) {
      const agent = await withAgent()
      await agent.request(methods.agent.session.close, { sessionId })
    },

    async deleteSession(sessionId) {
      const agent = await withAgent()
      await agent.request(methods.agent.session.delete, { sessionId })
    },

    async updateSession(request) {
      const agent = await withAgent()
      await agent.request(AOS_METHODS.session.update, request)
    },

    async steer(request) {
      const agent = await withAgent()
      return AosSteerResponseSchema.parse(
        await agent.request(AOS_METHODS.session.steer, request)
      )
    },

    focus(sessionId) {
      notifyAgent((agent) =>
        agent.notify(AOS_METHODS.session.focus, { sessionId })
      )
    },

    async listAgents() {
      const agent = await withAgent()
      return AosAgentsListResponseSchema.parse(
        await agent.request(AOS_METHODS.agents.list)
      )
    },

    async setVisibility(request) {
      const agent = await withAgent()
      return AosSetVisibilityResponseSchema.parse(
        await agent.request(AOS_METHODS.agents.setVisibility, request)
      )
    },

    onSessionUpdate: (sessionId, listener) =>
      subscribeKeyed(updateListeners, sessionId, listener),
    onNotification: (method, listener) =>
      subscribeKeyed(notificationListeners, method, listener),
    onPendingRequest: (listener) => subscribeTo(pendingListeners, listener),
    lastSequence: (sessionId) => positions.get(sessionId),

    close: closeConnection,
  }
}
