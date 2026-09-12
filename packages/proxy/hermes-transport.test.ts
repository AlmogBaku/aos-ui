import { describe, expect, it, vi } from "vitest"

import {
  HermesAuthenticationError,
  HermesHttpError,
  HermesWebSocketRpcTransport,
  type HermesSocket,
} from "./hermes-transport"

class FakeSocket implements HermesSocket {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  readyState = 0
  sent: string[] = []

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  send(value: string) {
    this.sent.push(value)
    const frame = JSON.parse(value) as { id: string }
    queueMicrotask(() =>
      this.emit("message", {
        data: JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: { profiles: [] },
        }),
      })
    )
  }

  close() {
    this.readyState = 3
  }

  open() {
    this.readyState = 1
    this.emit("open", {})
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

describe("Hermes WebSocket RPC transport", () => {
  it.each([404, 409])(
    "preserves native REST status %i without exposing its response body",
    async (status) => {
      const transport = new HermesWebSocketRpcTransport({
        baseUrl: "http://hermes.test",
        credentials: async () => ({
          "X-Hermes-Session-Token": "secret",
        }),
        fetcher: vi.fn(
          async () => new Response("/private/path token=secret", { status })
        ),
      })

      const request = transport.http("/api/sessions/missing?profile=researcher")
      await expect(request).rejects.toMatchObject({ status })
      await expect(request).rejects.toBeInstanceOf(HermesHttpError)
      await expect(request).rejects.not.toThrow("private/path")
    }
  )

  it("keeps static credentials server-side for native REST Session reads", async () => {
    const fetcher = vi.fn(async () => Response.json({ sessions: [] }))
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://hermes.test",
      credentials: async () => ({ "X-Hermes-Session-Token": "secret" }),
      fetcher,
    })
    await expect(
      transport.http("/api/sessions?profile=researcher")
    ).resolves.toEqual({ sessions: [] })
    expect(fetcher).toHaveBeenCalledWith(
      "http://hermes.test/api/sessions?profile=researcher",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Hermes-Session-Token": "secret",
        }),
      })
    )
  })
  it("uses the configured static token only for native ws-ticket brokerage", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ ticket: "single-use-ticket" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    )
    const socket = new FakeSocket()
    const socketFactory = vi.fn(() => {
      queueMicrotask(() => socket.open())
      return socket
    })
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher,
      socketFactory,
      timeoutMs: 1_000,
    })

    await expect(
      transport.request("profiles.list", { include_sessions: false })
    ).resolves.toEqual({ profiles: [] })
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/auth/ws-ticket",
      expect.objectContaining({
        method: "POST",
        headers: {
          accept: "application/json",
          "X-Hermes-Session-Token": "native-secret",
        },
      })
    )
    expect(socketFactory).toHaveBeenCalledWith("ws://127.0.0.1:9119/api/ws", [
      "hermes-gateway-v1",
      "hermes-gateway-ticket.single-use-ticket",
    ])
    expect(socket.sent).toEqual([
      JSON.stringify({
        jsonrpc: "2.0",
        id: "aos-1",
        method: "profiles.list",
        params: { include_sessions: false },
      }),
    ])
  })

  it.each([401, 403])(
    "returns a typed private authentication failure for ticket status %i",
    async (status) => {
      const transport = new HermesWebSocketRpcTransport({
        baseUrl: "http://127.0.0.1:9119",
        credentials: async () => ({
          "X-Hermes-Session-Token": "native-secret",
        }),
        fetcher: vi.fn(async () => new Response("native details", { status })),
        socketFactory: vi.fn(),
        timeoutMs: 1_000,
      })
      await expect(
        transport.request("profiles.list", {})
      ).rejects.toBeInstanceOf(HermesAuthenticationError)
    }
  )
})
