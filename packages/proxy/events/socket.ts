import type { ReconnectCursorClaims, ReconnectCursorCodec } from "./cursor"
import {
  createInvalidationConnection,
  type EventScope,
  type InvalidationConnection,
  type InvalidationConnectionOptions,
  type ServerEventFrame,
} from "./invalidation"

const MAX_FRAME_BYTES = 16_384
export const DEFAULT_INPUT_WINDOW_MS = 1_000
export const DEFAULT_INPUT_FRAMES_PER_WINDOW = 64
export const DEFAULT_INPUT_BYTES_PER_WINDOW = 256 * 1_024
const DEFAULT_OUTPUT_FRAMES = 128
const DEFAULT_OUTPUT_BYTES = 256 * 1_024

export type EventSocketServerFrame =
  | {
      type: "aos.ready"
      version: 1
      streamId: string
      scope: EventScope
      generation: number
      read: "authoritative"
      cursor?: string
    }
  | {
      type: "aos.invalidate" | "aos.reset"
      version: 1
      streamId: string
      scope: EventScope
      generation: number
      reason?: "reconcile_required"
    }
  | {
      type: "aos.error"
      version: 1
      streamId?: string
      code:
        | "authorization_expired"
        | "invalid_cursor"
        | "observer_unavailable"
        | "too_many_streams"
        | "unauthorized"
        | "unknown_stream"
    }

export interface EventsSocketOptions extends Pick<
  InvalidationConnectionOptions,
  "authorize" | "observe" | "now" | "schedule" | "cancel" | "maxStreams"
> {
  cursor: ReconnectCursorCodec
  /** Closes the concrete WebSocket. Authentication happens before this core exists. */
  close(code: number, reason: string): void
  /** Signals that one or more serialized frames are available through `drain`. */
  notify?: () => void
  inputWindowMs?: number
  maxInputFramesPerWindow?: number
  maxInputBytesPerWindow?: number
  maxOutputFrames?: number
  maxOutputBytes?: number
}

export interface EventsSocket {
  receive(raw: string | Uint8Array): Promise<void>
  /** Removes bounded serialized frames for the concrete WebSocket to send. */
  drain(maxFrames?: number): string[]
  /** Releases observers after a peer or transport close without closing twice. */
  close(): void
}

/**
 * Strict JSON/WebSocket framing around the provider-neutral invalidation core.
 * It never stores or forwards provider events: every wake asks the client to
 * reconcile from authoritative REST state.
 */
