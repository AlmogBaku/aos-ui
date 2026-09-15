export type AosEventScope = {
  workspaceId: string
  agentId: string
  sessionId: string
}

export type AosEventSocket = {
  readonly readyState: number
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
  send(value: string): void
  close(): void
}

export type AosReconciliationFailure =
  "aos-auth-required" | "connection-interrupted"

export class AosReconciliationError extends Error {
  constructor(readonly kind: AosReconciliationFailure) {
    super("AOS reconciliation failed")
    this.name = "AosReconciliationError"
  }
}

type Stream = {
  readonly scope: AosEventScope
  readonly streamId: string
  cursor?: string
  generation: number
  readySocket?: AosEventSocket
  ready?: Promise<void>
  resolveReady?: () => void
  rejectReady?: (error: AosReconciliationError) => void
  fatal?: AosReconciliationError
}

type ServerFrame = {
  type: string
  version: number
  streamId?: string
  scope?: AosEventScope
  generation?: number
  cursor?: string
  code?: string
  read?: string
}

function defaultSocketFactory() {
  const url = new URL("/api/aos/v1/events", window.location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return new WebSocket(url) as unknown as AosEventSocket
}

function scopeKey(scope: AosEventScope) {
  return JSON.stringify([scope.workspaceId, scope.agentId, scope.sessionId])
}

function sameScope(left: AosEventScope | undefined, right: AosEventScope) {
  return (
    left?.workspaceId === right.workspaceId &&
    left.agentId === right.agentId &&
    left.sessionId === right.sessionId
  )
}

function parseFrame(event: unknown): ServerFrame | undefined {
  if (!event || typeof event !== "object" || !("data" in event))
    return undefined
  const data = event.data
  if (typeof data !== "string" || data.length > 16_384) return undefined
  try {
    const value: unknown = JSON.parse(data)
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined
    const frame = value as Record<string, unknown>
    return typeof frame.type === "string" && frame.version === 1
      ? (frame as ServerFrame)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Coordinates invalidation-only WebSockets with authoritative REST reads.
 * Cursors resume observation, never data: every reconnect still causes a read.
 */
export class AosReconciler {
  readonly #socketFactory: (scope: AosEventScope) => AosEventSocket
  readonly #authorizeSocket?: (scope: AosEventScope) => Promise<void>
  readonly #streams = new Map<string, Stream>()
  readonly #listeners = new Map<string, Set<() => void>>()
  #socket?: AosEventSocket
  #opening?: Promise<AosEventSocket>
  #nextStreamId = 0
  #closed = false
  #connectedOnce = false
  readonly #onReconnect?: () => Promise<void>
  readonly #schedule: (delayMs: number, task: () => void) => unknown
  readonly #cancel: (timer: unknown) => void
  #reconnectTimer?: unknown
  #reconnectDelayMs = 250

  constructor(
    options: {
      socketFactory?: (scope: AosEventScope) => AosEventSocket
      authorizeSocket?: (scope: AosEventScope) => Promise<void>
      onReconnect?: () => Promise<void>
      schedule?: (delayMs: number, task: () => void) => unknown
      cancel?: (timer: unknown) => void
    } = {}
  ) {
    this.#socketFactory = options.socketFactory ?? defaultSocketFactory
    this.#authorizeSocket = options.authorizeSocket
    this.#onReconnect = options.onReconnect
    this.#schedule =
      options.schedule ?? ((delay, task) => setTimeout(task, delay))
    this.#cancel = options.cancel ?? ((timer) => clearTimeout(timer as number))
  }

  async read<T>(scope: AosEventScope, operation: () => Promise<T>): Promise<T> {
    const stream = this.#stream(scope)
    while (!this.#closed) {
      await this.#ready(stream)
      if (stream.fatal) throw stream.fatal
      const socket = stream.readySocket
      const generation = stream.generation
      try {
        const result = await operation()
        if (stream.fatal) throw stream.fatal
        if (
          socket === stream.readySocket &&
          socket === this.#socket &&
          generation === stream.generation
        )
          return result
      } catch (error) {
        if (stream.fatal) throw stream.fatal
        if (
          socket === stream.readySocket &&
          socket === this.#socket &&
          generation === stream.generation
        )
          throw error
      }
    }
    throw new AosReconciliationError("connection-interrupted")
  }

  /** Invalidations contain no provider data; consumers must perform their own read. */
  subscribe(scope: AosEventScope, listener: () => void) {
    const key = scopeKey(scope)
    const listeners = this.#listeners.get(key) ?? new Set<() => void>()
    listeners.add(listener)
    this.#listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.#listeners.delete(key)
    }
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    if (this.#reconnectTimer !== undefined) this.#cancel(this.#reconnectTimer)
    this.#reconnectTimer = undefined
    this.#socket?.close()
    this.#socket = undefined
    this.#opening = undefined
    for (const stream of this.#streams.values()) {
      stream.rejectReady?.(new AosReconciliationError("connection-interrupted"))
      stream.ready = undefined
      stream.readySocket = undefined
    }
  }

  #stream(scope: AosEventScope) {
    const key = scopeKey(scope)
    let stream = this.#streams.get(key)
    if (!stream) {
      stream = {
        scope: structuredClone(scope),
        streamId: `aos-browser-${++this.#nextStreamId}`,
        generation: 0,
      }
      this.#streams.set(key, stream)
    }
    return stream
  }

  async #ready(stream: Stream) {
    if (stream.fatal) throw stream.fatal
    const socket = await this.#connect(stream.scope)
    if (stream.readySocket === socket) return
    if (!stream.ready) {
      stream.ready = new Promise<void>((resolve, reject) => {
        stream.resolveReady = resolve
        stream.rejectReady = reject
      })
      socket.send(
        JSON.stringify({
          type: "aos.subscribe",
          streamId: stream.streamId,
          scope: stream.scope,
          ...(stream.cursor === undefined ? {} : { cursor: stream.cursor }),
        })
      )
    }
    await stream.ready
  }

  #connect(scope: AosEventScope) {
    if (this.#closed)
      return Promise.reject(
        new AosReconciliationError("connection-interrupted")
      )
    if (this.#socket?.readyState === 1) return Promise.resolve(this.#socket)
    if (this.#opening) return this.#opening

    const operation = this.#authorizeSocket
      ? this.#authorizeSocket(scope)
          .catch(() => {
            throw new AosReconciliationError("aos-auth-required")
          })
          .then(() => this.#openSocket(scope))
      : this.#openSocket(scope)
    const opening = operation.catch((error: unknown) => {
      if (this.#opening === opening) this.#opening = undefined
      throw error
    })
    this.#opening = opening
    return opening
  }

  #openSocket(scope: AosEventScope) {
    if (this.#closed)
      return Promise.reject(
        new AosReconciliationError("connection-interrupted")
      )
    const socket = this.#socketFactory(scope)
    this.#socket = socket
    const opening = new Promise<AosEventSocket>((resolve, reject) => {
      const onOpen = () => {
        cleanupOpening()
        void (async () => {
          try {
            if (this.#connectedOnce) await this.#onReconnect?.()
            this.#connectedOnce = true
            this.#reconnectDelayMs = 250
            this.#opening = undefined
            resolve(socket)
          } catch {
            if (this.#socket === socket) this.#socket = undefined
            this.#opening = undefined
            try {
              socket.close()
            } catch {
              // Reconnect failure cleanup is best-effort.
            }
            reject(new AosReconciliationError("connection-interrupted"))
          }
        })()
      }
      const onOpeningFailure = () => {
        cleanupOpening()
        if (this.#socket === socket) this.#socket = undefined
        this.#opening = undefined
        reject(new AosReconciliationError("connection-interrupted"))
      }
      const cleanupOpening = () => {
        socket.removeEventListener("open", onOpen)
        socket.removeEventListener("error", onOpeningFailure)
        socket.removeEventListener("close", onOpeningFailure)
      }
      socket.addEventListener("open", onOpen)
      socket.addEventListener("error", onOpeningFailure)
      socket.addEventListener("close", onOpeningFailure)
    })

    const onMessage = (event: unknown) => this.#message(socket, event)
    const onClose = () => {
      socket.removeEventListener("message", onMessage)
      socket.removeEventListener("close", onClose)
      socket.removeEventListener("error", onClose)
      if (this.#socket !== socket) return
      this.#socket = undefined
      this.#opening = undefined
      for (const stream of this.#streams.values()) {
        if (stream.readySocket === socket) stream.generation += 1
        stream.readySocket = undefined
        stream.rejectReady?.(
          new AosReconciliationError("connection-interrupted")
        )
        stream.ready = undefined
        stream.resolveReady = undefined
        stream.rejectReady = undefined
      }
      this.#scheduleReconnect()
    }
    socket.addEventListener("message", onMessage)
    socket.addEventListener("close", onClose)
    socket.addEventListener("error", onClose)
    return opening
  }

  #scheduleReconnect() {
    if (
      this.#closed ||
      this.#streams.size === 0 ||
      this.#reconnectTimer !== undefined
    )
      return
    const delay = this.#reconnectDelayMs
    this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, 5_000)
    this.#reconnectTimer = this.#schedule(delay, () => {
      this.#reconnectTimer = undefined
      const scope = this.#streams.values().next().value?.scope
      if (!scope) return
      void this.#connect(scope)
        .then(() =>
          Promise.all(
            [...this.#streams.values()].map((stream) => this.#ready(stream))
          )
        )
        .catch(() => this.#scheduleReconnect())
    })
  }

  #message(socket: AosEventSocket, event: unknown) {
    if (socket !== this.#socket) return
    const frame = parseFrame(event)
    if (!frame || typeof frame.streamId !== "string") return
    const stream = [...this.#streams.values()].find(
      ({ streamId }) => streamId === frame.streamId
    )
    if (!stream) return
    if (
      frame.type === "aos.ready" &&
      frame.read === "authoritative" &&
      frame.generation === 0 &&
      sameScope(frame.scope, stream.scope)
    ) {
      if (typeof frame.cursor === "string") stream.cursor = frame.cursor
      stream.readySocket = socket
      stream.resolveReady?.()
      stream.ready = undefined
      stream.resolveReady = undefined
      stream.rejectReady = undefined
      return
    }
    if (
      (frame.type === "aos.invalidate" || frame.type === "aos.reset") &&
      sameScope(frame.scope, stream.scope) &&
      typeof frame.generation === "number" &&
      Number.isSafeInteger(frame.generation) &&
      frame.generation > 0
    ) {
      stream.generation += 1
      this.#listeners
        .get(scopeKey(stream.scope))
        ?.forEach((listener) => listener())
      return
    }
    if (frame.type === "aos.error" && frame.code === "authorization_expired") {
      stream.fatal = new AosReconciliationError("aos-auth-required")
      stream.rejectReady?.(stream.fatal)
      stream.generation += 1
    }
  }
}
