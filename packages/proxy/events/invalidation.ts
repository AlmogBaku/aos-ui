import type {
  ReconnectCursorBinding,
  ReconnectCursorCodec,
  ReconnectCursorSealClaims,
} from "./cursor"

const MAX_FRAME_BYTES = 16_384
const MAX_STREAMS = 32
const MAX_IDENTIFIER_LENGTH = 256
const MAX_STREAM_ID_LENGTH = 128
const MAX_CURSOR_LENGTH = 4_096
const MAX_AUTHORIZATION_DELAY_MS = 2_147_483_647
const MAX_CURSOR_LIFETIME_SECONDS = 3_600

export interface EventScope {
  workspaceId: string
  agentId: string
  sessionId: string
}

export type ClientEventFrame =
  | {
      type: "subscribe"
      streamId: string
      scope: EventScope
      cursor?: string
    }
  | { type: "unsubscribe"; streamId: string }

export type ServerEventFrame =
  | {
      type: "ready"
      streamId: string
      scope: EventScope
      read: "authoritative"
      cursor?: string
    }
  | { type: "invalidate"; streamId: string; generation: number }
  | { type: "reset"; streamId: string; generation: number }
  | {
      type: "error"
      streamId?: string
      code:
        | "authorization_expired"
        | "invalid_cursor"
        | "observer_unavailable"
        | "too_many_streams"
        | "unauthorized"
        | "unknown_stream"
    }

export interface NativeEventObservation {
  stop(): void
}

export interface EventAuthorization {
  /** Complete cursor binding for the exact authenticated principal and lane. */
  binding: ReconnectCursorBinding
  /** Epoch milliseconds after which this exact authorization must not remain open. */
  expiresAt?: number
}

export interface InvalidationConnectionOptions {
  /** Authorizes the exact authenticated principal/lane and requested Agent/Session. */
  authorize(request: {
    scope: EventScope
    streamId: string
  }): Promise<EventAuthorization | null>
  /**
   * Starts native observation before the stream is ready. Callbacks deliberately
   * have no payload or native position: REST remains authoritative.
   */
  observe(request: {
    scope: EventScope
    invalidate(): void
    reset(): void
  }): Promise<NativeEventObservation>
  /** The actual sealed-cursor codec; no adapter or unbound cursor bridge. */
  cursor?: ReconnectCursorCodec
  send(frame: ServerEventFrame): void
  close(code: number, reason: string): void
  now?: () => number
  schedule?: (delayMs: number, task: () => void) => unknown
  cancel?: (timer: unknown) => void
  maxStreams?: number
}

export interface InvalidationConnection {
  /** Receives one complete WebSocket JSON frame. */
  receive(raw: string | Uint8Array): Promise<void>
  /** Stops every in-flight observation when the WebSocket itself closes. */
  close(): void
}

interface ActiveStream {
  readonly streamId: string
  readonly scope: EventScope
  generation: number
  ready: boolean
  stopped: boolean
  observerStopped: boolean
  observer?: NativeEventObservation
  expiryTimer?: unknown
}

/**
 * Provider-neutral per-WebSocket invalidation state. It intentionally stores
 * neither provider events nor workspace data: a `ready`, `invalidate`, or
 * `reset` always tells the browser to perform an authoritative REST read.
 */
