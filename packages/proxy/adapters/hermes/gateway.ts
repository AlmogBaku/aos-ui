/**
 * The AOS side of the Hermes JSON-RPC gateway connection.
 *
 * `HermesGateway` is a thin wrapper around the vendored upstream
 * `JsonRpcGatewayClient` (`vendor/hermes-shared/`). The vendored client owns
 * request correlation, per-call timeouts and `AbortSignal`, JSON-RPC error
 * typing, the `gateway.ping` heartbeat, socket generations and server→client
 * request routing; none of that is re-implemented here.
 *
 * This wrapper owns only what upstream leaves to its embedder:
 *
 *  - the dial URL and the private server token (never logged, never surfaced);
 *  - an eager dial plus redial with the vendored reconnect backoff, forever;
 *  - the heal grace window before a loss is reported to connection handlers;
 *  - stopping every redial after an authentication rejection;
 *  - the wire guard (`gateway-socket.ts`) and a per-request response bound;
 *  - sanitized three-way error classification (rejected / uncertain /
 *    unavailable) plus caller aborts;
 *  - one event fan-out that survives every redial;
 *  - replay-epoch change detection;
 *  - `close()`.
 */

import {
  isGatewayWebSocketUrl,
  JsonRpcGatewayClient,
  type ConnectionState,
  type GatewayEvent,
} from "./vendor/hermes-shared/json-rpc-gateway"
import {
  JsonRpcGatewayError,
  type ServerRequest,
  type ServerRequestHandler,
} from "./vendor/hermes-shared/json-rpc-channel"
import {
  reconnectBackoffDelayMs,
  type ReconnectBackoffOptions,
} from "./vendor/hermes-shared/reconnect-backoff"
import {
  createHermesHttp,
  normalizeBaseUrl,
  responseLimit,
  withinDeadline,
  type HermesCredentials,
  type HermesHttp,
  type HermesHttpInit,
} from "./http"
import {
  guardedHermesSocket,
  MAX_SOCKET_FRAME_BYTES,
  type HermesLog,
  type HermesSocket,
} from "./gateway-socket"

export {
  HermesAuthenticationError,
  HermesHttpError,
  type HermesCredentials,
} from "./http"
export type { HermesLog, HermesSocket } from "./gateway-socket"
export type { ServerRequest, ServerRequestHandler }

import { HermesAuthenticationError } from "./http"

/** Hermes authoritatively rejected a dispatched JSON-RPC request. */
export class HermesRpcRejectedError extends Error {
  constructor(readonly code?: number) {
    super("Hermes RPC request was rejected")
    this.name = "HermesRpcRejectedError"
  }
}

/** The JSON-RPC mutation was written to the socket but no result was known. */
export class HermesRpcUncertainError extends Error {
  constructor() {
    super("Hermes connection failed")
    this.name = "HermesRpcUncertainError"
  }
}

/** Nothing was written: no open socket, a failed dial, or an unusable reply. */
export class HermesUnavailableError extends Error {
  constructor() {
    super("Hermes is temporarily unavailable")
    this.name = "HermesUnavailableError"
  }
}

/** The caller's `AbortSignal` aborted the request. */
export class HermesRequestAbortedError extends Error {
  constructor() {
    super("Hermes request was aborted")
    this.name = "HermesRequestAbortedError"
  }
}

export type HermesRpcOptions = {
  timeoutMs?: number
  signal?: AbortSignal
  maxResponseBytes?: number
}

export type HermesConnectionHandler = {
  /** The socket is open again; resolve before dependent work continues. */
  restored?(): Promise<void> | void
  /** The socket stayed closed past the heal grace window. */
  lost?(): void
  /** Hermes restarted: its replay epoch changed. */
  epochChanged?(): void
}

