import {
  client,
  methods,
  RequestError,
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
  type SendRequestOptions,
  type WireStream,
} from "@agentclientprotocol/sdk/experimental/v2"
import {
  createWebSocketStream,
  type WebSocketConstructor,
} from "@agentclientprotocol/sdk/experimental/ws-client"
import { z } from "zod"

import {
  backoffDelay,
  createOwner,
  Deadline,
  defaultClock,
  fromAbortable,
  ownerSetup,
  type Clock,
  type Logger,
  type Owner,
} from "@aos/lifecycle"
import {
  ACP_PROTOCOL_VERSION,
  AOS_ACP_OPERATOR_PATH,
  AOS_AUTH_METHOD_INVITE,
  AOS_METHODS,
  AOS_META_KEY,
  AOS_REPLAY_BEFORE,
  AosActivityNotificationSchema,
  AosAgentsListResponseSchema,
  AosChunkMetaSchema,
  AosComposerPrefillNotificationSchema,
  AosErrorNotificationSchema,
  AosHistoryPageResponseMetaSchema,
  AosHistoryPageTagSchema,
  AosInitializeMetaSchema,
  AosPromptResponseMetaSchema,
  AosSessionInvalidatedNotificationSchema,
  AosSessionResumeResponseMetaSchema,
  AosSetVisibilityResponseSchema,
  AosSteerAcceptedNotificationSchema,
  AosSteerResponseSchema,
  type AosHistoryCursor,
  type AosInitializeMeta,
} from "@aos/protocol/acp"

import {
  CAPACITY_BACKOFF,
  HANDSHAKE_DEADLINE_MS,
  LIVENESS_SILENCE_MS,
  PART_GRACE_MS,
  RECONNECT_BACKOFF,
  REQUEST_DEADLINE_MS,
  STABLE_AFTER_MS,
  type RequestTier,
} from "./limits"
import { acpDebugEnabled, loggedStream } from "./log"
import type {
  AcpConnection,
  AcpConnectionStatus,
  AcpHistoryPage,
  AcpPendingRequest,
  AcpSessionListener,
  AcpSessionState,
} from "./types"

/**
 * The browser end of one ACP v2 connection to the proxy: the AOS extension
 * handlers, the handshake, the agent-side calls, and transport recovery.
 * Everything above this module consumes `AcpConnection`, never the SDK.
 */

/** The close codes the proxy ends a connection with on purpose. */
const TRY_AGAIN_LATER = 1013
const POLICY_VIOLATION = 1008

/** Where a connection logs when its caller passes no logger. */
const SILENT_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => SILENT_LOGGER,
}

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
  /** Times every deadline and backoff; tests fake it. */
  clock?: Clock
  /**
   * Where the connection logs its owner's transitions and every wire frame;
   * silent by default.
   */
  logger?: Logger
  /**
   * The browser's compiled build id, sent as `info.version` in `initialize`.
   * Defaults to `__AOS_BUILD_ID__` (null on the dev server). When both the
   * browser and the proxy carry an id and they differ, the tab is reloaded
   * once per proxy build, which `storage` remembers.
   */
  buildId?: string | null
  /** Called when a build id mismatch triggers a reload; tests inject a spy. */
  reload?: () => void
  /** Persists the reload guard across the reload; tests inject a fake. */
  storage?: {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
  }
}

/** ACP's code for a request that needs authentication, as the SDK builds it. */
const AUTHENTICATION_REQUIRED = RequestError.authRequired().code
/** ACP's code for a Session the provider no longer has. */
const RESOURCE_NOT_FOUND = RequestError.resourceNotFound().code
/** The code an `_aos/error` names a Session the provider no longer has with. */
const NOT_FOUND_NOTICE = "not_found"
/** sessionStorage key naming the proxy build the tab last reloaded for. */
const RELOADED_FOR_BUILD_KEY = "aos-reloaded-for-build"

function codeOf(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined
}

/** Whether the proxy refused an invitation it cannot redeem. */
export function isAuthenticationRequired(error: unknown) {
  return codeOf(error) === AUTHENTICATION_REQUIRED
}

/** Whether the proxy answered that the Session no longer exists. */
function isGone(error: unknown) {
  return codeOf(error) === RESOURCE_NOT_FOUND
}

/** A request's own deadline fired, as opposed to its transport closing. */
function isTimeout(error: unknown) {
  return error instanceof DOMException && error.name === "TimeoutError"
}

/** `_meta.aos` of an ACP payload, when it carries one. */
function aosMetaOf(meta: unknown): Record<string, unknown> | undefined {
  const parsed = AosEnvelopeSchema.safeParse(meta)
  return parsed.success ? parsed.data[AOS_META_KEY] : undefined
}

/** One of the proxy's ACP listener paths as a same-origin WebSocket URL. */
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