export function createInvalidationConnection(
  options: InvalidationConnectionOptions
): InvalidationConnection {
  const now = options.now ?? Date.now
  const schedule =
    options.schedule ?? ((delay, task) => setTimeout(task, delay))
  const cancel = options.cancel ?? ((timer) => clearTimeout(timer as number))
  const maxStreams = options.maxStreams ?? MAX_STREAMS
  const streams = new Map<string, ActiveStream>()
  let closed = false
  let queue = Promise.resolve()

  function finish(code?: number, reason?: string) {
    if (closed) return
    closed = true
    for (const stream of streams.values()) stopStream(stream)
    streams.clear()
    if (code !== undefined && reason !== undefined) options.close(code, reason)
  }

  function stopStream(stream: ActiveStream) {
    if (!stream.stopped) {
      stream.stopped = true
      if (stream.expiryTimer !== undefined) cancel(stream.expiryTimer)
    }
    if (stream.observer !== undefined && !stream.observerStopped) {
      stream.observerStopped = true
      stream.observer.stop()
    }
  }

  function wake(stream: ActiveStream, type: "invalidate" | "reset") {
    if (closed || stream.stopped) return
    stream.generation += 1
    if (stream.ready)
      options.send({
        type,
        streamId: stream.streamId,
        generation: stream.generation,
      })
  }

  function expire(stream: ActiveStream) {
    if (closed || stream.stopped) return
    options.send({
      type: "error",
      streamId: stream.streamId,
      code: "authorization_expired",
    })
    finish(4401, "Authorization expired")
  }

  async function subscribe(
    frame: Extract<ClientEventFrame, { type: "subscribe" }>
  ) {
    if (streams.has(frame.streamId)) {
      finish(1008, "Invalid event stream")
      return
    }
    if (streams.size >= maxStreams) {
      options.send({
        type: "error",
        streamId: frame.streamId,
        code: "too_many_streams",
      })
      return
    }

    let authorization: EventAuthorization | null
    try {
      authorization = await options.authorize({
        scope: frame.scope,
        streamId: frame.streamId,
      })
    } catch {
      authorization = null
    }
    if (closed) return
    if (
      !isValidAuthorization(authorization, frame.scope, frame.streamId, now())
    ) {
      options.send({
        type: "error",
        streamId: frame.streamId,
        code: "unauthorized",
      })
      return
    }

    const binding = authorization.binding
    if (
      frame.cursor !== undefined &&
      (options.cursor === undefined ||
        options.cursor.open(frame.cursor, binding) === null)
    ) {
      options.send({
        type: "error",
        streamId: frame.streamId,
        code: "invalid_cursor",
      })
      return
    }

    const stream: ActiveStream = {
      streamId: frame.streamId,
      scope: frame.scope,
      generation: 0,
      ready: false,
      stopped: false,
      observerStopped: false,
    }
    streams.set(stream.streamId, stream)
    try {
      const observer = await options.observe({
        scope: stream.scope,
        invalidate: () => wake(stream, "invalidate"),
        reset: () => wake(stream, "reset"),
      })
      stream.observer = observer
    } catch {
      streams.delete(stream.streamId)
      stopStream(stream)
      options.send({
        type: "error",
        streamId: stream.streamId,
        code: "observer_unavailable",
      })
      return
    }

    if (closed || stream.stopped || streams.get(stream.streamId) !== stream) {
      stopStream(stream)
      return
    }
    if (authorization.expiresAt !== undefined) {
      const remaining = authorization.expiresAt - now()
      if (remaining <= 0) {
        expire(stream)
        return
      }
      stream.expiryTimer = schedule(
        Math.min(remaining, MAX_AUTHORIZATION_DELAY_MS),
        () => expire(stream)
      )
    }
    const cursorClaims = cursorClaimsFor(
      binding,
      authorization.expiresAt ?? now() + MAX_CURSOR_LIFETIME_SECONDS * 1_000,
      now()
    )
    let cursor: string | undefined
    try {
      cursor =
        options.cursor === undefined || cursorClaims === null
          ? undefined
          : options.cursor.seal(cursorClaims)
    } catch {
      stopStream(stream)
      streams.delete(stream.streamId)
      options.send({
        type: "error",
        streamId: stream.streamId,
        code: "observer_unavailable",
      })
      return
    }
    stream.ready = true
    options.send({
      type: "ready",
      streamId: stream.streamId,
      scope: stream.scope,
      read: "authoritative",
      ...(cursor === undefined ? {} : { cursor }),
    })
    if (stream.generation > 0)
      options.send({
        type: "invalidate",
        streamId: stream.streamId,
        generation: stream.generation,
      })
  }

  function unsubscribe(streamId: string) {
    const stream = streams.get(streamId)
    if (stream === undefined) {
      options.send({ type: "error", streamId, code: "unknown_stream" })
      return
    }
    streams.delete(streamId)
    stopStream(stream)
  }

  return {
    receive(raw) {
      queue = queue.then(async () => {
        if (closed) return
        const frame = parseClientFrame(raw)
        if (frame === null) {
          finish(
            frameSize(raw) > MAX_FRAME_BYTES ? 1009 : 1008,
            frameSize(raw) > MAX_FRAME_BYTES
              ? "Event frame too large"
              : "Invalid event frame"
          )
          return
        }
        if (frame.type === "subscribe") await subscribe(frame)
        else unsubscribe(frame.streamId)
      })
      return queue
    },
    close() {
      finish()
    },
  }
}

