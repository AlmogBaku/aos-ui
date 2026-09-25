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
  AOS_REPLAY_BEFORE,
  AosActivityNotificationSchema,
  AosAgentUpdateResponseSchema,
  AosAgentsListResponseSchema,
  AosChunkMetaSchema,
  AosComposerPrefillNotificationSchema,
  AosErrorNotificationSchema,
  AosHistoryPageResponseMetaSchema,
  AosHistoryPageTagSchema,
  AosInitializeMetaSchema,
  AosPromptResponseMetaSchema,
  AosSessionInvalidatedNotificationSchema,
  AosSessionNewResponseMetaSchema,
  AosSessionResumeResponseMetaSchema,
  AosSteerAcceptedNotificationSchema,
  AosSteerResponseSchema,
  type AosHistoryCursor,
  type AosInitializeMeta,
} from "@aos/protocol/acp"

import { AgentUpdateError } from "../../contracts"
import type {
  AcpConnection,
  AcpConnectionStatus,
  AcpHistoryPage,
  AcpPendingRequest,
  AcpResumeOptions,
  AcpSessionReplayListener,
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

/** An ACP payload's `_meta`, keyed by extension; only AOS's half is read. */
const AosEnvelopeSchema = z.object({
  [AOS_META_KEY]: z.record(z.string(), z.unknown()),
})

/** Session-scoped elicitations name their Session; request-scoped ones do not. */
const ElicitationScopeSchema = z.object({ sessionId: z.string().min(1) })

const NOTIFICATION_PARSERS: Readonly<Record<string, ParamsParser<unknown>>> = {
  [AOS_METHODS.notify.activity]: AosActivityNotificationSchema,
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

/** Whether a JSON-RPC failure carries `code`. */
function hasErrorCode(error: unknown, code: number) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  )
}

/** The code the proxy refuses an invitation it cannot redeem with. */
function isAuthenticationRequired(error: unknown) {
  return hasErrorCode(error, AOS_JSONRPC_ERRORS.authenticationRequired)
}