export interface HermesRpcTransport {
  request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options?: HermesRpcOptions
  ): Promise<unknown>
  http?(path: string, init?: HermesHttpInit): Promise<unknown>
  onEvent?(listener: (event: unknown) => void): () => void
  onRequest?(handler: ServerRequestHandler): () => void
  onConnection?(handler: HermesConnectionHandler): () => void
  /** @deprecated Superseded by `onEvent` + `onConnection`; removed in C3. */
  observeEvents?(
    listener: (event: unknown) => void,
    disconnected: (error?: Error) => void
  ): Promise<() => void>
  close?(): Promise<void>
}

export type HermesGatewayOptions = {
  baseUrl: string
  credentials: HermesCredentials
  fetcher?: typeof fetch
  socketFactory?: (url: string) => HermesSocket
  /** Deadline for one native REST call (default 15 s). */
  timeoutMs?: number
  /** Deadline for one JSON-RPC call (default 15 s). */
  requestTimeoutMs?: number
  /** Deadline for one dial, and for a caller waiting on one (default 15 s). */
  connectTimeoutMs?: number
  /** Grace before a socket loss is reported as lost (default 20 s). */
  healGraceMs?: number
  heartbeatIntervalMs?: number
  heartbeatDeadlineMs?: number
  backoff?: ReconnectBackoffOptions
  log?: HermesLog
}

/** Shared by `createRequestId`; the vendored default builder is never used. */
const REQUEST_ID_PREFIX = "aos-"
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
/** Hermes' own orphan-reap grace: past this the Session is treated as lost. */
const DEFAULT_HEAL_GRACE_MS = 20_000
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_IN_FLIGHT_REQUESTS = 256
/**
 * WebSocket close codes Hermes is expected to use when it refuses the token.
 * Unverified against a live server; a live check may add or replace them.
 */
const AUTH_CLOSE_CODES = new Set([4401, 4403])

// Private sentinels: the vendored client puts these in the `Error` it rejects
// with, so classification can compare by message. They are mapped to a typed
// AOS error before any caller sees them and are never logged.
const NOT_CONNECTED = "aos-gateway:not-connected"
const GENERATION_CLOSED = "aos-gateway:generation-closed"
const CONNECT_FAILED = "aos-gateway:connect-failed"

function webSocketUrl(baseUrl: string, token: string) {
  const url = new URL(`${baseUrl}/api/ws`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("token", token)
  return url.toString()
}

function isAbort(error: unknown) {
  // The vendored channel rejects with a `DOMException`, which is not an
  // `Error` instance on every runtime AOS supports.
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  )
}

/** The only error detail that may be logged: never a message, path or token. */
function publicReason(error: unknown) {
  return error instanceof Error ? error.name : "unknown"
}