/**
 * Adds an `onReceived` callback on every inbound frame, used to drive the
 * inbound-silence timer without coupling logging to liveness tracking.
 */
function trackedInbound(stream: WireStream, onReceived: () => void): WireStream {
  return {
    readable: stream.readable.pipeThrough(
      new TransformStream<AnyWireMessage, AnyWireMessage>({
        transform(frame, controller) {
          onReceived()
          controller.enqueue(frame)
        },
      })
    ),
    writable: stream.writable,
  }
}

/** One opened transport; a reconnect replaces it with another. */
type Transport = {
  connection: ClientConnection
  /** Settles once the proxy answers `initialize`. */
  ready: Promise<void>
}

type ConnectionEvent =
  { type: "closed"; code: number | undefined } | { type: "close" }

/**
 * What a Session owner hears: its connection's transport becoming usable or
 * lost, a from-start replay asked for, and the provider reporting it gone.
 */
type SessionEvent =
  { type: "ready" } | { type: "lost" } | { type: "replay" } | { type: "gone" }

/** The updates of one older page, in arrival order. */
type PageUpdates = AcpHistoryPage["updates"][number][]

/**
 * The constructor a transport opens its socket with. It reports the open and
 * the close code, which the SDK drops, and its listeners run before the ones
 * the SDK attaches once the socket is constructed.
 */
function observedSocket(
  Socket: WebSocketConstructor,
  onOpen: () => void,
  onClose: (code: number | undefined) => void
): WebSocketConstructor {
  return class extends Socket {
    constructor(...args: ConstructorParameters<WebSocketConstructor>) {
      super(...args)
      this.addEventListener?.("open", onOpen)
      this.addEventListener?.("close", (event) =>
        onClose(event instanceof CloseEvent ? event.code : undefined)
      )
    }
  }
}

