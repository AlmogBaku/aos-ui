/**
 * The AOS side of the Hermes JSON-RPC gateway connection. The vendored
 * `JsonRpcGatewayClient` (`vendor/hermes-shared/`) owns correlation, per-call
 * timeouts and `AbortSignal`, JSON-RPC error typing, the `gateway.ping`
 * heartbeat, socket generations and server→client request routing; this wrapper
 * owns the dial URL and private token, redial and heal grace, the wire guard and
 * response bounds, error classification, one event fan-out, epoch changes and
 * `close()`.
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
  HermesAuthenticationError,
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
import { publicReason } from "./native"

export {
  HermesAuthenticationError,
  HermesHttpError,
  type HermesCredentials,
} from "./http"
export type { HermesLog, HermesSocket } from "./gateway-socket"
export type { ServerRequest, ServerRequestHandler }

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

/**
 * An authentication rejection is definitive and keeps its type; every other
 * native failure is an outage the caller must not present as a refusal.
 */
export function throwUnavailable(error: unknown): never {
  if (error instanceof HermesAuthenticationError) throw error
  throw new HermesUnavailableError()
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
  close?(): Promise<void>
}

export type HermesGatewayOptions = {
  baseUrl: string
  credentials: HermesCredentials
  fetcher?: typeof fetch
  socketFactory?: (url: string) => HermesSocket
  /** Deadline for one JSON-RPC call (default 15 s). */
  requestTimeoutMs?: number
  /** Deadline for one dial, and for a caller waiting on one (default 15 s). */
  connectTimeoutMs?: number
  /** Grace before a socket loss is reported as lost (default 20 s). */
  healGraceMs?: number
  backoff?: ReconnectBackoffOptions
  log?: HermesLog
}

/** A caller parked in `#awaitOpen` until a socket is open. */
type OpenWaiter = { resolve(): void; reject(error: Error): void }

/** One dispatched request: its response bound and its oversized rejector. */
type PendingResponse = {
  limit: number
  id?: string
  reject(error: Error): void
}

const REQUEST_ID_PREFIX = "aos-"
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
/** Hermes' own orphan-reap grace: past this the Session is treated as lost. */
const DEFAULT_HEAL_GRACE_MS = 20_000
/** How long a generation may take to announce its epoch in `gateway.ready`. */
const READY_EPOCH_WAIT_MS = 2_000
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_IN_FLIGHT_REQUESTS = 256
/** Bound for the unanswered-server-request log: Hermes chooses the method. */
const MAX_LOGGED_REQUEST_METHODS = 32
const MAX_LOGGED_METHOD_CHARS = 64
/** Close codes Hermes refuses a token with; unverified against a live server. */
const AUTH_CLOSE_CODES = new Set([4401, 4403])

// Private sentinels the vendored client rejects with, so classification can
// compare by message. Mapped to a typed AOS error before any caller sees them.
const NOT_CONNECTED = "aos-gateway:not-connected"
const GENERATION_CLOSED = "aos-gateway:generation-closed"
const CONNECT_FAILED = "aos-gateway:connect-failed"

/** A token that cannot break the dial URL it is a query parameter of. */
function isServerToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 4096 &&
    !/[\0\r\n]/u.test(value)
  )
}

function webSocketUrl(baseUrl: string, token: string) {
  const url = new URL(`${baseUrl}/api/ws`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("token", token)
  return url.toString()
}

function isAbort(error: unknown) {
  // The vendored channel rejects with a `DOMException`, not always an `Error`.
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  )
}

/**
 * Stand-in for a socket the factory refused to build. The vendored client is
 * already `connecting` and short-circuits every later dial while it stays there,
 * so the refusal has to look like a socket that closes at once: generation
 * dropped, dial rejected, redial ladder free to run again.
 */