function cursorClaimsFor(
  binding: ReconnectCursorBinding,
  authorizationExpiresAt: number,
  currentTime: number
): ReconnectCursorSealClaims | null {
  const iat = Math.floor(currentTime / 1_000)
  const exp = Math.min(
    Math.floor(authorizationExpiresAt / 1_000),
    iat + MAX_CURSOR_LIFETIME_SECONDS
  )
  return exp > iat ? { ...binding, iat, exp } : null
}

function parseClientFrame(raw: string | Uint8Array): ClientEventFrame | null {
  if (frameSize(raw) > MAX_FRAME_BYTES) return null
  let text: string
  try {
    text =
      typeof raw === "string"
        ? raw
        : new TextDecoder("utf-8", { fatal: true }).decode(raw)
  } catch {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value) || !isBoundedString(value.type, 32)) return null
  if (value.type === "unsubscribe")
    return hasOnlyKeys(value, ["type", "streamId"]) &&
      validStreamId(value.streamId)
      ? { type: "unsubscribe", streamId: value.streamId }
      : null
  if (value.type !== "subscribe") return null
  if (
    !hasOnlyKeys(value, ["type", "streamId", "scope", "cursor"]) ||
    !validStreamId(value.streamId) ||
    !validScope(value.scope) ||
    (value.cursor !== undefined &&
      !isBoundedString(value.cursor, MAX_CURSOR_LENGTH))
  )
    return null
  return {
    type: "subscribe",
    streamId: value.streamId,
    scope: value.scope,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
  }
}

function isValidAuthorization(
  authorization: EventAuthorization | null,
  scope: EventScope,
  streamId: string,
  currentTime: number
): authorization is EventAuthorization {
  if (
    authorization === null ||
    (authorization.expiresAt !== undefined &&
      !Number.isSafeInteger(authorization.expiresAt))
  )
    return false
  const binding = authorization.binding
  return (
    (authorization.expiresAt === undefined ||
      authorization.expiresAt > currentTime) &&
    binding.agentId === scope.agentId &&
    binding.sessionId === scope.sessionId &&
    binding.streamId === streamId &&
    binding.scope === canonicalScope(scope) &&
    validBindingShape(binding)
  )
}

function validBindingShape(binding: ReconnectCursorBinding) {
  if (
    !isBoundedString(binding.deploymentId, MAX_IDENTIFIER_LENGTH) ||
    !isBoundedString(binding.authorizationRevision, MAX_IDENTIFIER_LENGTH) ||
    !isBoundedString(binding.bootEpoch, MAX_IDENTIFIER_LENGTH) ||
    !validStreamId(binding.streamId)
  )
    return false
  return binding.lane === "operator"
    ? isBoundedString(binding.principalId, MAX_IDENTIFIER_LENGTH) &&
        binding.invitationId === undefined
    : binding.lane === "guest" &&
        isBoundedString(binding.invitationId, MAX_IDENTIFIER_LENGTH) &&
        binding.principalId === undefined
}

function canonicalScope(scope: EventScope) {
  return `ws1.${encode(scope.workspaceId)}.${encode(scope.agentId)}.${encode(scope.sessionId)}`
}

function encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url")
}

function validScope(value: unknown): value is EventScope {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["workspaceId", "agentId", "sessionId"]) &&
    isBoundedString(value.workspaceId, MAX_IDENTIFIER_LENGTH) &&
    isBoundedString(value.agentId, MAX_IDENTIFIER_LENGTH) &&
    isBoundedString(value.sessionId, MAX_IDENTIFIER_LENGTH)
  )
}

function validStreamId(value: unknown): value is string {
  return isBoundedString(value, MAX_STREAM_ID_LENGTH)
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
) {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function frameSize(raw: string | Uint8Array) {
  return typeof raw === "string"
    ? Buffer.byteLength(raw, "utf8")
    : raw.byteLength
}
