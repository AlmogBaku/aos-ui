/**
 * The AOS side of the Hermes JSON-RPC gateway connection. The vendored
 * `JsonRpcGatewayClient` (`vendor/hermes-shared/`) owns correlation, per-call
 * timeouts and `AbortSignal`, JSON-RPC error typing, the `gateway.ping`
 * heartbeat, socket generations and server→client request routing; this wrapper
 * owns the dial URL and private token, redial and heal grace, the wire guard and
 * response bounds, error classification, one event fan-out, epoch changes, the
 * link it reports and `close()`.
 */

import {
  boundedQueue,
  Deadline,
  defaultClock,
  type Logger,
} from "../../../lifecycle"
import { ADAPTER_CALL_MS, LINK_WAIT_MS } from "../../core/limits"
import type { LinkState, ServerLink } from "../../core/link"
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
  HermesRpcUncertainError,
  responseLimit,
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
import { isRecord, nativeId, publicReason, trimmedText } from "./native"

export {
  HermesAuthenticationError,
  HermesHttpError,
  HermesRpcUncertainError,
  type HermesCredentials,
} from "./http"
export type { HermesLog, HermesSocket } from "./gateway-socket"
export type { ServerRequest, ServerRequestHandler }
export { JSON_RPC_METHOD_NOT_FOUND } from "./vendor/hermes-shared/json-rpc-channel"

/**
 * Hermes authoritatively rejected a dispatched JSON-RPC request. The error's own
 * message stays generic; Hermes' words ride in `nativeMessage`, which only a
 * caller applying the adapter's redaction rule may publish, and `reason` is the
 * machine-readable `error.data.reason` some refusals carry.
 */
export class HermesRpcRejectedError extends Error {
  constructor(
    readonly code?: number,
    readonly nativeMessage?: string,
    readonly reason?: string
  ) {
    super("Hermes RPC request was rejected")
    this.name = "HermesRpcRejectedError"
  }
}

/**
 * Nothing was written: no open socket, a failed dial, or an unusable reply.
 * The native failure behind it, when there is one, stays as `cause`.
 */
export class HermesUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("Hermes is temporarily unavailable", options)
    this.name = "HermesUnavailableError"
  }
}

/**
 * The caller's `AbortSignal` aborted the request before its frame went out; an
 * abort after the write is uncertain instead.
 */
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
  if (
    error instanceof HermesAuthenticationError ||
    error instanceof HermesUnavailableError
  )
    throw error
  throw new HermesUnavailableError({ cause: error })
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
  subscribeEvents?(listener: (event: unknown) => void): () => void
  subscribeRequests?(handler: ServerRequestHandler): () => void
  subscribeConnection?(handler: HermesConnectionHandler): () => void
  /** Whether a frame written now reaches Hermes; a synchronous answer needs it. */
  connected?(): boolean
  /** Whether the socket is up now, and each time that changes. */
  readonly link?: ServerLink
  close?(): Promise<void>
}

export type HermesGatewayOptions = {
  baseUrl: string
  credentials: HermesCredentials
  fetcher?: typeof fetch
  socketFactory?: (url: string) => HermesSocket
  /** Deadline for one JSON-RPC call (default 15 s). */
  requestTimeoutMs?: number
  /** Deadline for one dial and its token read (default 15 s). */
  connectTimeoutMs?: number
  /** Grace before a socket loss is reported as lost (default 20 s). */
  healGraceMs?: number
  backoff?: ReconnectBackoffOptions
  log?: HermesGatewayLog
}

/**
 * The gateway's log: an outage warns once, each redial rung in it is debug, a
 * socket opening or closing is info, and a slow request warns.
 */
export type HermesGatewayLog = HermesLog & Pick<Logger, "debug" | "info">

/** A caller parked in `#awaitOpen` until a socket is open. */
type OpenWaiter = { resolve(): void; reject(error: Error): void }

/** One dispatched request: its response bound and its oversized rejector. */
type PendingResponse = {
  limit: number
  id?: string
  reject(error: Error): void
}

const REQUEST_ID_PREFIX = "aos-"
/** Hermes' own orphan-reap grace: past this the Session is treated as lost. */
const DEFAULT_HEAL_GRACE_MS = 20_000
/** How long a generation may take to announce its epoch in `gateway.ready`. */
const READY_EPOCH_WAIT_MS = 2_000
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
/** A request slower than this, queue wait included, warns; any other is debug. */
const SLOW_REQUEST_MS = 2_000
/**
 * Requests past the open socket: `limit` running (waiting on it or in flight)
 * and `queue` more behind them. One `waitMs` budget covers a queue slot and
 * an open socket, and the call's own deadline starts only at its write, so a
 * request stays well inside the admission deadline it serves.
 */