/** The Agent update refusals a caller can act on, as typed errors. */
function agentUpdateError(error: unknown) {
  if (hasErrorCode(error, AOS_JSONRPC_ERRORS.unsupported))
    return new AgentUpdateError(
      "unsupported",
      "This runtime cannot store that Agent field"
    )
  if (hasErrorCode(error, AOS_JSONRPC_ERRORS.revisionConflict))
    return new AgentUpdateError("conflict", "The Agent changed; reload it")
  return error
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
  const replayListeners = new Map<string, Set<AcpSessionReplayListener>>()
  const notificationListeners = new Map<
    string,
    Set<(params: unknown) => void>
  >()
  const pendingListeners = new Set<(request: AcpPendingRequest) => void>()
  const statusListeners = new Set<(status: AcpConnectionStatus) => void>()
  const positions = new Map<string, { turnId: string; after: number }>()
  const histories = new Map<string, AosHistoryCursor>()
  /** The updates of the page read in flight for each Session. */
  const pages = new Map<string, AcpHistoryPage["updates"][number][]>()
  // The proxy answers `notFound` for a Session a fresh connection has not
  // listed or created, so every resume names the Agent that owns it.
  const owners = new Map<string, string>()

  let status: AcpConnectionStatus = "connecting"
  let started = false
  let closed = false
  let live: { connection: ClientConnection; ready: Promise<void> } | undefined
  let reconnectDelayMs = INITIAL_RECONNECT_MS
  let reconnecting = false
  let recovering = false
  /** Settles once a recovered transport has reattached every Session. */
  let reattached: PromiseWithResolvers<void> | undefined
  // The guest lane's principal, replayed whenever a new transport redeems it.
  let invitation: string | undefined
  // The last presence report, replayed whenever a new transport recovers.
  let lastFocus:
    { sessionId: string | null; foreground: boolean; idle: boolean } | undefined
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

  /**
   * Holds one request open until it is answered or withdrawn. A withdrawn one
   * rejects with the abort's reason, the SDK's `requestCancelled`, so the SDK
   * answers it as cancelled and releases it.
   */
  function held<Response>(
    signal: AbortSignal,
    emit: (respond: (response: Response) => void) => void
  ) {
    return new Promise<Response>((respond, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      })
      emit(respond)
    })
  }

  function permissionRequest(
    request: RequestPermissionRequest,
    signal: AbortSignal
  ) {
    return held<RequestPermissionResponse>(signal, (respond) => {
      emitPending({
        kind: "permission",
        sessionId: request.sessionId,
        request,
        respond,
        signal,
      })
    })
  }

  function elicitationRequest(
    request: CreateElicitationRequest,
    signal: AbortSignal
  ) {
    const scope = ElicitationScopeSchema.safeParse(request)
    return held<CreateElicitationResponse>(signal, (respond) => {
      emitPending({
        kind: "elicitation",
        sessionId: scope.success ? scope.data.sessionId : undefined,
        request,
        respond,
        signal,
      })
    })
  }

  const app = client({ name: clientInfo.name })
    .onNotification(methods.client.session.update, ({ params }) => {
      // Every `_meta.aos` the protocol defines for an update belongs to the
      // update itself, not to the notification carrying it.
      const meta = aosMetaOf(params.update._meta)
      // An older page's updates belong to the page read alone: its turns are
      // long over, so a live listener or the resume position would take its
      // state markers for the running turn's.
      if (AosHistoryPageTagSchema.safeParse(meta).data?.historyPage) {
        pages.get(params.sessionId)?.push({ update: params.update, meta })
        return
      }
      // Every turn meta extends the chunk meta, and reads drop unknown keys,
      // so the chunk schema positions any of them.
      const position = AosChunkMetaSchema.safeParse(meta)
      if (position.success)
        positions.set(params.sessionId, {
          turnId: position.data.turnId,
          after: position.data.sequence,
        })
      for (const listener of updateListeners.get(params.sessionId) ?? [])
        listener(params.update, meta)
    })
    .onRequest(methods.client.session.requestPermission, ({ params, signal }) =>
      permissionRequest(params, signal)
    )
    .onRequest(methods.client.elicitation.create, ({ params, signal }) =>
      elicitationRequest(params, signal)
    )
  for (const [method, parser] of Object.entries(NOTIFICATION_PARSERS))
    app.onNotification(method, parser, ({ params }) => {
      for (const listener of notificationListeners.get(method) ?? [])
        listener(params)
    })

  async function withAgent(): Promise<ClientContext> {
    // React commits children before their parent, so a consumer's effect can
    // reach the wire before the effect that owns the transport. The first call
    // opens it; `start` stays the only place that decides to.
    start()
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
      // This client pages older history itself, so a from-start resume may
      // replay only the newest page.
      capabilities: { _meta: { [AOS_META_KEY]: { historyPages: true } } },
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
    // A from-start replay resends the whole Session, and its turns arrive as
    // chunks: whoever projects this one drops what the replay replaces first, or
    // every part it already holds is appended to a second time.
    const settled = resume.replayFromStart
      ? [...(replayListeners.get(sessionId) ?? [])].map((listener) =>
          listener()
        )
      : []
    try {
      const response = await agent.request(methods.agent.session.resume, {
        sessionId,
        cwd: SERVER_OWNED_CWD,
        ...(resume.replayFromStart ? { replayFrom: { type: "start" } } : {}),
        _meta: {
          [AOS_META_KEY]: {
            ...(agentId === undefined ? {} : { agentId }),
            ...(resume.after === undefined ? {} : { after: resume.after }),
            ...(resume.turnId === undefined ? {} : { turnId: resume.turnId }),
          },
        },
      })
      const meta = AosSessionResumeResponseMetaSchema.parse(
        aosMetaOf(response._meta)
      )
      owners.set(sessionId, meta.session.agentId)
      // Recorded before the replay settles, so whoever it settles reads the
      // cursor of the transcript it now holds.
      if (meta.history) histories.set(sessionId, meta.history)
      return { configOptions: response.configOptions ?? [], meta }
    } finally {
      for (const settle of settled) settle?.()
    }
  }

  async function resumePage(
    sessionId: string,
    cursor: string
  ): Promise<AcpHistoryPage> {
    // The proxy reads a page only for a Session this connection has attached,
    // which a recovered transport has not done until it reattaches.
    await reattached?.promise
    const agent = await withAgent()
    const updates: AcpHistoryPage["updates"][number][] = []
    pages.set(sessionId, updates)
    try {
      const response = await agent.request(methods.agent.session.resume, {
        sessionId,
        cwd: SERVER_OWNED_CWD,
        replayFrom: { type: AOS_REPLAY_BEFORE, cursor },
      })
      const { history } = AosHistoryPageResponseMetaSchema.parse(
        aosMetaOf(response._meta)
      )
      return { updates, history }
    } finally {
      if (pages.get(sessionId) === updates) pages.delete(sessionId)
    }
  }

  /** The proxy replays every attached Session from the sequence last seen. */
  async function resumeAttached() {
    // A closed connection loses its presence, so the new one carries the last
    // report again before any replay can make this tab look attended.
    if (lastFocus) {
      const agent = await withAgent()
      await agent.notify(AOS_METHODS.session.focus, lastFocus)
    }
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
        reattached?.resolve()
        reattached = undefined
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
      if (!reattached) {
        reattached = Promise.withResolvers()
        // Closing mid-recovery must not raise an unhandled rejection when no
        // page read is waiting.
        void reattached.promise.catch(() => {})
      }
      setStatus("reconnecting")
      scheduleReconnect()
    }
    void connection.closed.then(onClosed, onClosed)
  }

  /**
   * Opens the transport, once. Creating a connection performs no I/O, so a
   * render React discards leaves no socket behind, and a closed connection
   * stays closed. Recovery after a drop belongs to `scheduleReconnect`.
   */
  function start() {
    if (started || closed) return
    started = true
    open()
  }

  function closeConnection() {
    if (closed) return
    closed = true
    setStatus("closed")
    failInitialized?.(new Error("The ACP connection closed"))
    failInitialized = undefined
    settleInitialized = undefined
    reattached?.reject(new Error("The ACP connection closed"))
    reattached = undefined
    live?.connection.close()
    live = undefined
  }

  return {
    get status() {
      return status
    },
    start,
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
    resumePage,
    history: (sessionId) => histories.get(sessionId),

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

    focus(sessionId, presence) {
      const report = {
        sessionId,
        foreground: presence.foreground,
        idle: presence.idle,
      }
      lastFocus = report
      notifyAgent((agent) => agent.notify(AOS_METHODS.session.focus, report))
    },

    async listAgents() {
      const agent = await withAgent()
      return AosAgentsListResponseSchema.parse(
        await agent.request(AOS_METHODS.agents.list)
      )
    },

    async updateAgent(request) {
      const agent = await withAgent()
      const response = await agent
        .request(AOS_METHODS.agents.update, request)
        .catch((error: unknown) => {
          throw agentUpdateError(error)
        })
      return AosAgentUpdateResponseSchema.parse(response)
    },

    onSessionUpdate: (sessionId, listener) =>
      subscribeKeyed(updateListeners, sessionId, listener),
    onSessionReplay: (sessionId, listener) =>
      subscribeKeyed(replayListeners, sessionId, listener),
    onNotification: (method, listener) =>
      subscribeKeyed(notificationListeners, method, listener),
    onPendingRequest: (listener) => subscribeTo(pendingListeners, listener),
    lastSequence: (sessionId) => positions.get(sessionId),

    close: closeConnection,
  }
}