function refusedSocket(): HermesSocket {
  const listeners = new Set<(event: unknown) => void>()
  let announced = false
  const announce = () => {
    if (announced) return
    announced = true
    for (const listener of [...listeners]) listener({ code: 1006 })
  }
  return {
    /** `WebSocket.CLOSED`, spelled out so the stub needs no DOM global. */
    readyState: 3,
    addEventListener(type, listener) {
      if (type !== "close") return
      listeners.add(listener)
      queueMicrotask(announce)
    },
    removeEventListener(type, listener) {
      if (type === "close") listeners.delete(listener)
    },
    send() {},
    close() {
      announced = true
    },
  }
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
  readonly #openWaiters = new Set<OpenWaiter>()
  /** Live requests by minted id, so the wire guard can find their bound. */
  readonly #inFlightById = new Map<string, PendingResponse>()
  readonly #loggedRequestMethods = new Set<string>()
  #requestMethodLogCapped = false
  /** The request being dispatched, awaiting the id `#mintRequestId` gives it. */
  #dispatching: PendingResponse | undefined
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
  /** The bounded wait for this generation's first `gateway.ready` frame. */
  #readyWaiter: { settle(changed: boolean): void } | undefined

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
    })
    this.#client = new JsonRpcGatewayClient({
      requestTimeoutMs: this.#requestTimeoutMs,
      connectTimeoutMs: this.#connectTimeoutMs,
      // `run.ts` owns native replay: it needs the cursor, epoch and truncation
      // flag the vendored best-effort resume discards.
      replay: false,
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

  /** Joins an in-flight dial; an explicit call clears an authentication stop. */
  async connect(): Promise<void> {
    if (this.#closed) throw new HermesUnavailableError()
    if (this.#dial) return this.#dial
    this.#authFailed = false
    const dial = this.#dialOnce()
    this.#dial = dial
    try {
      await dial
    } catch (error) {
      // Definitive: parked callers learn it now, and nothing is redialled.
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
    // Pre-checked here so the vendored `invalidUrl()` message, which embeds
    // the URL and therefore the token, is unreachable.
    if (!isGatewayWebSocketUrl(url)) throw new HermesUnavailableError()
    if (this.#closed) throw new HermesUnavailableError()
    try {
      await this.#client.connect(url)
    } catch (error) {
      if (this.#authFailed) throw new HermesAuthenticationError()
      this.#logDialFailure("handshake_failed", error)
      throw new HermesUnavailableError()
    }
    if (this.#closed) {
      // close() landed mid-handshake: a late open must publish nothing.
      this.#client.invalidate(GENERATION_CLOSED)
      throw new HermesUnavailableError()
    }
    // The vendored client resolves a dial it short-circuited, so a resolved
    // `connect()` is no proof of an open socket: fail, and let `connect()`
    // arm the redial ladder.
    if (this.#client.connectionState !== "open")
      throw new HermesUnavailableError()
  }

  /** Read the private server token under the connect deadline; validate it. */
  async #serverToken() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#connectTimeoutMs)
    try {
      const headers = await withinDeadline(
        () => this.#credentials(controller.signal),
        controller.signal
      )
      const token = headers["X-Hermes-Session-Token"]
      if (!isServerToken(token)) throw new HermesAuthenticationError()
      return token
    } catch (error) {
      if (error instanceof HermesAuthenticationError) throw error
      throw new HermesUnavailableError()
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Wrap one dialled socket. A real WebSocket still dispatches frames queued
   * before it was abandoned, so every guard callback is gated on this socket
   * still being the current generation.
   */
  #createSocket(url: string) {
    const generation = {}
    this.#generation = generation
    const current = () => this.#generation === generation
    let raw: HermesSocket
    try {
      raw = this.#socketFactory(url)
    } catch (error) {
      // Its own outage, apart from a handshake Hermes never completed.
      this.#logDialFailure("socket_factory_threw", error)
      return refusedSocket() as unknown as WebSocket
    }
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

  /**
   * The redial ladder runs forever at the cap: log the outage once, not every
   * rung; the next open re-arms this. Only the error type is recorded, because a
   * native message may carry the dial URL and its token.
   */
  #logDialFailure(reason: string, error: unknown) {
    if (this.#dialFailureLogged) return
    this.#dialFailureLogged = true
    this.#log?.warn("hermes.gateway.dial_failed", {
      reason,
      error: publicReason(error),
    })
  }

  #onSocketClose(event: { code: number }): boolean {
    if (AUTH_CLOSE_CODES.has(event.code)) {
      this.#authFailed = true
      this.#log?.warn("hermes.gateway.authentication_rejected", {
        close_code: event.code,
      })
    }
    // Never intercept: the vendored `closed` transition arms heal and redial.
    return false
  }

  #onState(state: ConnectionState) {
    if (this.#closed) return
    if (state === "open") {
      this.#attempt = 0
      this.#lostAnnounced = false
      this.#dialFailureLogged = false
      this.#clearHealGrace()
      // Rebinding first: a parked request must not be written before
      // `restored` handlers have re-registered their Sessions.
      const release = () => this.#resolveOpenWaiters()
      void this.#announceOpen().then(release, release)
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
      this.#notify("lost", (handler) => handler.lost?.())
    }, this.#healGraceMs)
  }

  #clearHealGrace() {
    clearTimeout(this.#healTimer)
    this.#healTimer = undefined
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

  /**
   * Announce a new socket generation once, as a restore or a restart. Hermes
   * reports its replay epoch in the generation's first `gateway.ready` frame, so
   * that frame is briefly awaited first: a restarted Hermes must not have every
   * binding re-resumed only to discard it again. No epoch in time is unchanged.
   */
  async #announceOpen() {
    this.#readyWaiter?.settle(false)
    let resolveVerdict!: (changed: boolean) => void
    const verdict = new Promise<boolean>((resolve) => {
      resolveVerdict = resolve
    })
    // Only ever settled from a later task, so `timer` is already bound.
    const waiter = {
      settle: (changed: boolean) => {
        clearTimeout(timer)
        if (this.#readyWaiter === waiter) this.#readyWaiter = undefined
        resolveVerdict(changed)
      },
    }
    const timer = setTimeout(() => waiter.settle(false), READY_EPOCH_WAIT_MS)
    this.#readyWaiter = waiter
    if (await verdict) this.#notifyEpochChanged()
    else await this.#notifyRestored()
  }

  #notifyEpochChanged() {
    this.#notify("epoch", (handler) => handler.epochChanged?.())
  }

  async #notifyRestored() {
    for (const handler of [...this.#connectionHandlers]) {
      try {
        await handler.restored?.()
      } catch (error) {
        this.#logHandlerFailure("restored", error)
      }
    }
  }

  /** Fan out to every connection handler; one throw never stops the rest. */
  #notify(phase: string, call: (handler: HermesConnectionHandler) => void) {
    for (const handler of [...this.#connectionHandlers]) {
      try {
        call(handler)
      } catch (error) {
        this.#logHandlerFailure(phase, error)
      }
    }
  }

  #logHandlerFailure(phase: string, error: unknown) {
    this.#log?.warn("hermes.gateway.handler_failed", {
      phase,
      reason: publicReason(error),
    })
  }

  #onGatewayEvent(event: GatewayEvent) {
    if (this.#closed) return
    if (event.type === "gateway.ready") this.#observeEpoch(event)
    for (const listener of [...this.#eventListeners]) {
      try {
        listener(event)
      } catch (error) {
        this.#logHandlerFailure("event", error)
      }
    }
  }

  #observeEpoch(event: GatewayEvent) {
    const epoch = (event as GatewayEvent<"gateway.ready">).payload?.replay_epoch
    if (typeof epoch !== "string" || !epoch) return
    const previous = this.#epoch
    this.#epoch = epoch
    const changed = previous !== undefined && previous !== epoch
    if (changed) this.#log?.warn("hermes.gateway.replay_epoch_changed", {})
    // The wait armed by this generation's open owns the verdict, so handlers
    // learn a restart instead of a restore rather than both in turn.
    if (this.#readyWaiter) {
      this.#readyWaiter.settle(changed)
      return
    }
    if (changed) this.#notifyEpochChanged()
  }

  /**
   * Resolve once a socket is open, joining an in-flight dial. Nothing has been
   * written, so the connect deadline reports unavailable, and an abort is
   * reported at once rather than waiting that deadline out.
   */
  #awaitOpen(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new HermesRequestAbortedError())
    if (this.#closed) return Promise.reject(new HermesUnavailableError())
    if (this.#client.connectionState === "open") return Promise.resolve()
    if (this.#authFailed) return Promise.reject(new HermesAuthenticationError())
    if (!this.#dial && this.#redialTimer === undefined)
      void this.connect().catch(() => undefined)
    return new Promise<void>((resolve, reject) => {
      // Only ever called from a later task, so `timer` is already bound.
      // Membership in `#openWaiters` is what settles a waiter exactly once.
      const finish = (complete: () => void) => {
        if (!this.#openWaiters.delete(waiter)) return
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        complete()
      }
      const waiter: OpenWaiter = {
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
      let entry!: PendingResponse
      const oversized = new Promise<never>((_resolve, reject) => {
        entry = { limit, reject }
      })
      this.#dispatching = entry
      let dispatched: Promise<unknown>
      try {
        dispatched = this.#client.request(
          method,
          { ...params },
          options.timeoutMs ?? this.#requestTimeoutMs,
          options.signal
        )
      } finally {
        this.#dispatching = undefined
      }
      try {
        // The oversized race settles only from the wire guard; the vendored
        // entry then expires on its own timeout, already claimed by the race.
        return await (entry.id === undefined
          ? dispatched
          : Promise.race([dispatched, oversized]))
      } finally {
        if (entry.id !== undefined) this.#inFlightById.delete(entry.id)
      }
    } catch (error) {
      throw this.#classify(error)
    } finally {
      this.#inFlight -= 1
    }
  }

  /** Mint the correlation id and bind the dispatching request's byte bound. */
  #mintRequestId(nextId: number) {
    const id = `${REQUEST_ID_PREFIX}${nextId}`
    const entry = this.#dispatching
    if (entry) {
      entry.id = id
      this.#inFlightById.set(id, entry)
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
   * Claim every server→client request while no real handler is registered, so
   * the vendored channel does not answer `-32601` on AOS' behalf and silently
   * resolve a native `clarify` as "skipped"; Hermes waits out its own deadline
   * instead. One log line per distinct method, bounded and truncated because
   * Hermes chooses both the method and how many it sends.
   */
  #claimUnhandledRequest(request: ServerRequest): boolean {
    if (this.#requestHandlerCount > 0) return false
    const method = request.method.slice(0, MAX_LOGGED_METHOD_CHARS)
    if (this.#loggedRequestMethods.has(method)) return true
    if (this.#loggedRequestMethods.size >= MAX_LOGGED_REQUEST_METHODS) {
      if (this.#requestMethodLogCapped) return true
      this.#requestMethodLogCapped = true
      this.#log?.warn("hermes.gateway.server_request_unanswered_capped", {
        methods: this.#loggedRequestMethods.size,
      })
      return true
    }
    this.#loggedRequestMethods.add(method)
    this.#log?.warn("hermes.gateway.server_request_unanswered", { method })
    return true
  }

  /** Drop the claim-and-hold handler once a real handler owns requests. */
  removeDefaultRequestHandler(): void {
    this.#removeDefaultRequestHandler?.()
    this.#removeDefaultRequestHandler = undefined
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#clearHealGrace()
    clearTimeout(this.#redialTimer)
    this.#redialTimer = undefined
    this.#readyWaiter?.settle(false)
    this.removeDefaultRequestHandler()
    this.#failOpenWaiters(new HermesUnavailableError())
    this.#eventListeners.clear()
    this.#connectionHandlers.clear()
    this.#client.close()
  }
}