const REQUEST_QUEUE = { limit: 256, queue: 1024, waitMs: LINK_WAIT_MS }
/** Hermes' close for a refused credential (`hermes_cli/web_routers/chat_ws.py`). */
const AUTH_CLOSE_CODE = 4401
/** Hermes' close for a host or origin denial, or chat not allowed: an outage. */
const REFUSED_CLOSE_CODE = 4403

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
  readonly #log: HermesGatewayLog | undefined
  readonly #requestTimeoutMs: number
  readonly #connectTimeoutMs: number
  readonly #healGraceMs: number
  readonly #backoff: ReconnectBackoffOptions | undefined
  readonly #eventListeners = new Set<(event: unknown) => void>()
  readonly #connectionHandlers = new Set<HermesConnectionHandler>()
  readonly #openWaiters = new Set<OpenWaiter>()
  readonly #linkListeners = new Set<(state: LinkState) => void>()
  #linkState: LinkState = "lost"
  /** Up once an open socket's `restored` handlers ran, lost once it closes. */
  readonly link: ServerLink = {
    state: () => this.#linkState,
    subscribe: (listener) => {
      this.#linkListeners.add(listener)
      return () => {
        this.#linkListeners.delete(listener)
      }
    },
  }
  /** Live requests by minted id, so the wire guard can find their bound. */
  readonly #inFlightById = new Map<string, PendingResponse>()
  /** The request being dispatched, awaiting the id `#mintRequestId` gives it. */
  #dispatching: PendingResponse | undefined
  readonly #queue = boundedQueue(REQUEST_QUEUE)
  /** The socket generation currently dialled or open, and its dial token. */
  #generation: { token: string | null } | undefined
  #dialFailureLogged = false
  /** When the current socket opened, while it is open. */
  #openedAt: number | undefined
  #dial: Promise<void> | undefined
  #redialTimer: ReturnType<typeof setTimeout> | undefined
  #healTimer: ReturnType<typeof setTimeout> | undefined
  #attempt = 0
  #lostAnnounced = false
  /**
   * The token Hermes refused, or an unusable one. Callers fail fast and nothing
   * dials with it again; the redial ladder keeps re-reading the token, and a
   * read that returns a different one clears this.
   */
  #refusal: { token: unknown } | undefined
  #closed = false
  #epoch: string | undefined
  /** The bounded wait for this generation's first `gateway.ready` frame. */
  #readyWaiter: { settle(changed: boolean): void } | undefined

  constructor(options: HermesGatewayOptions) {
    this.#baseUrl = options.baseUrl
    this.#credentials = options.credentials
    this.#log = options.log
    this.#requestTimeoutMs = options.requestTimeoutMs ?? ADAPTER_CALL_MS
    this.#connectTimeoutMs = options.connectTimeoutMs ?? ADAPTER_CALL_MS
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
  }

  /** Joins an in-flight dial. */
  async connect(): Promise<void> {
    if (this.#closed) throw new HermesUnavailableError()
    if (this.#dial) return this.#dial
    const dial = this.#dialOnce()
    this.#dial = dial
    try {
      await dial
    } catch (error) {
      // Parked callers learn a refused token now; the ladder still re-reads it.
      if (error instanceof HermesAuthenticationError)
        this.#failOpenWaiters(error)
      this.#scheduleRedial()
      throw error
    } finally {
      if (this.#dial === dial) this.#dial = undefined
    }
  }

  async #dialOnce(): Promise<void> {
    const token = await this.#serverToken()
    if (!isServerToken(token) || token === this.#refusal?.token) {
      this.#refusal = { token }
      throw new HermesAuthenticationError()
    }
    this.#refusal = undefined
    const url = webSocketUrl(this.#baseUrl, token)
    // Pre-checked here so the vendored `invalidUrl()` message, which embeds
    // the URL and therefore the token, is unreachable.
    if (!isGatewayWebSocketUrl(url)) throw new HermesUnavailableError()
    if (this.#closed) throw new HermesUnavailableError()
    try {
      await this.#client.connect(url)
    } catch (error) {
      if (this.#refusal) throw new HermesAuthenticationError()
      this.#logDialFailure("handshake_failed", { error })
      throw new HermesUnavailableError({ cause: error })
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
    this.#advertiseCapabilities().catch((err: unknown) =>
      this.#log?.warn({ err }, "hermes.gateway.capabilities_failed")
    )
  }

  /**
   * Hermes sends a clarify or approval only to a connection that announced it
   * answers server→client requests (`tui_gateway/server_requests.py`); one that
   * never did gets every such request failed fast, which the agent reports as a
   * cancelled question. Announced once per socket, so a redial announces again.
   */
  async #advertiseCapabilities() {
    try {
      await this.#client.request(
        "client.capabilities",
        { server_requests: true },
        this.#requestTimeoutMs
      )
    } catch {
      // An older Hermes has no such method and sends no server requests; the
      // dial itself stands, and interactions simply stay unavailable.
      this.#log?.warn({}, "hermes.gateway.capabilities_unacknowledged")
    }
  }

  /**
   * Read the private server token under the connect deadline, afresh on every
   * dial, so a rotated token is picked up without a restart.
   */
  async #serverToken(): Promise<unknown> {
    try {
      const headers = await new Deadline(this.#connectTimeoutMs).run((signal) =>
        this.#credentials(signal)
      )
      return headers["X-Hermes-Session-Token"]
    } catch {
      // The reader's own error may name the credential; it is never carried.
      throw new HermesUnavailableError()
    }
  }

  /**
   * Wrap one dialled socket. A real WebSocket still dispatches frames queued
   * before it was abandoned, so every guard callback is gated on this socket
   * still being the current generation.
   */
  #createSocket(url: string) {
    const generation = { token: new URL(url).searchParams.get("token") }
    this.#generation = generation
    const current = () => this.#generation === generation
    let raw: HermesSocket
    try {
      raw = this.#socketFactory(url)
    } catch (error) {
      // Its own outage, apart from a handshake Hermes never completed.
      this.#logDialFailure("socket_factory_threw", { error })
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
   * rung; the next open re-arms this. An error is recorded whole: a native
   * message may carry the dial URL, and the log strips its token.
   */
  #logDialFailure(
    reason: string,
    detail: { error: unknown } | { close_code: number }
  ) {
    if (this.#dialFailureLogged) return
    this.#dialFailureLogged = true
    this.#log?.warn({ reason, ...detail }, "hermes.gateway.dial_failed")
  }

  #onSocketClose(event: { code: number }): boolean {
    if (event.code === AUTH_CLOSE_CODE) {
      this.#refusal = { token: this.#generation?.token }
      this.#log?.warn(
        {
          close_code: event.code,
        },
        "hermes.gateway.authentication_rejected"
      )
    } else if (event.code === REFUSED_CLOSE_CODE) {
      this.#logDialFailure("refused", { close_code: event.code })
    }
    // Never intercept: the vendored `closed` transition arms heal and redial.
    return false
  }

  #onState(state: ConnectionState) {
    if (this.#closed) return
    if (state === "open") {
      this.#log?.info({ redials: this.#attempt }, "hermes.gateway.opened")
      this.#openedAt = defaultClock.now()
      this.#attempt = 0
      this.#lostAnnounced = false
      this.#dialFailureLogged = false
      this.#clearHealGrace()
      // Rebinding first: a parked request must not be written before
      // `restored` handlers have re-registered their Sessions.
      const generation = this.#generation
      const release = () => {
        this.#resolveOpenWaiters()
        // A socket that closed while its handlers ran is not up.
        if (this.#generation === generation && this.connected())
          this.#setLink("ready")
      }
      void this.#announceOpen().then(release, release)
      return
    }
    if (state !== "closed" && state !== "error") return
    if (this.#openedAt !== undefined) {
      const openMs = Math.round(defaultClock.now() - this.#openedAt)
      this.#openedAt = undefined
      this.#log?.info({ state, openMs }, "hermes.gateway.closed")
    }
    this.#setLink("lost")
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
    if (this.#closed || this.#redialTimer !== undefined) return
    const delay = reconnectBackoffDelayMs(this.#attempt, this.#backoff)
    this.#attempt += 1
    this.#redialTimer = setTimeout(() => {
      this.#redialTimer = undefined
      if (this.#closed || this.#dial) return
      if (this.#client.connectionState === "open") return
      this.connect().catch((err: unknown) =>
        this.#log?.debug({ err }, "hermes.gateway.redial_failed")
      )
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

  #setLink(state: LinkState) {
    if (state === this.#linkState) return
    this.#linkState = state
    for (const listener of [...this.#linkListeners]) {
      try {
        listener(state)
      } catch (error) {
        this.#logHandlerFailure("link", error)
      }
    }
  }

  #logHandlerFailure(phase: string, error: unknown) {
    this.#log?.warn(
      {
        phase,
        reason: publicReason(error),
      },
      "hermes.gateway.handler_failed"
    )
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
    if (changed) this.#log?.warn({}, "hermes.gateway.replay_epoch_changed")
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
   * written, so the request's wait budget, `signal`, reports it unavailable.
   */
  #awaitOpen(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new HermesUnavailableError())
    if (this.#closed) return Promise.reject(new HermesUnavailableError())
    if (this.#client.connectionState === "open") return Promise.resolve()
    if (this.#refusal) return Promise.reject(new HermesAuthenticationError())
    if (!this.#dial && this.#redialTimer === undefined)
      this.connect().catch((err: unknown) =>
        this.#log?.debug({ err }, "hermes.gateway.redial_failed")
      )
    return new Promise<void>((resolve, reject) => {
      // Membership in `#openWaiters` is what settles a waiter exactly once.
      const finish = (complete: () => void) => {
        if (!this.#openWaiters.delete(waiter)) return
        signal.removeEventListener("abort", onAbort)
        complete()
      }
      const waiter: OpenWaiter = {
        resolve: () => finish(resolve),
        reject: (error: Error) => finish(() => reject(error)),
      }
      const onAbort = () => waiter.reject(new HermesUnavailableError())
      this.#openWaiters.add(waiter)
      signal.addEventListener("abort", onAbort, { once: true })
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
    if (this.#refusal) throw new HermesAuthenticationError()
    let limit: number
    try {
      limit = responseLimit(
        options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        MAX_SOCKET_FRAME_BYTES
      )
    } catch {
      throw new HermesUnavailableError()
    }
    const started = defaultClock.now()
    const wait = new Deadline(
      REQUEST_QUEUE.waitMs,
      defaultClock,
      options.signal
    )
    let written = false
    try {
      return await this.#queue.execute(async () => {
        await this.#awaitOpen(wait.signal)
        wait.clear()
        // Past this line the frame goes out, and an abort is no longer proof
        // that Hermes never saw it.
        options.signal?.throwIfAborted()
        written = true
        return this.#write(method, params, limit, options)
      }, wait.signal)
    } catch (error) {
      throw written ? this.#classify(error) : this.#unwritten(error, options)
    } finally {
      wait.clear()
      const elapsedMs = Math.round(defaultClock.now() - started)
      if (elapsedMs >= SLOW_REQUEST_MS)
        this.#log?.warn({ method, elapsedMs }, "hermes.gateway.request_slow")
      else this.#log?.debug({ method, elapsedMs }, "hermes.gateway.request")
    }
  }

  /** Write one request; the per-call deadline runs from this write. */
  async #write(
    method: string,
    params: Readonly<Record<string, unknown>>,
    limit: number,
    options: HermesRpcOptions
  ): Promise<unknown> {
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
  }

  /**
   * Nothing was written: a full queue, a spent wait budget or a closed
   * gateway is an outage, and the caller's own abort stays an abort.
   */
  #unwritten(error: unknown, options: HermesRpcOptions): Error {
    if (error instanceof HermesAuthenticationError) return error
    return options.signal?.aborted
      ? new HermesRequestAbortedError()
      : new HermesUnavailableError({ cause: error })
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
      error instanceof HermesRpcRejectedError
    )
      return error
    if (error instanceof JsonRpcGatewayError)
      return new HermesRpcRejectedError(
        Number.isSafeInteger(error.code) ? error.code : undefined,
        trimmedText(error.message),
        isRecord(error.data) ? nativeId(error.data.reason, 128) : undefined
      )
    // Nothing was written: the generation was gone before the send.
    if (error instanceof Error && error.message === NOT_CONNECTED)
      return new HermesUnavailableError({ cause: error })
    // Written, outcome unknown: timeout, dropped generation, send failure, or
    // the caller giving up on a frame Hermes may already be running.
    return new HermesRpcUncertainError()
  }

  http(path: string, init?: HermesHttpInit): Promise<unknown> {
    return this.#httpClient.http(path, init)
  }

  /** One vendored `onAny` subscription fans out to every listener, forever. */
  subscribeEvents(listener: (event: unknown) => void): () => void {
    this.#eventListeners.add(listener)
    return () => this.#eventListeners.delete(listener)
  }

  subscribeRequests(handler: ServerRequestHandler): () => void {
    return this.#client.onRequest(handler)
  }

  /**
   * Whether a frame written now reaches Hermes. A server→client request is
   * answered synchronously on the socket that carried it, and a dead socket
   * swallows that write, so the answering surface checks this first instead of
   * reporting an answer Hermes never received.
   */
  connected(): boolean {
    return (
      !this.#closed && !this.#refusal && this.#client.connectionState === "open"
    )
  }

  subscribeConnection(handler: HermesConnectionHandler): () => void {
    this.#connectionHandlers.add(handler)
    return () => this.#connectionHandlers.delete(handler)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#setLink("lost")
    this.#linkListeners.clear()
    this.#clearHealGrace()
    clearTimeout(this.#redialTimer)
    this.#redialTimer = undefined
    this.#readyWaiter?.settle(false)
    this.#failOpenWaiters(new HermesUnavailableError())
    this.#eventListeners.clear()
    this.#connectionHandlers.clear()
    this.#client.close()
  }
}
