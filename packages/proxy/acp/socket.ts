import type { PreparedWebSocketUpgrade } from "@agentclientprotocol/sdk/experimental/server"

import { authenticationRequired } from "./validation"

/** The WebSocket shape a prepared ACP upgrade drives. */
export type AcpWebSocket = Parameters<PreparedWebSocketUpgrade["accept"]>[0]

/** One inbound frame may carry a whole prompt, matching `boundedJson`'s ceiling. */
const MAX_FRAME_BYTES = 1_100_000
const DEFAULT_INPUT_WINDOW_MS = 1_000
const DEFAULT_INPUT_FRAMES_PER_WINDOW = 64
const DEFAULT_INPUT_BYTES_PER_WINDOW = 256 * 1_024
/**
 * One outbound frame may carry a history entry, a tool payload, or an inline
 * artifact, so the queue is sized for the largest native event the proxy
 * accepts rather than for small control frames.
 */
const DEFAULT_OUTPUT_FRAMES = 256
const DEFAULT_OUTPUT_BYTES = 4 * 1_024 * 1_024

const decoder = new TextDecoder()

export type AcpSocketOptions = {
  /** Closes the concrete WebSocket. Authorization happens before this shim exists. */
  close(code: number, reason: string): void
  /** Signals that one or more serialized frames are available through `drain`. */
  notify?: () => void
  /**
   * Whether the connection's credential has lapsed. From then on no frame
   * passes either way: a request is refused, and the connection closes.
   */
  lapsed?: () => boolean
  now?: () => number
  inputWindowMs?: number
  maxInputFramesPerWindow?: number
  maxInputBytesPerWindow?: number
  maxOutputFrames?: number
  maxOutputBytes?: number
}

export type AcpSocket = {
  /** Handed to the prepared ACP upgrade so the SDK owns the JSON-RPC session. */
  socket: AcpWebSocket
  /** Delivers one inbound frame from the concrete WebSocket to the SDK. */
  receive(raw: string | Uint8Array): void
  /** Removes bounded serialized frames for the concrete WebSocket to send. */
  drain(maxFrames?: number): string[]
  /** Releases the SDK session after a peer or transport close without closing twice. */
  close(): void
}

/**
 * Bounded WebSocket shim between Bun's `ServerWebSocket` handlers and the ACP
 * SDK, with an inbound frame cap, an inbound rate window, and a bounded
 * outbound queue. Pure logic: it touches no Bun global and takes its clock
 * from `now`.
 */
export function createAcpSocket(options: AcpSocketOptions): AcpSocket {
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

  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const output: Array<{ raw: string; bytes: number }> = []
  let outputBytes = 0
  let closed = false
  let windowStartedAt = now()
  let windowFrames = 0
  let windowBytes = 0

  function dispatch(type: string, event: unknown) {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
  }

  /** Ends the session and closes the concrete WebSocket with a reason. */
  function closePeer(code: number, reason: string) {
    if (closed) return
    closed = true
    output.length = 0
    outputBytes = 0
    options.close(code, reason)
    dispatch("close", { type: "close", code, reason })
    listeners.clear()
  }

  /** Queues one serialized frame for the concrete WebSocket. */
  function enqueue(raw: string) {
    const bytes = Buffer.byteLength(raw, "utf8")
    if (
      bytes > maxOutputBytes ||
      output.length >= maxOutputFrames ||
      outputBytes + bytes > maxOutputBytes
    ) {
      closePeer(1013, "ACP output overloaded")
      return
    }
    output.push({ raw, bytes })
    outputBytes += bytes
    options.notify?.()
  }

  /**
   * Answers a request a lapsed credential sent that authentication is
   * required, so it is the last frame written, and closes the connection.
   */
  function refuse(data: string) {
    const id = requestIdOf(data)
    if (id !== undefined) {
      const { code, message } = authenticationRequired()
      enqueue(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }))
    }
    closePeer(1008, "ACP credential lapsed")
  }

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

  const socket: AcpWebSocket = {
    send(raw) {
      if (closed) return
      if (options.lapsed?.()) {
        closePeer(1008, "ACP credential lapsed")
        return
      }
      enqueue(raw)
    },
    close(code, reason) {
      closePeer(code ?? 1000, reason ?? "")
    },
    addEventListener(type, listener) {
      const existing = listeners.get(type)
      if (existing) existing.add(listener)
      else listeners.set(type, new Set([listener]))
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
  }

  return {
    socket,
    receive(raw) {
      if (closed) return
      const bytes = frameSize(raw)
      if (bytes > MAX_FRAME_BYTES) {
        closePeer(1008, "ACP frame too large")
        return
      }
      if (exceedsInputRate(bytes)) {
        closePeer(1008, "ACP rate exceeded")
        return
      }
      const data = typeof raw === "string" ? raw : decoder.decode(raw)
      if (options.lapsed?.()) {
        refuse(data)
        return
      }
      dispatch("message", { type: "message", data })
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
      output.length = 0
      outputBytes = 0
      dispatch("close", { type: "close" })
      listeners.clear()
    },
  }
}

/** The id of the one JSON-RPC request a frame carries, if it carries one. */
function requestIdOf(data: string): string | number | undefined {
  let frame: unknown
  try {
    frame = JSON.parse(data)
  } catch {
    return undefined
  }
  if (typeof frame !== "object" || frame === null || Array.isArray(frame))
    return undefined
  const { id, method } = frame as { id?: unknown; method?: unknown }
  return typeof method === "string" &&
    (typeof id === "string" || typeof id === "number")
    ? id
    : undefined
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
