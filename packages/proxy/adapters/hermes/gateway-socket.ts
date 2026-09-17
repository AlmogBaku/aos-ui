/**
 * Wire guard for the socket handed to the vendored `JsonRpcGatewayClient`.
 *
 * The vendored client trusts its socket: `wireFrameText` decodes anything
 * string-ish and `handleFrame` parses it with no bounds. AOS runs that client
 * server-side against a native process, so every inbound frame is validated
 * before the vendored listener ever sees it:
 *
 *  - non-text data, an over-long frame, invalid UTF-8, unparseable JSON or a
 *    payload outside the JSON depth/node bound is a protocol fault: the socket
 *    generation is invalidated (pending calls become uncertain, the wrapper
 *    redials);
 *  - an `event` notification above `MAX_EVENT_FRAME_BYTES` is dropped instead,
 *    leaving a per-Session seq hole that `run.ts` resolves by catch-up — one
 *    huge frame must not interrupt every other Session on the shared socket;
 *  - a response above the byte bound its own caller registered rejects that one
 *    request and nothing else.
 *
 * A faulted or closed guard is latched dead: frames a real WebSocket had
 * already queued must not reach the vendored client, and must not fault again
 * on behalf of the socket that replaced this one.
 *
 * Everything else (correlation, timeouts, heartbeat, generations) stays with
 * the vendored client.
 */

import { boundedJsonShape, isRecord } from "./native"

/** Hard ceiling for any inbound frame; above it the socket is not trusted. */
export const MAX_SOCKET_FRAME_BYTES = 8 * 1024 * 1024
/** Ceiling for one `event` notification; above it the frame is dropped. */
export const MAX_EVENT_FRAME_BYTES = 2 * 1024 * 1024

export interface HermesSocket {
  readonly readyState: number
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
  send(value: string): void
  close(): void
}

export type HermesLog = {
  warn(event: string, fields: Record<string, unknown>): void
}

export type GuardedSocketOptions = {
  /** Protocol fault: the caller invalidates the socket generation. */
  onFault(reason: string): void
  /** Byte bound registered by the caller of the request with this id. */
  responseLimit(id: string): number | undefined
  /** A response exceeded its caller's bound; only that request fails. */
  onOversizedResponse(id: string): void
  log?: HermesLog
}

const decoder = new TextDecoder("utf-8", { fatal: true })

type Decoded = { text: string; bytes: number }

function decodeFrame(data: unknown): Decoded | undefined {
  if (typeof data === "string") {
    // One UTF-16 unit is at least one UTF-8 byte, so an over-long string is
    // rejected in O(1) before the exact native byte count the bounds need.
    if (data.length > MAX_SOCKET_FRAME_BYTES) return undefined
    const bytes = Buffer.byteLength(data, "utf8")
    return bytes > MAX_SOCKET_FRAME_BYTES ? undefined : { text: data, bytes }
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    const view =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    if (view.byteLength > MAX_SOCKET_FRAME_BYTES) return undefined
    try {
      return { text: decoder.decode(view), bytes: view.byteLength }
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Wrap `socket` so the vendored client's `message` listeners only ever see a
 * validated text frame. Every other part of the `WebSocket` surface the
 * vendored client uses is delegated unchanged.
 */
export function guardedHermesSocket(
  socket: HermesSocket,
  options: GuardedSocketOptions
): HermesSocket {
  const wrappers = new Map<(event: unknown) => void, (event: unknown) => void>()
  // Latched once this socket is unusable: a real WebSocket still dispatches
  // frames that were already queued when it faulted or was closed, and those
  // must not reach the vendored client or the fault path of a later socket.
  let dead = false

  const fault = (reason: string) => {
    dead = true
    options.log?.warn("hermes.gateway.frame_rejected", { reason })
    options.onFault(reason)
  }

  const receive = (event: unknown, listener: (event: unknown) => void) => {
    if (dead) return
    const decoded = decodeFrame(isRecord(event) ? event.data : undefined)
    if (!decoded) {
      fault("frame-unreadable")
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(decoded.text)
    } catch {
      fault("frame-malformed")
      return
    }
    if (!isRecord(frame) || !boundedJsonShape(frame)) {
      fault("frame-shape")
      return
    }
    if (frame.method === "event") {
      if (decoded.bytes > MAX_EVENT_FRAME_BYTES) {
        // A dropped event leaves a seq hole; the run layer catches up from the
        // native replay ring rather than losing the whole socket.
        options.log?.warn("hermes.gateway.event_frame_dropped", {
          bytes: decoded.bytes,
        })
        return
      }
      listener({ data: decoded.text })
      return
    }
    if (typeof frame.id === "string") {
      const limit = options.responseLimit(frame.id)
      if (limit !== undefined && decoded.bytes > limit) {
        options.log?.warn("hermes.gateway.response_too_large", {
          bytes: decoded.bytes,
          limit,
        })
        options.onOversizedResponse(frame.id)
        return
      }
    }
    listener({ data: decoded.text })
  }

  return {
    get readyState() {
      return socket.readyState
    },
    addEventListener(type, listener) {
      if (type !== "message") {
        socket.addEventListener(type, listener)
        return
      }
      const wrapper = (event: unknown) => receive(event, listener)
      wrappers.set(listener, wrapper)
      socket.addEventListener("message", wrapper)
    },
    removeEventListener(type, listener) {
      if (type !== "message") {
        socket.removeEventListener(type, listener)
        return
      }
      const wrapper = wrappers.get(listener)
      if (!wrapper) return
      wrappers.delete(listener)
      socket.removeEventListener("message", wrapper)
    },
    send(value) {
      socket.send(value)
    },
    close() {
      dead = true
      socket.close()
    },
  }
}
