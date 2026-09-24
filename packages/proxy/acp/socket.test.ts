import { describe, expect, it } from "vitest"

import { AOS_JSONRPC_ERRORS, AOS_METHODS } from "../../protocol/acp"

import { createAcpSocket, type AcpSocketOptions } from "./socket"
import { PUBLIC_ERRORS } from "./validation"

const NOW = 1_700_000_000_000

function harness(overrides: Partial<AcpSocketOptions> = {}) {
  const closed: Array<{ code: number; reason: string }> = []
  const messages: string[] = []
  const closes: unknown[] = []
  let now = NOW
  const socket = createAcpSocket({
    close: (code, reason) => closed.push({ code, reason }),
    now: () => now,
    ...overrides,
  })
  socket.socket.addEventListener?.("message", (event) => {
    messages.push(String((event as { data: unknown }).data))
  })
  socket.socket.addEventListener?.("close", (event) => closes.push(event))
  return {
    socket,
    closed,
    messages,
    closes,
    advance(milliseconds: number) {
      now += milliseconds
    },
  }
}

describe("ACP WebSocket shim", () => {
  it("delivers text and decoded binary frames to the SDK listener", () => {
    const { socket, messages } = harness()

    socket.receive('{"jsonrpc":"2.0"}')
    socket.receive(new TextEncoder().encode('{"id":1}'))

    expect(messages).toEqual(['{"jsonrpc":"2.0"}', '{"id":1}'])
  })

  it("closes with 1008 when one inbound frame exceeds the frame cap", () => {
    const { socket, closed, messages, closes } = harness()

    socket.receive("a".repeat(1_100_001))

    expect(closed).toEqual([{ code: 1008, reason: "ACP frame too large" }])
    expect(messages).toEqual([])
    expect(closes).toHaveLength(1)
  })

  it("closes with 1008 when the inbound rate window overflows", () => {
    const { socket, closed, messages, advance } = harness({
      inputWindowMs: 1_000,
      maxInputFramesPerWindow: 2,
    })

    socket.receive("1")
    socket.receive("2")
    expect(closed).toEqual([])

    advance(1_000)
    socket.receive("3")
    socket.receive("4")
    expect(closed).toEqual([])

    socket.receive("5")
    expect(messages).toEqual(["1", "2", "3", "4"])
    expect(closed).toEqual([{ code: 1008, reason: "ACP rate exceeded" }])
  })

  it("closes with 1008 when the inbound byte window overflows", () => {
    const { socket, closed } = harness({ maxInputBytesPerWindow: 8 })

    socket.receive("123456789")

    expect(closed).toEqual([{ code: 1008, reason: "ACP rate exceeded" }])
  })

  it("queues outbound frames for the peer and notifies once per frame", () => {
    let notified = 0
    const { socket } = harness({
      notify: () => {
        notified += 1
      },
    })

    socket.socket.send("first")
    socket.socket.send("second")

    expect(notified).toBe(2)
    expect(socket.drain(1)).toEqual(["first"])
    expect(socket.drain()).toEqual(["second"])
    expect(socket.drain()).toEqual([])
  })

  it("writes a lane's error notice as its Session and a public code alone", () => {
    const { socket } = harness({ publicErrors: PUBLIC_ERRORS })
    const notice = (params: Record<string, unknown>) =>
      socket.socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: AOS_METHODS.notify.error,
          params,
        })
      )

    notice({ sessionId: "ref", code: "not_found", message: "not_found" })
    notice({ sessionId: "ref", code: "private detail", detail: "private" })
    notice({ code: 7, message: "private" })

    expect(socket.drain().map((raw) => JSON.parse(raw) as unknown)).toEqual([
      {
        jsonrpc: "2.0",
        method: AOS_METHODS.notify.error,
        params: { sessionId: "ref", code: "not_found", message: "not_found" },
      },
      {
        jsonrpc: "2.0",
        method: AOS_METHODS.notify.error,
        params: {
          sessionId: "ref",
          code: "internal_error",
          message: "internal_error",
        },
      },
      {
        jsonrpc: "2.0",
        method: AOS_METHODS.notify.error,
        params: { code: "internal_error", message: "internal_error" },
      },
    ])
  })

  it("closes with 1013 when the outbound queue overflows its byte budget", () => {
    const { socket, closed } = harness({ maxOutputBytes: 8 })

    socket.socket.send("12345")
    socket.socket.send("67890")

    expect(closed).toEqual([{ code: 1013, reason: "ACP output overloaded" }])
    expect(socket.drain()).toEqual([])
  })

  it("closes with 1013 when the outbound queue overflows its frame budget", () => {
    const { socket, closed } = harness({ maxOutputFrames: 1 })

    socket.socket.send("first")
    socket.socket.send("second")

    expect(closed).toEqual([{ code: 1013, reason: "ACP output overloaded" }])
  })

  it("refuses a request once the credential lapsed, as the last frame before it closes", () => {
    let lapsed = false
    const written: string[] = []
    const holder: { socket?: ReturnType<typeof harness>["socket"] } = {}
    const test = harness({
      lapsed: () => lapsed,
      notify: () => written.push(...(holder.socket?.drain() ?? [])),
    })
    holder.socket = test.socket
    test.socket.receive('{"jsonrpc":"2.0","id":1,"method":"session/prompt"}')

    lapsed = true
    test.socket.receive('{"jsonrpc":"2.0","id":2,"method":"session/prompt"}')
    test.socket.receive('{"jsonrpc":"2.0","id":3,"method":"session/prompt"}')

    expect(test.messages).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"session/prompt"}',
    ])
    expect(written.map((raw) => JSON.parse(raw) as unknown)).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        error: expect.objectContaining({
          code: AOS_JSONRPC_ERRORS.authenticationRequired,
        }),
      },
    ])
    expect(test.closed).toEqual([
      { code: 1008, reason: "ACP credential lapsed" },
    ])
  })

  it("writes nothing once the credential lapsed, and closes", () => {
    const written: string[] = []
    const test = harness({
      lapsed: () => true,
      notify: () => written.push("notified"),
    })

    test.socket.socket.send('{"jsonrpc":"2.0","method":"session/update"}')

    expect(written).toEqual([])
    expect(test.socket.drain()).toEqual([])
    expect(test.closed).toEqual([
      { code: 1008, reason: "ACP credential lapsed" },
    ])
  })

  it("forwards an SDK-initiated close to the peer exactly once", () => {
    const { socket, closed, closes } = harness()

    socket.socket.close(1002, "First message must be initialize")
    socket.socket.close(1011, "later")

    expect(closed).toEqual([
      { code: 1002, reason: "First message must be initialize" },
    ])
    expect(closes).toHaveLength(1)
  })

  it("ends the SDK session on a transport close without closing the peer", () => {
    const { socket, closed, closes, messages } = harness()

    socket.close()
    socket.close()
    socket.receive('{"jsonrpc":"2.0"}')
    socket.socket.send("ignored")

    expect(closes).toHaveLength(1)
    expect(closed).toEqual([])
    expect(messages).toEqual([])
    expect(socket.drain()).toEqual([])
  })
})