export function createEventsSocket(options: EventsSocketOptions): EventsSocket {
  const now = options.now ?? Date.now
  const inputWindowMs = positiveLimit(
    options.inputWindowMs,
    DEFAULT_INPUT_WINDOW_MS
  )
  const maxInputFrames = positiveLimit(
    options.maxInputFramesPerWindow,
    DEFAULT_INPUT_FRAMES_PER_WINDOW
  )
  const maxInputBytes = positiveLimit(
    options.maxInputBytesPerWindow,
    DEFAULT_INPUT_BYTES_PER_WINDOW
  )
  const maxOutputFrames = positiveLimit(
    options.maxOutputFrames,
    DEFAULT_OUTPUT_FRAMES
  )
  const maxOutputBytes = positiveLimit(
    options.maxOutputBytes,
    DEFAULT_OUTPUT_BYTES
  )

  const output: Array<{ raw: string; bytes: number }> = []
  const scopes = new Map<string, EventScope>()
  const generationOffsets = new Map<string, number>()
  const invalidResumes = new Set<string>()
  let outputBytes = 0
  let closed = false
  let windowStartedAt = now()
  let windowFrames = 0
  let windowBytes = 0

  const tolerantCursor: ReconnectCursorCodec = {
    seal: (claims) => options.cursor.seal(claims),
    open(token, expected) {
      let claims: ReconnectCursorClaims | null
      try {
        claims = options.cursor.open(token, expected)
      } catch {
        claims = null
      }
      if (claims !== null) return claims

      invalidResumes.add(expected.streamId)
      return {
        version: 1,
        keyId: "reconcile",
        ...expected,
        iat: Math.floor(now() / 1_000),
        exp: Math.floor(now() / 1_000) + 1,
      }
    },
  }

  function closeFromCore(code: number, reason: string) {
    if (closed) return
    closed = true
    options.close(code, reason)
  }

  function closeOverloaded() {
    if (closed) return
    output.length = 0
    outputBytes = 0
    closed = true
    connection.close()
    options.close(1013, "Event output overloaded")
  }

  function enqueue(frame: EventSocketServerFrame) {
    if (closed) return
    const raw = JSON.stringify(frame)
    const bytes = Buffer.byteLength(raw, "utf8")
    if (
      bytes > maxOutputBytes ||
      output.length >= maxOutputFrames ||
      outputBytes + bytes > maxOutputBytes
    ) {
      closeOverloaded()
      return
    }
    output.push({ raw, bytes })
    outputBytes += bytes
    options.notify?.()
  }

  function emit(frame: ServerEventFrame) {
    if (frame.type === "ready") {
      scopes.set(frame.streamId, frame.scope)
      enqueue({
        type: "aos.ready",
        version: 1,
        streamId: frame.streamId,
        scope: frame.scope,
        generation: 0,
        read: "authoritative",
        ...(frame.cursor === undefined ? {} : { cursor: frame.cursor }),
      })
      if (invalidResumes.delete(frame.streamId)) {
        generationOffsets.set(frame.streamId, 1)
        enqueue({
          type: "aos.reset",
          version: 1,
          streamId: frame.streamId,
          scope: frame.scope,
          generation: 1,
          reason: "reconcile_required",
        })
      }
      return
    }

    if (frame.type === "invalidate" || frame.type === "reset") {
      const scope = scopes.get(frame.streamId)
      if (scope === undefined) return
      enqueue({
        type: frame.type === "invalidate" ? "aos.invalidate" : "aos.reset",
        version: 1,
        streamId: frame.streamId,
        scope,
        generation:
          frame.generation + (generationOffsets.get(frame.streamId) ?? 0),
        ...(frame.type === "reset"
          ? { reason: "reconcile_required" as const }
          : {}),
      })
      return
    }

    enqueue({
      type: "aos.error",
      version: 1,
      ...(frame.streamId === undefined ? {} : { streamId: frame.streamId }),
      code: frame.code,
    })
  }

  const connection: InvalidationConnection = createInvalidationConnection({
    authorize: options.authorize,
    observe: options.observe,
    cursor: tolerantCursor,
    send: emit,
    close: closeFromCore,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    ...(options.cancel === undefined ? {} : { cancel: options.cancel }),
    ...(options.maxStreams === undefined
      ? {}
      : { maxStreams: options.maxStreams }),
  })

  function exceedsInputRate(bytes: number) {
    const currentTime = now()
    if (currentTime - windowStartedAt >= inputWindowMs) {
      windowStartedAt = currentTime
      windowFrames = 0
      windowBytes = 0
    }
    windowFrames += 1
    windowBytes += bytes
    return windowFrames > maxInputFrames || windowBytes > maxInputBytes
  }

  function closeForInputRate() {
    if (closed) return
    closed = true
    connection.close()
    options.close(1008, "Event rate exceeded")
  }

  return {
    async receive(raw) {
      if (closed) return
      const bytes = frameSize(raw)
      if (bytes > MAX_FRAME_BYTES) {
        await connection?.receive(raw)
        return
      }
      if (exceedsInputRate(bytes)) {
        closeForInputRate()
        return
      }
      const normalized = normalizeClientFrame(raw)
      await connection.receive(normalized)
      if (normalizedClientType(normalized) === "unsubscribe") {
        const streamId = clientStreamId(normalized)
        if (streamId !== undefined) {
          scopes.delete(streamId)
          generationOffsets.delete(streamId)
          invalidResumes.delete(streamId)
        }
      }
    },
    drain(maxFrames = Number.MAX_SAFE_INTEGER) {
      if (!Number.isSafeInteger(maxFrames) || maxFrames <= 0) return []
      const drained = output.splice(0, maxFrames)
      for (const frame of drained) outputBytes -= frame.bytes
      return drained.map((frame) => frame.raw)
    },
    close() {
      if (closed) return
      closed = true
      connection.close()
      output.length = 0
      outputBytes = 0
      scopes.clear()
      generationOffsets.clear()
      invalidResumes.clear()
    },
  }
}

function normalizeClientFrame(raw: string | Uint8Array): string | Uint8Array {
  let text: string
  try {
    text =
      typeof raw === "string"
        ? raw
        : new TextDecoder("utf-8", { fatal: true }).decode(raw)
  } catch {
    return raw
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return raw
  }
  if (!isRecord(value)) return JSON.stringify({ type: "invalid" })
  if (value.type === "aos.subscribe")
    return JSON.stringify({ ...value, type: "subscribe" })
  if (value.type === "aos.unsubscribe")
    return JSON.stringify({ ...value, type: "unsubscribe" })
  return JSON.stringify({ ...value, type: "invalid" })
}

function normalizedClientType(raw: string | Uint8Array) {
  if (typeof raw !== "string") return undefined
  try {
    const value: unknown = JSON.parse(raw)
    return isRecord(value) && typeof value.type === "string"
      ? value.type
      : undefined
  } catch {
    return undefined
  }
}

function clientStreamId(raw: string | Uint8Array) {
  if (typeof raw !== "string") return undefined
  try {
    const value: unknown = JSON.parse(raw)
    return isRecord(value) && typeof value.streamId === "string"
      ? value.streamId
      : undefined
  } catch {
    return undefined
  }
}

function frameSize(raw: string | Uint8Array) {
  return typeof raw === "string"
    ? Buffer.byteLength(raw, "utf8")
    : raw.byteLength
}

function positiveLimit(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? value
    : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
