import { afterEach, describe, expect, it, vi } from "vitest"

import { startProxyServer, type ShutdownSettlement } from "./server"

describe("Bun proxy server lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** One listener whose stop, request count, and resource close are scripted. */
  function fakeListener(
    listener: {
      stop?: (closeActiveConnections?: boolean) => Promise<void> | void
      pendingRequests?: () => number
      close?: () => Promise<void> | void
    } = {}
  ) {
    const stop = vi.fn(listener.stop ?? (async () => undefined))
    const close = vi.fn(listener.close ?? (async () => undefined))
    const settlements: ShutdownSettlement[] = []
    let served: Record<string, unknown> | undefined
    const lifecycle = startProxyServer({
      app: { fetch: vi.fn() },
      sockets: [
        {
          path: "/api/aos/v1/acp",
          service: {
            authorizeUpgrade: vi.fn(async () => ({ principalId: "operator" })),
            open: vi.fn(() => ({ receive: vi.fn(), close: vi.fn() })),
          },
        },
      ],
      host: "127.0.0.1",
      port: 4100,
      shutdownGraceMs: 1_000,
      close,
      serve: vi.fn((options: Record<string, unknown>) => {
        served = options
        return {
          stop,
          get pendingRequests() {
            return listener.pendingRequests?.()
          },
        }
      }),
      onSettled: (settlement) => settlements.push(settlement),
      installSignalHandlers: false,
    })
    const connect = async () => {
      const fetch = served!.fetch as (
        request: Request,
        server: {
          upgrade(request: Request, options: { data: unknown }): boolean
        }
      ) => Promise<Response | undefined>
      let data: unknown
      await fetch(new Request("https://aos.example.test/api/aos/v1/acp"), {
        upgrade(_request, options) {
          data = options.data
          return true
        },
      })
      const peer = { data, send: vi.fn(), close: vi.fn() }
      ;(served!.websocket as { open(peer: unknown): void }).open(peer)
      return peer
    }
    return { lifecycle, stop, close, settlements, connect }
  }

  it("closes peers and releases the listener without waiting for a stop that never resolves", async () => {
    vi.useFakeTimers()
    // Bun leaves `stop(false)` pending forever once a peer has been upgraded.
    const listener = fakeListener({
      stop: (closeActiveConnections) =>
        closeActiveConnections === true
          ? Promise.resolve()
          : new Promise<void>(() => undefined),
    })
    const peer = await listener.connect()
    const startedAt = Date.now()

    await listener.lifecycle.shutdown()

    expect(peer.close).toHaveBeenCalledWith(1001, "Server shutting down")
    expect(listener.stop).toHaveBeenNthCalledWith(1, false)
    expect(listener.stop).toHaveBeenNthCalledWith(2, true)
    expect(listener.close).toHaveBeenCalledOnce()
    expect(listener.settlements).toEqual([{ forced: false }])
    expect(Date.now() - startedAt).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("waits for in-flight requests inside the grace", async () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const listener = fakeListener({
      pendingRequests: () => (Date.now() - startedAt < 500 ? 1 : 0),
    })

    let resolved = false
    const shutdown = listener.lifecycle.shutdown().then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(400)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(200)
    await shutdown
    expect(listener.settlements).toEqual([{ forced: false }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("forces the stop when in-flight requests outlive the grace", async () => {
    vi.useFakeTimers()
    const listener = fakeListener({ pendingRequests: () => 1 })

    let resolved = false
    const shutdown = listener.lifecycle.shutdown().then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await shutdown
    expect(listener.stop).toHaveBeenNthCalledWith(2, true)
    expect(listener.settlements).toEqual([{ forced: true }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("forces the stop when the provider close outlives the grace", async () => {
    vi.useFakeTimers()
    const listener = fakeListener({
      close: () => new Promise<void>(() => undefined),
    })

    const shutdown = listener.lifecycle.shutdown()
    await vi.advanceTimersByTimeAsync(1_000)
    await shutdown

    expect(listener.close).toHaveBeenCalledOnce()
    expect(listener.settlements).toEqual([{ forced: true }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("reports a clean settlement and closes resources once", async () => {
    const listener = fakeListener()

    await Promise.all([
      listener.lifecycle.shutdown(),
      listener.lifecycle.shutdown(),
    ])

    expect(listener.close).toHaveBeenCalledOnce()
    expect(listener.settlements).toEqual([{ forced: false }])
  })

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
