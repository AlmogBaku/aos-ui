import { describe, expect, it, vi } from "vitest"

import { startProxyServer } from "./server"

describe("Bun proxy server lifecycle", () => {
  it("stops accepting work and lets active requests drain", async () => {
    const stop = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const serve = vi.fn(() => ({ stop }))
    const server = startProxyServer({
      app: { fetch: vi.fn() },
      host: "127.0.0.1",
      port: 4100,
      shutdownGraceMs: 1_000,
      close,
      serve,
      installSignalHandlers: false,
    })
    await server.shutdown()
    expect(serve).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "127.0.0.1", port: 4100 })
    )
    expect(stop).toHaveBeenCalledWith(false)
    expect(close).toHaveBeenCalledOnce()
  })

  it("authorizes socket upgrades before opening a bounded socket", async () => {
    const acpSocket = { receive: vi.fn(), close: vi.fn() }
    const acpService = {
      authorizeUpgrade: vi.fn(async (request: Request) =>
        request.headers.get("origin") === "https://aos.example.test"
          ? { principalId: "operator", connectionId: "connection-1" }
          : undefined
      ),
      open: vi.fn(() => acpSocket),
    }
    let served: Record<string, unknown> | undefined
    const upgrade = vi.fn(() => true)
    const serve = vi.fn((options: Record<string, unknown>) => {
      served = options
      return { stop: vi.fn() }
    })
    startProxyServer({
      app: { fetch: vi.fn() },
      sockets: [{ path: "/api/aos/v1/acp", service: acpService }],
      host: "127.0.0.1",
      port: 4100,
      shutdownGraceMs: 1_000,
      serve,
      installSignalHandlers: false,
    })
    const fetch = served!.fetch as (
      request: Request,
      server: { upgrade: typeof upgrade }
    ) => Promise<Response | undefined>
    const denied = await fetch(
      new Request("https://aos.example.test/api/aos/v1/acp", {
        headers: { origin: "https://attacker.example.test" },
      }),
      { upgrade }
    )
    expect(denied?.status).toBe(401)
    expect(upgrade).not.toHaveBeenCalled()
    expect(acpService.open).not.toHaveBeenCalled()

    const accepted = await fetch(
      new Request("https://aos.example.test/api/aos/v1/acp", {
        headers: { origin: "https://aos.example.test" },
      }),
      { upgrade }
    )
    expect(accepted).toBeUndefined()
    expect(acpService.open).not.toHaveBeenCalled()
    expect(upgrade).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        data: expect.objectContaining({
          authorization: expect.objectContaining({
            principalId: "operator",
          }),
        }),
      })
    )

    const websocket = served!.websocket as {
      open(peer: unknown): void
      message(peer: unknown, raw: string): void
      close(peer: unknown): void
    }
    const data = upgrade.mock.calls[0]![1].data
    const peer = { data, send: vi.fn(), close: vi.fn() }
    websocket.open(peer)
    expect(acpService.open).toHaveBeenCalledTimes(1)
    websocket.message(peer, "frame")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(acpSocket.receive).toHaveBeenCalledWith("frame")
    websocket.close(peer)
    expect(acpSocket.close).toHaveBeenCalledTimes(1)
  })

  it("hosts each socket path with its own peer budget and upgrade headers", async () => {
    const guestSocket = { receive: vi.fn(), close: vi.fn() }
    const operatorSocket = { receive: vi.fn(), close: vi.fn() }
    const operatorOpen = vi.fn(() => operatorSocket)
    const upgrades: Array<{
      data: unknown
      headers?: Record<string, string>
    }> = []
    let served: Record<string, unknown> | undefined
    startProxyServer({
      app: { fetch: vi.fn() },
      sockets: [
        {
          path: "/api/guest/v1/acp",
          service: {
            authorizeUpgrade: vi.fn(async () => ({ principalId: "guest" })),
            open: vi.fn(() => guestSocket),
          },
          maxPeers: 1,
        },
        {
          path: "/api/aos/v1/acp",
          service: {
            authorizeUpgrade: vi.fn(async () => ({
              principalId: "operator",
              connectionId: "connection-1",
              headers: { "Acp-Connection-Id": "connection-1" },
            })),
            open: operatorOpen,
          },
        },
      ],
      host: "127.0.0.1",
      port: 4100,
      shutdownGraceMs: 1_000,
      serve: vi.fn((options: Record<string, unknown>) => {
        served = options
        return { stop: vi.fn() }
      }),
      installSignalHandlers: false,
    })
    const fetch = served!.fetch as (
      request: Request,
      server: unknown
    ) => Promise<Response | undefined>
    const websocket = served!.websocket as {
      open(peer: unknown): void
      message(peer: unknown, raw: string): void
    }
    const server = {
      upgrade(
        _request: Request,
        options: { data: unknown; headers?: Record<string, string> }
      ) {
        upgrades.push(options)
        return true
      },
    }
    const connect = async (path: string) => {
      await fetch(new Request(`https://aos.example.test${path}`), server)
      const peer = {
        data: upgrades[upgrades.length - 1]!.data,
        send: vi.fn(),
        close: vi.fn(),
      }
      websocket.open(peer)
      return peer
    }

    await connect("/api/guest/v1/acp")
    const overBudget = await connect("/api/guest/v1/acp")
    expect(overBudget.close).toHaveBeenCalledWith(
      1013,
      "Event peer capacity exceeded"
    )

    const operatorPeer = await connect("/api/aos/v1/acp")
    expect(upgrades[2]!.headers).toEqual({
      "Acp-Connection-Id": "connection-1",
    })
    expect(operatorPeer.close).not.toHaveBeenCalled()
    expect(operatorOpen).toHaveBeenCalledTimes(1)
    websocket.message(operatorPeer, "frame")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(operatorSocket.receive).toHaveBeenCalledWith("frame")
    expect(guestSocket.receive).not.toHaveBeenCalled()
  })

  it("contains socket handler failures and closes the peer only once", async () => {
    const acpSocket = {
      receive: vi.fn(async () => {
        throw new Error("private receive failure")
      }),
      close: vi.fn(),
    }
    let served: Record<string, unknown> | undefined
    let data: unknown
    startProxyServer({
      app: { fetch: vi.fn() },
      sockets: [
        {
          path: "/api/aos/v1/acp",
          service: {
            authorizeUpgrade: vi.fn(async () => ({
              principalId: "operator",
              connectionId: "connection-1",
            })),
            open: vi.fn(() => acpSocket),
          },
        },
      ],
      host: "127.0.0.1",
      port: 4100,
      shutdownGraceMs: 1_000,
      serve: vi.fn((options: Record<string, unknown>) => {
        served = options
        return { stop: vi.fn() }
      }),
      installSignalHandlers: false,
    })
    const fetch = served!.fetch as (
      request: Request,
      server: { upgrade(request: Request, options: { data: unknown }): boolean }
    ) => Promise<Response | undefined>
    await fetch(new Request("https://aos.example.test/api/aos/v1/acp"), {
      upgrade(_request, options) {
        data = options.data
        return true
      },
    })
    const websocket = served!.websocket as {
      open(peer: unknown): void
      message(peer: unknown, raw: string): void
    }
    const peer = { data, send: vi.fn(), close: vi.fn() }
    websocket.open(peer)
    websocket.message(peer, "first")
    websocket.message(peer, "second")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(peer.close).toHaveBeenCalledOnce()
    expect(peer.close).toHaveBeenCalledWith(1011, "Event connection failed")
    expect(acpSocket.close).toHaveBeenCalledOnce()
  })
})
