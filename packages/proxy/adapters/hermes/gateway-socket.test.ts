import { describe, expect, it, vi } from "vitest"

import {
  guardedHermesSocket,
  MAX_EVENT_FRAME_BYTES,
  MAX_SOCKET_FRAME_BYTES,
} from "./gateway-socket"
import { FakeSocket } from "./test-utils/fake-socket"

function guarded(
  overrides: {
    responseLimit?: (id: string) => number | undefined
  } = {}
) {
  const socket = new FakeSocket()
  socket.autoReply = false
  const onFault = vi.fn()
  const onOversizedResponse = vi.fn()
  const log = { warn: vi.fn() }
  const received: unknown[] = []
  const listener = (event: unknown) => received.push(event)
  const guard = guardedHermesSocket(socket, {
    onFault,
    onOversizedResponse,
    responseLimit: overrides.responseLimit ?? (() => undefined),
    log,
  })
  guard.addEventListener("message", listener)
  socket.open()
  return {
    socket,
    guard,
    onFault,
    onOversizedResponse,
    log,
    received,
    listener,
  }
}

const eventFrame = (padding: number) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: {
      type: "message.delta",
      session_id: "live-secret",
      seq: 4,
      payload: { text: "x".repeat(padding) },
    },
  })

describe("guarded Hermes gateway socket", () => {
  it("forwards a validated text frame verbatim to the vendored listener", () => {
    const { socket, received, onFault } = guarded()
    const frame = eventFrame(4)

    socket.deliverText(frame)

    expect(received).toEqual([{ data: frame }])
    expect(onFault).not.toHaveBeenCalled()
    expect(socket.readyState).toBe(1)
  })

  it("decodes an ArrayBuffer view frame Bun may deliver as binary", () => {
    const { socket, received } = guarded()
    const frame = eventFrame(1)

    socket.deliverText(new TextEncoder().encode(frame))

    expect(received).toEqual([{ data: frame }])
  })

  it.each([
    ["a Blob", () => new Blob(["{}"])],
    ["a number", () => 42],
    ["nothing", () => undefined],
  ])("faults on non-text %s frame data", (_name, data) => {
    const { socket, received, onFault } = guarded()

    socket.deliverText(data())

    expect(received).toEqual([])
    expect(onFault).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["oversized text", () => "x".repeat(MAX_SOCKET_FRAME_BYTES + 1)],
    [
      "oversized binary",
      () => new Uint8Array(MAX_SOCKET_FRAME_BYTES + 1).fill(32),
    ],
    ["malformed JSON", () => "{"],
    ["a non-object payload", () => "null"],
    ["invalid UTF-8", () => Uint8Array.of(0x7b, 0xff, 0x7d)],
    ["a top-level array", () => "[]"],
    [
      "excessive depth",
      () =>
        JSON.stringify({
          jsonrpc: "2.0",
          method: "event",
          params: JSON.parse(`${"[".repeat(40)}null${"]".repeat(40)}`),
        }),
    ],
    [
      "excessive nodes",
      () =>
        JSON.stringify({
          jsonrpc: "2.0",
          method: "event",
          params: Array.from({ length: 200_001 }, () => 0),
        }),
    ],
  ])("faults without forwarding on %s", (_name, data) => {
    const { socket, received, onFault } = guarded()

    socket.deliverText(data())

    expect(received).toEqual([])
    expect(onFault).toHaveBeenCalledTimes(1)
  })

  it("drops an oversized event frame, keeps the socket, and delivers the next event", () => {
    const { socket, received, onFault, log } = guarded()
    const oversized = eventFrame(MAX_EVENT_FRAME_BYTES)
    expect(oversized.length).toBeGreaterThan(MAX_EVENT_FRAME_BYTES)
    const next = eventFrame(2)

    socket.deliverText(oversized)
    socket.deliverText(next)

    expect(received).toEqual([{ data: next }])
    expect(onFault).not.toHaveBeenCalled()
    expect(socket.readyState).toBe(1)
    expect(log.warn).toHaveBeenCalledTimes(1)
    const [, fields] = log.warn.mock.calls[0]!
    expect(JSON.stringify(fields)).not.toContain("live-secret")
  })

  it("rejects only the request whose response exceeds its registered bound", () => {
    const { socket, received, onFault, onOversizedResponse } = guarded({
      responseLimit: (id) => (id === "aos-1" ? 128 : undefined),
    })
    const bounded = JSON.stringify({
      jsonrpc: "2.0",
      id: "aos-1",
      result: { value: "x".repeat(256) },
    })
    const other = JSON.stringify({
      jsonrpc: "2.0",
      id: "aos-2",
      result: { value: "x".repeat(256) },
    })

    socket.deliverText(bounded)
    socket.deliverText(other)

    expect(received).toEqual([{ data: other }])
    expect(onOversizedResponse).toHaveBeenCalledWith("aos-1")
    expect(onFault).not.toHaveBeenCalled()
    expect(socket.readyState).toBe(1)
  })

  it("forwards a response that stays within its registered bound", () => {
    const { socket, received, onOversizedResponse } = guarded({
      responseLimit: () => 4_096,
    })
    const frame = JSON.stringify({ jsonrpc: "2.0", id: "aos-1", result: {} })

    socket.deliverText(frame)

    expect(received).toEqual([{ data: frame }])
    expect(onOversizedResponse).not.toHaveBeenCalled()
  })

  it("stops forwarding frames from a socket that already faulted", () => {
    const { socket, received, onFault } = guarded()

    socket.deliverText("{")
    socket.deliverText(eventFrame(1))

    expect(received).toEqual([])
    expect(onFault).toHaveBeenCalledTimes(1)
  })

  it("stops forwarding frames once the socket has been closed", () => {
    const { socket, guard, received, onFault } = guarded()

    guard.close()
    socket.deliverText(eventFrame(1))
    socket.deliverText("{")

    expect(received).toEqual([])
    expect(onFault).not.toHaveBeenCalled()
  })

  it("stops delivering to a removed message listener", () => {
    const { socket, guard, listener, received } = guarded()

    guard.removeEventListener("message", listener)
    socket.deliverText(eventFrame(1))

    expect(received).toEqual([])
  })

  it("delegates readyState, send, close and non-message listeners", () => {
    const socket = new FakeSocket()
    socket.autoReply = false
    const guard = guardedHermesSocket(socket, {
      onFault: vi.fn(),
      onOversizedResponse: vi.fn(),
      responseLimit: () => undefined,
    })
    const opened = vi.fn()
    const closed = vi.fn()
    guard.addEventListener("open", opened)
    guard.addEventListener("close", closed)

    expect(guard.readyState).toBe(0)
    socket.open()
    expect(guard.readyState).toBe(1)
    guard.send("frame")
    expect(socket.sent).toEqual(["frame"])
    guard.close()

    expect(opened).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(guard.readyState).toBe(3)
  })
})