export function createAcpConnection(
  options: AcpConnectionOptions
): AcpConnection {
  const {
    clientInfo,
    connectAgent,
    clock = defaultClock,
    logger = SILENT_LOGGER,
    reload,
    storage,
  } = options
  // __AOS_BUILD_ID__ is injected by Vite's define plugin at build time.
  // It is not available in the test environment, so guard with typeof.
  const buildId =
    "buildId" in options
      ? options.buildId
      : typeof __AOS_BUILD_ID__ !== "undefined"
        ? (__AOS_BUILD_ID__ ?? null)
        : null
  const notificationListeners = new Map<
    string,
    Set<(params: unknown) => void>
  >()
  const pendingListeners = new Set<(request: AcpPendingRequest) => void>()
  const statusListeners = new Set<(status: AcpConnectionStatus) => void>()
  /**
   * One opened Session: whoever listens, the owner that joins it, and what a
   * rejoin and a page read need, all dropped once it parts.
   */
  type OpenSession = {
    readonly listeners: Set<AcpSessionListener>
    owner?: Owner<ReturnType<typeof sessionMachine>>
    state: AcpSessionState
    /** Where the live turn was last seen, which a rejoin resumes from. */
    position?: { turnId: string; after: number }
    /** What the latest from-start replay reported of older history. */
    history?: AosHistoryCursor
    /** The updates of the page read in flight. */
    page?: PageUpdates
    /** Whether a join has replayed it from the start yet. */
    replayed: boolean
    /** A from-start replay is owed: asked for, or a rejoin's resync. */
    replayOwed: boolean
    /** The from-start replay in flight and the settle callbacks it owes. */
    replaying?: { settles: (() => void)[]; delivered: boolean }
    waiters?: PromiseWithResolvers<void>
    grace?: unknown
  }
  const sessions = new Map<string, OpenSession>()
  // The proxy answers `notFound` for a Session a fresh connection has not
  // listed or created, so every resume names the Agent that owns it.
  const owners = new Map<string, string>()

  let status: AcpConnectionStatus = "connecting"
  let started = false
  /** Settles once a debug dev build has loaded its inspector and opened. */
  let inspecting: Promise<void> | undefined
  let ended = false
  /** Opens, recovers and ends transports; `start` creates it. */
  let owner: Owner<typeof machine> | undefined
  let live: Transport | undefined
  /** Set once a transport is lost, until a replacement recovers. */
  let recovering = false
  /** Whether a Session opened now may join at once, the transport recovered. */
  let joinable = false
  // The guest listener's principal, replayed when a new transport redeems it.
  let invitation: string | undefined
  // The last presence report, replayed whenever a new transport recovers.
  let lastFocus:
    { sessionId: string | null; foreground: boolean; idle: boolean } | undefined
  /** The handle for the running inbound-silence timer; replaced on every inbound frame. */
  let silenceTimer: unknown = undefined
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

  /** Whether the browser tab is currently visible. */
  function isVisible() {
    return globalThis.document?.visibilityState !== "hidden"
  }

  /**
   * (Re)arms the inbound-silence timer after each received frame. When the
   * page is not visible the timer is cleared; the `visibilitychange` handler
   * probes at once when the page becomes visible again.
   */
  function armSilenceTimer() {
    clock.clearTimeout(silenceTimer)
    silenceTimer = undefined
    if (!isVisible() || ended) return
    silenceTimer = clock.setTimeout(() => {
      silenceTimer = undefined
      sendLivenessProbeAsync()
    }, LIVENESS_SILENCE_MS)
  }

  /** Called on every inbound frame; resets the silence window. */
  function onInbound() {
    armSilenceTimer()
  }

  /**
   * Sends `_aos/session/focus` as a request. A reply within the probe
   * deadline is the liveness acknowledgement; no reply closes the transport
   * and the connection reconnects. Re-reports the last known focused Session
   * if any, or `{}` when no focus has been reported yet.
   */
  function sendLivenessProbeAsync() {
    const params = lastFocus ?? {}
    request("probe", (agent, options) =>
      agent.request(AOS_METHODS.session.focus, params, options)
    ).catch((err: unknown) => {
      logger.debug({ err }, "acp.liveness.failed")
    })
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
      const open = sessions.get(params.sessionId)
      if (!open) return
      // An older page's updates belong to the page read alone: its turns are
      // long over, so a live listener or the rejoin position would take its
      // state markers for the running turn's.
      if (AosHistoryPageTagSchema.safeParse(meta).data?.historyPage) {
        open.page?.push({ update: params.update, meta })
        return
      }
      // Every turn meta extends the chunk meta, and reads drop unknown keys,
      // so the chunk schema positions any of them.
      const position = AosChunkMetaSchema.safeParse(meta)
      if (position.success)
        open.position = {
          turnId: position.data.turnId,
          after: position.data.sequence,
        }
      if (open.replaying) open.replaying.delivered = true
      for (const listener of open.listeners)
        listener.update?.(params.update, meta)
    })
    .onRequest(methods.client.session.requestPermission, ({ params, signal }) =>
      permissionRequest(params, signal)
    )
    .onRequest(methods.client.elicitation.create, ({ params, signal }) =>
      elicitationRequest(params, signal)
    )
  for (const [method, parser] of Object.entries(NOTIFICATION_PARSERS))
    app.onNotification(method, parser, ({ params }) => {
      if (method === AOS_METHODS.notify.error) noticeGone(params)
      for (const listener of notificationListeners.get(method) ?? [])
        listener(params)
    })

  /** An opened Session the proxy reports as not found is gone for good. */
  function noticeGone(params: unknown) {
    const notice = AosErrorNotificationSchema.safeParse(params).data
    if (notice?.code !== NOT_FOUND_NOTICE || notice.sessionId === undefined)
      return
    sessions.get(notice.sessionId)?.owner?.actor.send({ type: "gone" })
  }

  async function readyTransport(): Promise<Transport> {
    // React commits children before their parent, so a consumer's effect can
    // reach the wire before the effect that owns the transport. The first call
    // opens it; `start` stays the only place that decides to.
    start()
    // In a debug dev build the owner exists once the inspector has loaded.
    if (inspecting) await inspecting
    const current = live
    if (ended || !current) throw new Error("The ACP connection is not open")
    await current.ready
    return current
  }

  type Send<Response> = (
    agent: ClientContext,
    options: SendRequestOptions
  ) => Promise<Response>

  /**
   * Sends one request under its tier's deadline. A reply that never comes
   * means the transport has stalled, so it is closed and the connection
   * reconnects; a request `parent` aborts leaves the transport as it is.
   */
  async function request<Response>(tier: RequestTier, send: Send<Response>) {
    return requestOn(await readyTransport(), tier, send)
  }

  async function requestOn<Response>(
    { connection }: Transport,
    tier: RequestTier,
    send: Send<Response>,
    parent?: AbortSignal
  ) {
    const deadline = new Deadline(REQUEST_DEADLINE_MS[tier], clock, parent)
    try {
      return await deadline.run((cancellationSignal) =>
        send(connection.agent, { cancellationSignal })
      )
    } catch (error) {
      if (deadline.signal.aborted && !parent?.aborted) connection.close(error)
      throw error
    }
  }

  /**
   * Sends one write for a Session, once it is joined if it is open. A
   * transport that closes under the write sends it again, with the same
   * params and so the same client id, once the Session has rejoined on the
   * next one; a write that stalled its transport fails instead.
   */
  async function write<Response>(
    sessionId: string,
    tier: RequestTier,
    send: Send<Response>
  ): Promise<Response> {
    for (;;) {
      if (sessions.has(sessionId)) await joined(sessionId)
      const transport = await readyTransport()
      try {
        return await requestOn(transport, tier, send)
      } catch (error) {
        const closedUnder =
          transport.connection.signal.aborted &&
          !isTimeout(error) &&
          sessions.has(sessionId)
        if (!closedUnder) throw error
        // Once its close is handled, the Session has left `joined`.
        await transport.connection.closed.catch(() => {})
      }
    }
  }

  /**
   * Notifications have no reply; the proxy reports failures as `_aos/error`.
   * One for an open Session waits until it is joined.
   */
  function notifyAgent(
    send: (agent: ClientContext) => Promise<void>,
    sessionId?: string
  ) {
    void (async () => {
      if (sessionId !== undefined && sessions.has(sessionId))
        await joined(sessionId)
      const { connection } = await readyTransport()
      await send(connection.agent)
    })().catch((err: unknown) => {
      logger.debug({ err, sessionId }, "acp.notify.failed")
    })
  }

  async function handshake(connection: ClientConnection) {
    const response = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      info: {
        name: clientInfo.name,
        // Send the compiled build id so the proxy can detect a stale tab.
        // On the dev server and in the service worker, buildId is null and
        // the proxy's version acts as the AOS extension version instead.
        version: buildId ?? clientInfo.version,
      },
      // This client pages older history itself, so a from-start resume may
      // replay only the newest page.
      capabilities: { _meta: { [AOS_META_KEY]: { historyPages: true } } },
    })
    const meta = AosInitializeMetaSchema.parse(aosMetaOf(response._meta))
    // Both sides carry a build id: a mismatch means the proxy serves another
    // bundle. The tab reloads once per proxy build, so a reload that still
    // loads the old bundle cannot loop, and a later deployment reloads again.
    const proxyBuildId = response.info?.version
    if (
      buildId &&
      proxyBuildId !== undefined &&
      proxyBuildId !== buildId &&
      reload &&
      storage &&
      storage.getItem(RELOADED_FOR_BUILD_KEY) !== proxyBuildId
    ) {
      storage.setItem(RELOADED_FOR_BUILD_KEY, proxyBuildId)
      reload()
    }
    settleInitialized?.(meta)
    settleInitialized = undefined
    failInitialized = undefined
  }

  async function login(token: string) {
    await request("short", (agent, options) =>
      agent.request(
        methods.agent.auth.login,
        {
          methodId: AOS_AUTH_METHOD_INVITE,
          _meta: { [AOS_META_KEY]: { token } },
        },
        options
      )
    )
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

  /**
   * One `session/resume` of an opened Session: from the start when none has
   * replayed it yet or one is owed, else from its position. `signal` aborts
   * once its owner leaves `joining`, and then nothing is recorded.
   */
  async function joinOnce(sessionId: string, signal: AbortSignal) {
    const transport = await readyTransport()
    // Read once the transport is ready, so every listener that subscribed in
    // the same turn as the first one names the Agent and takes the replay.
    const open = sessions.get(sessionId)
    if (!open) throw notOpen()
    if (signal.aborted) return
    const fromStart = !open.replayed || open.replayOwed
    open.replayOwed = false
    const agentId =
      [...open.listeners].find((listener) => listener.agentId)?.agentId ??
      owners.get(sessionId)
    // A from-start replay resends the whole Session, and its turns arrive as
    // chunks: whoever projects this one drops what the replay replaces first,
    // or every part it already holds is appended to a second time.
    const replaying = fromStart
      ? { settles: [...open.listeners].flatMap(settleOf), delivered: false }
      : undefined
    open.replaying = replaying
    try {
      const response = await requestOn(
        transport,
        fromStart ? "long" : "medium",
        (agent, options) =>
          agent.request(
            methods.agent.session.resume,
            {
              sessionId,
              cwd: SERVER_OWNED_CWD,
              ...(fromStart ? { replayFrom: { type: "start" } } : {}),
              _meta: {
                [AOS_META_KEY]: {
                  ...(agentId === undefined ? {} : { agentId }),
                  ...(fromStart ? {} : open.position),
                },
              },
            },
            options
          ),
        signal
      )
      const meta = AosSessionResumeResponseMetaSchema.parse(
        aosMetaOf(response._meta)
      )
      if (signal.aborted) return
      if (agentId !== undefined) owners.set(sessionId, agentId)
      // Recorded before the replay settles, so whoever it settles reads the
      // cursor of the transcript it now holds.
      if (meta.history) open.history = meta.history
      if (fromStart) open.replayed = true
      if (meta.resync) open.replayOwed = true
    } finally {
      if (open.replaying === replaying) open.replaying = undefined
      for (const settle of replaying?.settles ?? []) settle()
    }
  }

  /** A listener's part in a from-start replay: its settle callback, if any. */
  function settleOf(listener: AcpSessionListener) {
    const settle = listener.replay?.()
    return settle ? [settle] : []
  }

  function notOpen() {
    return new Error("The Session is not open on this ACP connection")
  }

  function joined(sessionId: string) {
    const open = sessions.get(sessionId)
    if (!open) return Promise.reject(notOpen())
    if (open.state === "joined") return Promise.resolve()
    if (open.state === "gone")
      return Promise.reject(RequestError.resourceNotFound())
    if (!open.waiters) {
      open.waiters = Promise.withResolvers()
      // A part or close with nobody waiting is no unhandled rejection.
      void open.waiters.promise.catch(() => {})
    }
    return open.waiters.promise
  }

  function replay(sessionId: string) {
    const open = sessions.get(sessionId)
    if (!open) return Promise.reject(notOpen())
    const served = open.replaying
      ? !open.replaying.delivered
      : !open.replayed || open.replayOwed
    if (!served) open.owner?.actor.send({ type: "replay" })
    return joined(sessionId)
  }

  /** Mirrors the owner's state onto the record and its listeners. */
  function mirror(open: OpenSession, value: unknown) {
    const next: AcpSessionState =
      value === "joined" || value === "unavailable" || value === "gone"
        ? value
        : "joining"
    if (next === open.state) return
    open.state = next
    if (next === "joined") open.waiters?.resolve()
    if (next === "gone") open.waiters?.reject(RequestError.resourceNotFound())
    if (next === "joined" || next === "gone") open.waiters = undefined
    for (const listener of open.listeners) listener.state?.(next)
  }

  function subscribe(sessionId: string, listener: AcpSessionListener) {
    if (ended) return () => {}
    // A Session opened before the transport joins once it is ready.
    start()
    const known = sessions.get(sessionId)
    if (known) {
      clock.clearTimeout(known.grace)
      known.grace = undefined
      known.listeners.add(listener)
      // Nothing of the replay under way has arrived, so it carries the
      // Session whole to this listener too.
      if (known.replaying && !known.replaying.delivered)
        known.replaying.settles.push(...settleOf(listener))
      return () => leave(sessionId, known, listener)
    }
    const open = openSession(sessionId, [listener], false)
    return () => leave(sessionId, open, listener)
  }

  /**
   * Records an opened Session and starts its owner: one `session/new` just
   * joined is joined already and has nothing to replay; any other joins once
   * the transport is ready.
   */
  function openSession(
    sessionId: string,
    listeners: AcpSessionListener[],
    created: boolean
  ) {
    const open: OpenSession = {
      listeners: new Set(listeners),
      state: "joining",
      replayed: created,
      replayOwed: false,
    }
    sessions.set(sessionId, open)
    const initial = !joinable ? "detached" : created ? "joined" : "joining"
    const owner = createOwner(sessionMachine(sessionId, initial), {
      logger,
      clock,
      bindings: { sessionId },
    })
    open.owner = owner
    owner.actor.subscribe((snapshot) => mirror(open, snapshot.value))
    mirror(open, owner.actor.getSnapshot().value)
    return open
  }

  function leave(
    sessionId: string,
    open: OpenSession,
    listener: AcpSessionListener
  ) {
    if (!open.listeners.delete(listener) || open.listeners.size > 0) return
    if (sessions.get(sessionId) !== open) return
    open.grace = clock.setTimeout(() => part(sessionId, open), PART_GRACE_MS)
  }

  /** Drops a Session no listener came back to, and tells the proxy so. */
  function part(sessionId: string, open: OpenSession) {
    sessions.delete(sessionId)
    owners.delete(sessionId)
    open.owner?.dispose()
    open.waiters?.reject(notOpen())
    open.waiters = undefined
    if (open.state === "gone") return
    request("short", (agent, options) =>
      agent.request(methods.agent.session.close, { sessionId }, options)
    ).catch((err: unknown) => {
      logger.debug({ err, sessionId }, "acp.session.close.failed")
    })
  }

  async function resumePage(
    sessionId: string,
    cursor: string
  ): Promise<AcpHistoryPage> {
    // The proxy reads a page only for a Session this connection has joined,
    // which a recovered transport has not done until it rejoins.
    await joined(sessionId)
    const open = sessions.get(sessionId)
    if (!open) throw notOpen()
    const updates: PageUpdates = []
    open.page = updates
    try {
      const response = await request("medium", (agent, options) =>
        agent.request(
          methods.agent.session.resume,
          {
            sessionId,
            cwd: SERVER_OWNED_CWD,
            replayFrom: { type: AOS_REPLAY_BEFORE, cursor },
          },
          options
        )
      )
      const { history } = AosHistoryPageResponseMetaSchema.parse(
        aosMetaOf(response._meta)
      )
      return { updates, history }
    } finally {
      if (open.page === updates) open.page = undefined
    }
  }

  /**
   * What a transport owes once it is ready: a recovered one redeems the
   * invitation and restates presence first. Then every opened Session joins
   * on its own, and the transport is done once each has joined, gone, or
   * parted.
   */
  async function recover() {
    if (recovering) {
      recovering = false
      // The new transport is unauthenticated, so a guest connection redeems
      // its invitation again before anything that login authorizes.
      if (invitation !== undefined && !(await reloginOrClose(invitation)))
        return
      // A closed connection loses its presence; the liveness probe re-reports
      // it and confirms the transport is alive before any Session join.
      sendLivenessProbeAsync()
    }
    joinable = true
    const opened = [...sessions.keys()]
    for (const open of sessions.values())
      open.owner?.actor.send({ type: "ready" })
    await Promise.allSettled(opened.map(joined))
  }

  /** Hands the owner an event; an ended connection has none left to take. */
  function deliver(event: ConnectionEvent) {
    if (!ended) owner?.actor.send(event)
  }

  /** Opens a transport as the live one; settles once its socket is open. */
  function openTransport() {
    const opened = Promise.withResolvers<void>()
    let closeCode: number | undefined
    const connection = connectAgent
      ? app.connect(connectAgent)
      : app.connect(
          loggedStream(
            trackedInbound(
              createWebSocketStream<AnyWireMessage>(
                options.url ?? acpSocketUrl(AOS_ACP_OPERATOR_PATH),
                {
                  WebSocket: observedSocket(
                    options.socketConstructor ?? globalThis.WebSocket,
                    () => opened.resolve(),
                    (code) => {
                      closeCode = code
                    }
                  ),
                }
              ),
              onInbound
            ),
            logger
          )
        )
    // In-process pairing has no socket to wait for.
    if (connectAgent) opened.resolve()
    const transport = { connection, ready: handshake(connection) }
    // Whoever waits on the handshake hears its failure; the owner hears of
    // the close that causes it.
    void transport.ready.catch(() => {})
    live = transport
    const onClosed = () => {
      if (live !== transport) return
      live = undefined
      deliver({ type: "closed", code: closeCode })
    }
    void connection.closed.then(onClosed, onClosed)
    return opened.promise
  }

  const actors = {
    open: fromAbortable(() => openTransport()),
    handshake: fromAbortable(() => readyTransport()),
    recover: fromAbortable(() => recover()),
  }
  const connectionSetup = ownerSetup<
    { generation: number; attempt: number },
    ConnectionEvent,
    typeof actors
  >("connection", logger, clock, actors)
  /** Where a closed transport leaves the connection, by its close code. */
  const onTransportClosed = [
    { guard: "inProcess", target: "closed" },
    { guard: "policyViolation", target: "closed" },
    { guard: "tryAgainLater", target: "capacity" },
    { target: "reconnecting" },
  ] as const
  const machine = connectionSetup
    .extend({
      delays: {
        handshake: HANDSHAKE_DEADLINE_MS,
        stable: STABLE_AFTER_MS,
        reconnect: ({ context }) =>
          backoffDelay(context.attempt, RECONNECT_BACKOFF),
        capacity: () =>
          CAPACITY_BACKOFF.minMs +
          Math.floor(
            Math.random() * (CAPACITY_BACKOFF.maxMs - CAPACITY_BACKOFF.minMs)
          ),
      },
      guards: {
        // In-process pairing has no transport to reopen.
        inProcess: () => connectAgent !== undefined,
        policyViolation: ({ event }) =>
          event.type === "closed" && event.code === POLICY_VIOLATION,
        tryAgainLater: ({ event }) =>
          event.type === "closed" && event.code === TRY_AGAIN_LATER,
      },
      actions: {
        // A handshake or replay that cannot complete leaves an unusable
        // transport; closing it recovers as a dropped one does.
        closeTransport: () => live?.connection.close(),
        markReady: () => setStatus("ready"),
        lose: (
          _,
          { status: next }: { status: "reconnecting" | "capacity" }
        ) => {
          recovering = true
          joinable = false
          setStatus(next)
          for (const open of sessions.values())
            open.owner?.actor.send({ type: "lost" })
        },
        countAttempt: connectionSetup.assign({
          attempt: ({ context }) => context.attempt + 1,
        }),
        resetAttempts: connectionSetup.assign({ attempt: 0 }),
      },
    })
    .createMachine({
      context: { generation: 0, attempt: 0 },
      initial: "connecting",
      on: { close: ".closed" },
      states: {
        connecting: {
          entry: "bumpGeneration",
          invoke: { src: "open", onDone: "handshaking" },
          on: { closed: onTransportClosed },
          after: { handshake: { actions: "closeTransport" } },
        },
        handshaking: {
          invoke: {
            src: "handshake",
            onDone: "ready",
            onError: { actions: "closeTransport" },
          },
          on: { closed: onTransportClosed },
          after: { handshake: { actions: "closeTransport" } },
        },
        ready: {
          entry: "markReady",
          // Every Session rejoined, or a transport up long enough, starts the
          // backoff over.
          invoke: {
            src: "recover",
            onDone: { actions: "resetAttempts" },
            onError: { actions: "closeTransport" },
          },
          on: { closed: onTransportClosed },
          after: { stable: { actions: "resetAttempts" } },
        },
        reconnecting: {
          meta: { log: "info" },
          entry: { type: "lose", params: { status: "reconnecting" } },
          after: {
            reconnect: { target: "connecting", actions: "countAttempt" },
          },
        },
        // The proxy is full: the wait is long, and the status says why.
        capacity: {
          meta: { log: "info" },
          entry: { type: "lose", params: { status: "capacity" } },
          after: { capacity: "connecting" },
        },
        closed: { type: "final", meta: { log: "info" } },
      },
    })

  const sessionActors = {
    join: fromAbortable((signal, sessionId: string) =>
      joinOnce(sessionId, signal)
    ),
  }
  const sessionOwnerSetup = ownerSetup<
    { generation: number; attempt: number; sessionId: string },
    SessionEvent,
    typeof sessionActors
  >("session-owner", logger, clock, sessionActors)
  const sessionSetup = sessionOwnerSetup.extend({
    delays: {
      retry: ({ context }) => backoffDelay(context.attempt, RECONNECT_BACKOFF),
    },
    guards: {
      replayOwed: ({ context }) =>
        sessions.get(context.sessionId)?.replayOwed === true,
      transportLost: () => status !== "ready",
    },
    actions: {
      oweReplay: ({ context }) => {
        const open = sessions.get(context.sessionId)
        if (open) open.replayOwed = true
      },
      countAttempt: sessionOwnerSetup.assign({
        attempt: ({ context }) => context.attempt + 1,
      }),
      resetAttempts: sessionOwnerSetup.assign({ attempt: 0 }),
    },
  })

  /**
   * One opened Session's owner. It joins while the transport is ready, waits
   * out a refused join on its own backoff, rejoins after a reconnect, and
   * ends for good once the provider reports the Session gone.
   */
  function sessionMachine(
    sessionId: string,
    initial: "joining" | "joined" | "detached"
  ) {
    return sessionSetup.createMachine({
      context: { generation: 0, attempt: 0, sessionId },
      initial,
      on: { replay: { actions: "oweReplay" }, gone: ".gone" },
      states: {
        joining: {
          entry: "bumpGeneration",
          invoke: {
            src: "join",
            input: ({ context }) => context.sessionId,
            onDone: [
              { guard: "replayOwed", target: "joining", reenter: true },
              { target: "joined", actions: "resetAttempts" },
            ],
            onError: [
              { guard: ({ event }) => isGone(event.error), target: "gone" },
              { guard: "transportLost", target: "detached" },
              { target: "unavailable" },
            ],
          },
          on: { lost: "detached" },
        },
        joined: {
          on: {
            lost: "detached",
            replay: { target: "joining", actions: "oweReplay" },
          },
        },
        unavailable: {
          meta: { log: "info" },
          after: { retry: { target: "joining", actions: "countAttempt" } },
          on: { lost: "detached" },
        },
        detached: { on: { ready: "joining" } },
        gone: { type: "final", meta: { log: "info" } },
      },
    })
  }

  /**
   * Opens the transport, once. Creating a connection performs no I/O, so a
   * render React discards leaves no socket behind, and a closed connection
   * stays closed. Recovery after a close belongs to the owner.
   */
  function start() {
    if (started || ended) return
    started = true
    // Dev builds only: Rollup drops this branch, and the inspector with it, in
    // production. An inspector that cannot load leaves the owner uninspected.
    if (
      import.meta.env.DEV &&
      acpDebugEnabled(
        globalThis.location?.search ?? "",
        globalThis.sessionStorage
      )
    )
      inspecting = import("@statelyai/inspect")
        .then(({ createBrowserInspector }) => createBrowserInspector().inspect)
        .catch(() => undefined)
        .then(openOwner)
    else openOwner(undefined)
  }

  function openOwner(inspect: Parameters<typeof createOwner>[1]["inspect"]) {
    if (ended) return
    owner = createOwner(machine, { logger, clock, bindings: {}, inspect })
    owner.stack.defer(shutdown)
    const handleVisibilityChange = () => {
      if (globalThis.document?.visibilityState === "hidden") {
        // Disarm while hidden; the page becoming visible probes at once.
        clock.clearTimeout(silenceTimer)
        silenceTimer = undefined
      } else if (status === "ready") {
        sendLivenessProbeAsync()
      }
    }
    const handleOnline = () => {
      if (status === "ready") sendLivenessProbeAsync()
    }
    globalThis.document?.addEventListener("visibilitychange", handleVisibilityChange)
    ;(globalThis as unknown as EventTarget).addEventListener("online", handleOnline)
    owner.stack.defer(() => {
      clock.clearTimeout(silenceTimer)
      silenceTimer = undefined
      globalThis.document?.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
      )
      ;(globalThis as unknown as EventTarget).removeEventListener(
        "online",
        handleOnline
      )
    })
  }

  /** Ends the connection for good: nothing reconnects, and every waiter fails. */
  function shutdown() {
    if (ended) return
    ended = true
    setStatus("closed")
    failInitialized?.(new Error("The ACP connection closed"))
    failInitialized = undefined
    settleInitialized = undefined
    for (const open of sessions.values()) {
      clock.clearTimeout(open.grace)
      open.owner?.dispose()
      open.waiters?.reject(new Error("The ACP connection closed"))
    }
    sessions.clear()
    live?.connection.close()
    live = undefined
  }

  function closeConnection() {
    if (owner) deliver({ type: "close" })
    else shutdown()
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
      const { sessionId } = await request("short", (agent, options) =>
        agent.request(
          methods.agent.session.new,
          { cwd: SERVER_OWNED_CWD, _meta: { [AOS_META_KEY]: meta } },
          options
        )
      )
      owners.set(sessionId, meta.agentId)
      // It parts in its grace unless a listener comes to it.
      if (!sessions.has(sessionId)) {
        const open = openSession(sessionId, [], true)
        open.grace = clock.setTimeout(
          () => part(sessionId, open),
          PART_GRACE_MS
        )
      }
      return { sessionId }
    },

    async listSessions(meta, cursor) {
      const response = await request("short", (agent, options) =>
        agent.request(
          methods.agent.session.list,
          {
            ...(cursor === undefined ? {} : { cursor }),
            _meta: { [AOS_META_KEY]: meta },
          },
          options
        )
      )
      return {
        sessions: response.sessions,
        ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
      }
    },

    subscribe,
    joined,
    replay,
    sessionState: (sessionId) => sessions.get(sessionId)?.state,
    resumePage,
    history: (sessionId) => sessions.get(sessionId)?.history,

    async prompt(sessionId, blocks: ContentBlock[], meta) {
      const response = await write(sessionId, "long", (agent, options) =>
        agent.request(
          methods.agent.session.prompt,
          { sessionId, prompt: blocks, _meta: { [AOS_META_KEY]: meta } },
          options
        )
      )
      return AosPromptResponseMetaSchema.parse(aosMetaOf(response._meta))
    },

    cancel(sessionId) {
      notifyAgent(
        (agent) => agent.notify(methods.agent.session.cancel, { sessionId }),
        sessionId
      )
    },

    async setConfigOption(sessionId, configId, value) {
      const response = await write(sessionId, "medium", (agent, options) =>
        agent.request(
          methods.agent.session.setConfigOption,
          { sessionId, configId, type: "id", value },
          options
        )
      )
      return response.configOptions
    },

    async deleteSession(sessionId) {
      await request("short", (agent, options) =>
        agent.request(methods.agent.session.delete, { sessionId }, options)
      )
    },

    async updateSession(update) {
      await request("short", (agent, options) =>
        agent.request(AOS_METHODS.session.update, update, options)
      )
    },

    async steer(steer) {
      return AosSteerResponseSchema.parse(
        await write(steer.sessionId, "medium", (agent, options) =>
          agent.request(AOS_METHODS.session.steer, steer, options)
        )
      )
    },

    focus(sessionId, presence) {
      const report = {
        sessionId,
        foreground: presence.foreground,
        idle: presence.idle,
      }
      lastFocus = report
      // The focus request is also the liveness probe: no reply in 10 s closes
      // the transport, and the reconnect re-reports it via sendLivenessProbeAsync.
      request("probe", (agent, options) =>
        agent.request(AOS_METHODS.session.focus, report, options)
      ).catch((err: unknown) => {
        logger.debug({ err }, "acp.focus.failed")
      })
    },

    async listAgents() {
      return AosAgentsListResponseSchema.parse(
        await request("short", (agent, options) =>
          agent.request(AOS_METHODS.agents.list, undefined, options)
        )
      )
    },

    async setVisibility(visibility) {
      return AosSetVisibilityResponseSchema.parse(
        await request("short", (agent, options) =>
          agent.request(AOS_METHODS.agents.setVisibility, visibility, options)
        )
      )
    },

    subscribeNotification: (method, listener) =>
      subscribeKeyed(notificationListeners, method, listener),
    subscribePendingRequests: (listener) =>
      subscribeTo(pendingListeners, listener),

    close: closeConnection,
  }
}