export class HermesGateway implements HermesRpcTransport {
  readonly #baseUrl: string
  readonly #credentials: HermesCredentials
  readonly #socketFactory: (url: string) => HermesSocket
  readonly #client: JsonRpcGatewayClient
  readonly #httpClient: HermesHttp
  readonly #log: HermesLog | undefined
  readonly #requestTimeoutMs: number
  readonly #connectTimeoutMs: number
  readonly #healGraceMs: number
  readonly #backoff: ReconnectBackoffOptions | undefined
  readonly #eventListeners = new Set<(event: unknown) => void>()
  readonly #connectionHandlers = new Set<HermesConnectionHandler>()
  readonly #openWaiters = new Set<{
    resolve(): void
    reject(error: Error): void
  }>()
  readonly #inFlightById = new Map<
    string,
    { limit: number; reject(error: Error): void }
  >()
  readonly #loggedRequestMethods = new Set<string>()
  #pendingRegistration:
    { limit: number; reject(error: Error): void } | undefined
  #mintedRequestId: string | undefined
  #removeDefaultRequestHandler: (() => void) | undefined
  #requestHandlerCount = 0
  #inFlight = 0
  /** Identity of the socket generation currently dialled or open. */
  #generation: object | undefined
  #dialFailureLogged = false
  #dial: Promise<void> | undefined
  #redialTimer: ReturnType<typeof setTimeout> | undefined
  #healTimer: ReturnType<typeof setTimeout> | undefined
  #attempt = 0
  #lostAnnounced = false
  #authFailed = false
  #closed = false
  #epoch: string | undefined

  constructor(options: HermesGatewayOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl)
    this.#credentials = options.credentials
    this.#log = options.log
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.#healGraceMs = options.healGraceMs ?? DEFAULT_HEAL_GRACE_MS
    this.#backoff = options.backoff
    this.#socketFactory =
      options.socketFactory ??
      ((url: string) => new WebSocket(url) as unknown as HermesSocket)
    this.#httpClient = createHermesHttp({
      baseUrl: this.#baseUrl,
      credentials: options.credentials,
      fetcher: options.fetcher,
      timeoutMs: options.timeoutMs,
    })
    this.#client = new JsonRpcGatewayClient({
      requestTimeoutMs: this.#requestTimeoutMs,
      connectTimeoutMs: this.#connectTimeoutMs,
      // `run.ts` owns native replay: it needs the cursor, epoch and truncation
      // flag the vendored best-effort resume discards.
      replay: false,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      heartbeatDeadlineMs: options.heartbeatDeadlineMs,
      notConnectedErrorMessage: NOT_CONNECTED,
      closedErrorMessage: GENERATION_CLOSED,
      connectErrorMessage: CONNECT_FAILED,
      createRequestId: (nextId) => this.#mintRequestId(nextId),
      onSocketClose: (event) => this.#onSocketClose(event),
      socketFactory: (url) => this.#createSocket(url),
    })
    this.#client.onState((state) => this.#onState(state))
    this.#client.onAny((event) => this.#onGatewayEvent(event))
    this.#removeDefaultRequestHandler = this.#client.onRequest((request) =>
      this.#claimUnhandledRequest(request)
    )
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  /**
   * Dial Hermes. Joins an in-flight dial; an explicit call also clears a
   * previous authentication stop so a rotated token can be picked up.
   */
  async connect(): Promise<void> {
    if (this.#closed) throw new HermesUnavailableError()
    const existing = this.#dial
    if (existing) return existing
    this.#authFailed = false
    const dial = this.#dialOnce()
    this.#dial = dial
    try {
      await dial
    } catch (error) {
      // An authentication failure is definitive: waiting callers learn it now
      // instead of sitting out the connect deadline, and nothing is redialled.
      if (error instanceof HermesAuthenticationError)
        this.#failOpenWaiters(error)
      else this.#scheduleRedial()
      throw error
    } finally {
      if (this.#dial === dial) this.#dial = undefined
    }
  }

  async #dialOnce(): Promise<void> {
    const token = await this.#serverToken()
    const url = webSocketUrl(this.#baseUrl, token)
    // Pre-check with the vendored guard so its own `invalidUrl()` message —
    // which embeds the URL, and therefore the token — is unreachable.
    if (!isGatewayWebSocketUrl(url)) throw new HermesUnavailableError()
    if (this.#closed) throw new HermesUnavailableError()
    try {
      await this.#client.connect(url)
    } catch (error) {
      if (this.#authFailed) throw new HermesAuthenticationError()
      // The redial ladder runs forever at the cap: log the outage, not every
      // rung of it. The next successful open re-arms this.
      if (!this.#dialFailureLogged) {
        this.#dialFailureLogged = true
        this.#log?.warn("hermes.gateway.dial_failed", {
          reason: publicReason(error),
        })
      }
      throw new HermesUnavailableError()
    }
    if (this.#closed) {
      // close() landed while the handshake was in flight: drop the generation
      // so a late open cannot publish anything.
      this.#client.invalidate(GENERATION_CLOSED)
      throw new HermesUnavailableError()
    }
  }

  async #serverToken() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#connectTimeoutMs)
    try {
      const headers = await withinDeadline(
        () => this.#credentials(controller.signal),
        controller.signal
      )
      const token = headers["X-Hermes-Session-Token"]
      if (
        typeof token !== "string" ||
        token.length < 1 ||
        token.length > 4096 ||
        /[\0\r\n]/u.test(token)
      )
        throw new HermesAuthenticationError()
      return token
    } catch (error) {
      if (error instanceof HermesAuthenticationError) throw error
      throw new HermesUnavailableError()
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Wrap one dialled socket. A real WebSocket still dispatches frames that were
   * already queued when it was abandoned, so every guard callback is gated on
   * this socket still being the current generation: a late unreadable frame
   * from a dropped socket must not invalidate the healthy socket that replaced
   * it, nor fail a request id the replacement reused.
   */
  #createSocket(url: string) {
    const raw = this.#socketFactory(url)
    const generation = {}
    this.#generation = generation
    const current = () => this.#generation === generation
    return guardedHermesSocket(raw, {
      log: this.#log,
      responseLimit: (id) =>
        current() ? this.#inFlightById.get(id)?.limit : undefined,
      onOversizedResponse: (id) => {
        if (current()) this.#failOversizedResponse(id)
      },
      onFault: () => {
        if (current()) this.#client.invalidate(GENERATION_CLOSED)
      },
    }) as unknown as WebSocket
  }

  #onSocketClose(event: { code: number }): boolean {
    if (AUTH_CLOSE_CODES.has(event.code)) {
      this.#authFailed = true
      this.#log?.warn("hermes.gateway.authentication_rejected", {
        close_code: event.code,
      })
    }
    // Never intercept: the vendored client drops the generation and reports
    // `closed`, which is what arms the heal grace and the redial below.
    return false
  }

  #onState(state: ConnectionState) {
    if (this.#closed) return
    if (state === "open") {
      this.#attempt = 0
      this.#lostAnnounced = false
      this.#dialFailureLogged = false
      this.#clearTimer("heal")
      this.#resolveOpenWaiters()
      void this.#notifyRestored()
      return
    }
    if (state !== "closed" && state !== "error") return
    this.#armHealGrace()
    this.#scheduleRedial()
  }

  #armHealGrace() {
    if (this.#healTimer !== undefined || this.#lostAnnounced) return
    this.#healTimer = setTimeout(() => {
      this.#healTimer = undefined
      if (this.#closed || this.#client.connectionState === "open") return
      this.#lostAnnounced = true
      for (const handler of [...this.#connectionHandlers]) {
        try {
          handler.lost?.()
        } catch (error) {
          this.#log?.warn("hermes.gateway.handler_failed", {
            phase: "lost",
            reason: publicReason(error),
          })
        }
      }
    }, this.#healGraceMs)
  }

  #scheduleRedial() {
    if (this.#closed || this.#authFailed || this.#redialTimer !== undefined)
      return
    const delay = reconnectBackoffDelayMs(this.#attempt, this.#backoff)
    this.#attempt += 1
    this.#redialTimer = setTimeout(() => {
      this.#redialTimer = undefined
      if (this.#closed || this.#authFailed || this.#dial) return
      if (this.#client.connectionState === "open") return
      void this.connect().catch(() => undefined)
    }, delay)
  }

  async #notifyRestored() {
    for (const handler of [...this.#connectionHandlers]) {
      try {
        await handler.restored?.()
      } catch (error) {
        this.#log?.warn("hermes.gateway.handler_failed", {
          phase: "restored",
          reason: publicReason(error),
        })
      }
    }
  }

  #onGatewayEvent(event: GatewayEvent) {
    if (this.#closed) return
    if (event.type === "gateway.ready") this.#observeEpoch(event)
    for (const listener of [...this.#eventListeners]) {
      try {
        listener(event)
      } catch (error) {
        this.#log?.warn("hermes.gateway.handler_failed", {
          phase: "event",
          reason: publicReason(error),
        })
      }
    }
  }

  #observeEpoch(event: GatewayEvent) {
    const epoch = (event as GatewayEvent<"gateway.ready">).payload?.replay_epoch
    if (typeof epoch !== "string" || !epoch) return
    if (this.#epoch === undefined) {
      this.#epoch = epoch
      return
    }
    if (this.#epoch === epoch) return
    this.#epoch = epoch
    this.#log?.warn("hermes.gateway.replay_epoch_changed", {})
    for (const handler of [...this.#connectionHandlers]) {
      try {
        handler.epochChanged?.()
      } catch (error) {
        this.#log?.warn("hermes.gateway.handler_failed", {
          phase: "epoch",
          reason: publicReason(error),
        })
      }
    }
  }

  /**
   * Resolve once a socket is open, joining an in-flight dial. Nothing has been
   * written yet, so the connect deadline reports unavailable and the caller's
   * `AbortSignal` reports an abort immediately instead of waiting that deadline
   * out.
   */
  #awaitOpen(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new HermesRequestAbortedError())
    if (this.#closed) return Promise.reject(new HermesUnavailableError())
    if (this.#client.connectionState === "open") return Promise.resolve()
    if (this.#authFailed) return Promise.reject(new HermesAuthenticationError())
    if (!this.#dial && this.#redialTimer === undefined)
      void this.connect().catch(() => undefined)
    return new Promise<void>((resolve, reject) => {
      let settled = false
      // Only ever called from a later task, so the deadline timer below is
      // already bound by the time any of these run.
      const finish = (complete: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#openWaiters.delete(waiter)
        signal?.removeEventListener("abort", onAbort)
        complete()
      }
      const waiter = {
        resolve: () => finish(resolve),
        reject: (error: Error) => finish(() => reject(error)),
      }
      const onAbort = () => waiter.reject(new HermesRequestAbortedError())
      const timer = setTimeout(
        () => waiter.reject(new HermesUnavailableError()),
        this.#connectTimeoutMs
      )
      this.#openWaiters.add(waiter)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  #resolveOpenWaiters() {
    for (const waiter of [...this.#openWaiters]) waiter.resolve()
  }

  #failOpenWaiters(error: Error) {
    for (const waiter of [...this.#openWaiters]) waiter.reject(error)
  }

  #clearTimer(kind: "heal" | "redial") {
    const timer = kind === "heal" ? this.#healTimer : this.#redialTimer
    if (timer !== undefined) clearTimeout(timer)
    if (kind === "heal") this.#healTimer = undefined
    else this.#redialTimer = undefined
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  async request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: HermesRpcOptions = {}
  ): Promise<unknown> {
    if (this.#closed) throw new HermesUnavailableError()
    if (this.#authFailed) throw new HermesAuthenticationError()
    if (this.#inFlight >= MAX_IN_FLIGHT_REQUESTS)
      throw new HermesUnavailableError()
    let limit: number
    try {
      limit = responseLimit(
        options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        MAX_SOCKET_FRAME_BYTES
      )
    } catch {
      throw new HermesUnavailableError()
    }
    this.#inFlight += 1
    try {
      await this.#awaitOpen(options.signal)
      let rejectOversized!: (error: Error) => void
      const oversized = new Promise<never>((_resolve, reject) => {
        rejectOversized = reject
      })
      this.#pendingRegistration = { limit, reject: rejectOversized }
      this.#mintedRequestId = undefined
      let pending: Promise<unknown>
      try {
        pending = this.#client.request(
          method,
          { ...params },
          options.timeoutMs ?? this.#requestTimeoutMs,
          options.signal
        )
      } finally {
        this.#pendingRegistration = undefined
      }
      const id = this.#mintedRequestId
      this.#mintedRequestId = undefined
      try {
        // The oversized race settles only from the wire guard; the vendored
        // pending entry then expires on its own timeout, and `Promise.race`
        // has already claimed that rejection.
        return await (id === undefined
          ? pending
          : Promise.race([pending, oversized]))
      } finally {
        if (id !== undefined) this.#inFlightById.delete(id)
      }
    } catch (error) {
      throw this.#classify(error)
    } finally {
      this.#inFlight -= 1
    }
  }

  #mintRequestId(nextId: number) {
    const id = `${REQUEST_ID_PREFIX}${nextId}`
    const registration = this.#pendingRegistration
    if (registration) {
      this.#inFlightById.set(id, registration)
      this.#mintedRequestId = id
    }
    return id
  }

  #failOversizedResponse(id: string) {
    const entry = this.#inFlightById.get(id)
    if (!entry) return
    this.#inFlightById.delete(id)
    entry.reject(new HermesUnavailableError())
  }

  #classify(error: unknown): Error {
    if (
      error instanceof HermesAuthenticationError ||
      error instanceof HermesUnavailableError ||
      error instanceof HermesRpcUncertainError ||
      error instanceof HermesRpcRejectedError ||
      error instanceof HermesRequestAbortedError
    )
      return error
    if (error instanceof JsonRpcGatewayError)
      return new HermesRpcRejectedError(
        Number.isSafeInteger(error.code) ? error.code : undefined
      )
    if (isAbort(error)) return new HermesRequestAbortedError()
    // Nothing was written: the generation was gone before the send.
    if (error instanceof Error && error.message === NOT_CONNECTED)
      return new HermesUnavailableError()
    // Written, outcome unknown: timeout, dropped generation, send failure.
    return new HermesRpcUncertainError()
  }

  http(path: string, init?: HermesHttpInit): Promise<unknown> {
    return this.#httpClient.http(path, init)
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  /** One vendored `onAny` subscription fans out to every listener, forever. */
  onEvent(listener: (event: unknown) => void): () => void {
    this.#eventListeners.add(listener)
    return () => this.#eventListeners.delete(listener)
  }

  onRequest(handler: ServerRequestHandler): () => void {
    this.#requestHandlerCount += 1
    const remove = this.#client.onRequest(handler)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      this.#requestHandlerCount -= 1
      remove()
    }
  }

  onConnection(handler: HermesConnectionHandler): () => void {
    this.#connectionHandlers.add(handler)
    return () => this.#connectionHandlers.delete(handler)
  }

  /**
   * Claim every server→client request while no real handler is registered so
   * the vendored channel does not answer `-32601` on AOS' behalf, which would
   * silently resolve a native `clarify` as "skipped". Hermes waits out its own
   * request deadline instead — today's behaviour. Interactions replaces this.
   */
  #claimUnhandledRequest(request: ServerRequest): boolean {
    if (this.#requestHandlerCount > 0) return false
    if (!this.#loggedRequestMethods.has(request.method)) {
      this.#loggedRequestMethods.add(request.method)
      this.#log?.warn("hermes.gateway.server_request_unanswered", {
        method: request.method,
      })
    }
    return true
  }

  /** Drop the claim-and-hold handler once a real handler owns requests. */
  removeDefaultRequestHandler(): void {
    this.#removeDefaultRequestHandler?.()
    this.#removeDefaultRequestHandler = undefined
  }

  /**
   * @deprecated Compatibility shim for `adapter.ts` and
   * `attachment-registry.ts`; removed in C3 in favour of `onEvent` +
   * `onConnection`.
   */
  async observeEvents(
    listener: (event: unknown) => void,
    disconnected: (error?: Error) => void
  ): Promise<() => void> {
    const stopEvents = this.onEvent(listener)
    const stopConnection = this.onConnection({
      lost: () => disconnected(new HermesRpcUncertainError()),
    })
    return () => {
      stopEvents()
      stopConnection()
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#clearTimer("heal")
    this.#clearTimer("redial")
    this.removeDefaultRequestHandler()
    this.#failOpenWaiters(new HermesUnavailableError())
    this.#eventListeners.clear()
    this.#connectionHandlers.clear()
    this.#client.close()
  }
}
