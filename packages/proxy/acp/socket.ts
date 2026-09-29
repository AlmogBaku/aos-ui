import type { PreparedWebSocketUpgrade } from "@agentclientprotocol/sdk/experimental/server"
import { methods } from "@agentclientprotocol/sdk/experimental/v2"

import { ACP_PROTOCOL_VERSION, AOS_METHODS } from "../../protocol/acp"
import { authenticationRequired } from "./validation"

/** The WebSocket shape a prepared ACP upgrade drives. */
export type AcpWebSocket = Parameters<PreparedWebSocketUpgrade["accept"]>[0]

/** One inbound frame may carry a whole prompt, matching `boundedJson`'s ceiling. */
const MAX_FRAME_BYTES = 1_100_000
const DEFAULT_INPUT_WINDOW_MS = 1_000
const DEFAULT_INPUT_FRAMES_PER_WINDOW = 64
const DEFAULT_INPUT_BYTES_PER_WINDOW = 256 * 1_024

const decoder = new TextDecoder()

/** A JSON-RPC error reply's `error` member. */
export type AcpErrorReply = { code: number; message: string; data?: unknown }

/**
 * How a listener shows its failures: an error reply's code, whatever it is, as
 * a public reply, and an `_aos/error` notification's code as a public code.
 */
export type PublicErrors = {
  reply(code: unknown): AcpErrorReply
  notice(code: unknown): string
}

export type AcpSocketOptions = {
  /** Closes the concrete WebSocket. Authorization happens before this shim exists. */
  close(code: number, reason: string): void
  /**
   * Delivers one serialized frame to the concrete WebSocket. Called directly
   * for every outbound SDK frame; backpressure and drops are handled by the
   * Bun listener's own limits.
   */
  send(raw: string): void
  /**
   * Whether the connection's credential has lapsed. From then on no frame
   * passes either way: a request is refused, and the connection closes.
   */
  lapsed?: () => boolean
  /** How a failure is shown; as written by default. */
  publicErrors?: PublicErrors
  now?: () => number
  inputWindowMs?: number
  maxInputFramesPerWindow?: number
  maxInputBytesPerWindow?: number
}

export type AcpSocket = {
  /** Handed to the prepared ACP upgrade so the SDK owns the JSON-RPC session. */
  socket: AcpWebSocket
  /** Delivers one inbound frame from the concrete WebSocket to the SDK. */
  receive(raw: string | Uint8Array): void
  /** Releases the SDK session after a peer or transport close without closing twice. */
  close(): void
}

/**
 * Inbound WebSocket shim between Bun's `ServerWebSocket` handlers and the ACP
 * SDK, with an inbound frame cap and an inbound rate window. Outbound frames
 * are written directly through `send`; Bun's own backpressure limit and
 * `closeOnBackpressureLimit` bound the outbound side. Pure logic: it touches
 * no Bun global and takes its clock from `now`.
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

  const listeners = new Map<string, Set<(event: unknown) => void>>()
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
    options.close(code, reason)
    dispatch("close", { type: "close", code, reason })
    listeners.clear()
  }

  /**
   * Answers a request a lapsed credential sent that authentication is
   * required, so it is the last frame written, and closes the connection.
   */
  function refuse(data: string) {
    const id = requestIdOf(data)
    if (id !== undefined) {
      const { code, message } = authenticationRequired()
      options.send(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })
      )
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
      options.send(
        options.publicErrors ? publicFrame(raw, options.publicErrors) : raw
      )
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
      dispatch("message", { type: "message", data: askingVersion2(data) })
    },
    close() {
      if (closed) return
      closed = true
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

/**
 * A frame whose `initialize`, alone or in a batch, asks for a version, with
 * that version set to 2, so the SDK answers the one version it serves rather
 * than refusing the handshake. Every other frame is passed on untouched.
 */
function askingVersion2(data: string) {
  let frame: unknown
  try {
    frame = JSON.parse(data)
  } catch {
    return data
  }
  const entries: unknown[] = Array.isArray(frame) ? frame : [frame]
  let asked = false
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue
    const { method, params } = entry as { method?: unknown; params?: unknown }
    if (
      method !== methods.agent.initialize ||
      typeof params !== "object" ||
      params === null ||
      Array.isArray(params)
    )
      continue
    const { protocolVersion } = params as { protocolVersion?: unknown }
    if (
      !Number.isInteger(protocolVersion) ||
      protocolVersion === ACP_PROTOCOL_VERSION
    )
      continue
    ;(params as { protocolVersion: number }).protocolVersion =
      ACP_PROTOCOL_VERSION
    asked = true
  }
  return asked ? JSON.stringify(frame) : data
}

function frameSize(raw: string | Uint8Array) {
  return typeof raw === "string"
    ? Buffer.byteLength(raw, "utf8")
    : raw.byteLength
}

/**
 * One serialized frame, or each message of a batch, as `shown` makes it
 * public. Any other frame is written as it is.
 */
function publicFrame(raw: string, shown: PublicErrors) {
  const frame = JSON.parse(raw) as unknown
  if (Array.isArray(frame))
    return JSON.stringify(frame.map((message) => publicMessage(message, shown)))
  const message = publicMessage(frame, shown)
  return message === frame ? raw : JSON.stringify(message)
}

/**
 * One message as `shown` makes it public: an error reply rebuilt from its
 * code alone, and an error notification from its Session and its code, which
 * is its message too. Any other message is returned as it is.
 */
function publicMessage(frame: unknown, shown: PublicErrors): unknown {
  if (typeof frame !== "object" || frame === null) return frame
  if ("error" in frame) {
    const { error } = frame
    return {
      ...frame,
      error: shown.reply(
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined
      ),
    }
  }
  if ("method" in frame && frame.method === AOS_METHODS.notify.error) {
    const params: Record<string, unknown> =
      "params" in frame &&
      typeof frame.params === "object" &&
      frame.params !== null
        ? { ...frame.params }
        : {}
    const code = shown.notice(params.code)
    return {
      ...frame,
      params: {
        ...(typeof params.sessionId === "string"
          ? { sessionId: params.sessionId }
          : {}),
        code,
        message: code,
      },
    }
  }
  return frame
}

function positiveLimit(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? value
    : fallback
}
