import { describe, expect, it, vi } from "vitest"

import { startProxyServer } from "./server"

describe("Bun proxy server lifecycle", () => {
  it("disables Bun's request timeout only after the app returns an SSE response", async () => {
    const timeout = vi.fn()
    let served: Record<string, unknown> | undefined
    startProxyServer({
      app: {
        fetch: vi.fn((request: Request) =>
          new URL(request.url).pathname.endsWith("/runs")
            ? new Response(new ReadableStream(), {
                headers: { "content-type": "text/event-stream" },
              })
            : new Response("ok")
        ),
      },
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
      server: { timeout: typeof timeout }
    ) => Promise<Response | undefined>
    const runRequest = new Request(
      "https://aos.example.test/api/aos/v1/agents/a/sessions/s/runs",
      { method: "POST" }
    )

    await fetch(runRequest, { timeout })
    expect(timeout).toHaveBeenCalledWith(runRequest, 0)

    timeout.mockClear()
    await fetch(new Request("https://aos.example.test/api/aos/v1/healthz"), {
      timeout,
    })
    expect(timeout).not.toHaveBeenCalled()
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

  it("resolves shutdown at the grace deadline when a resource close cannot finish", async () => {
    vi.useFakeTimers()
    try {
      const stop = vi.fn(async () => undefined)
      const close = vi.fn(() => new Promise<void>(() => undefined))
      const server = startProxyServer({
        app: { fetch: vi.fn() },
        host: "127.0.0.1",
        port: 4100,
        shutdownGraceMs: 1_000,
        close,
        serve: vi.fn(() => ({ stop })),
        installSignalHandlers: false,
      })

      const shutdown = server.shutdown()
      let settled = false
      void shutdown.then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(close).toHaveBeenCalledOnce()
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1_000)
      await expect(shutdown).resolves.toBeUndefined()
      expect(stop).toHaveBeenCalledWith(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("authorizes event upgrades before opening a bounded event socket", async () => {
    const eventSocket = { receive: vi.fn(), close: vi.fn() }
    const eventService = {
      authorizeUpgrade: vi.fn(async (request: Request) =>
        request.headers.get("cookie") === "allowed"
          ? {
              principalId: "principal",
              browserSessionId: "session",
              authorizationExpiresAt: 10_000,
            }
          : undefined
      ),
      open: vi.fn(() => eventSocket),
    }
    let served: Record<string, unknown> | undefined
    const upgrade = vi.fn(() => true)
    const serve = vi.fn((options: Record<string, unknown>) => {
      served = options
      return { stop: vi.fn() }
    })
    startProxyServer({
      app: { fetch: vi.fn() },
      events: eventService,
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
      new Request("https://aos.example.test/api/aos/v1/events", {
        headers: { origin: "https://aos.example.test" },
      }),
      { upgrade }
    )
    expect(denied?.status).toBe(401)
    expect(upgrade).not.toHaveBeenCalled()
    expect(eventService.open).not.toHaveBeenCalled()

    const accepted = await fetch(
      new Request("https://aos.example.test/api/aos/v1/events", {
        headers: {
          origin: "https://aos.example.test",
          cookie: "allowed",
        },
      }),
      { upgrade }
    )
    expect(accepted).toBeUndefined()
    expect(eventService.open).not.toHaveBeenCalled()
    expect(upgrade).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        data: expect.objectContaining({
          authorization: expect.objectContaining({
            principalId: "principal",
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
    expect(eventService.open).toHaveBeenCalledTimes(1)
    websocket.message(peer, "subscribe")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(eventSocket.receive).toHaveBeenCalledWith("subscribe")
    websocket.close(peer)
    expect(eventSocket.close).toHaveBeenCalledTimes(1)
  })

  it("closes event peers above the configured listener limit with 1013", async () => {
    let served: Record<string, unknown> | undefined
    const upgradeData: unknown[] = []
    const eventSocket = { receive: vi.fn(), close: vi.fn() }
    startProxyServer({
      app: { fetch: vi.fn() },
      events: {
        authorizeUpgrade: vi.fn(async () => ({ principalId: "operator" })),
        open: vi.fn(() => eventSocket),
      },
      maxEventPeers: 1,
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
    const server = {
      upgrade(_request: Request, options: { data: unknown }) {
        upgradeData.push(options.data)
        return true
      },
    }
    await fetch(
      new Request("https://aos.example.test/api/aos/v1/events"),
      server
    )
    const websocket = served!.websocket as { open(peer: unknown): void }
    const first = { data: upgradeData[0], send: vi.fn(), close: vi.fn() }
    websocket.open(first)

    await fetch(
      new Request("https://aos.example.test/api/aos/v1/events"),
      server
    )
    const second = { data: upgradeData[1], send: vi.fn(), close: vi.fn() }
    websocket.open(second)

    expect(second.close).toHaveBeenCalledWith(
      1013,
      "Event peer capacity exceeded"
    )
  })

  it("contains event handler failures and closes the peer only once", async () => {
    const eventSocket = {
      receive: vi.fn(async () => {
        throw new Error("private receive failure")
      }),
      close: vi.fn(),
    }
    let served: Record<string, unknown> | undefined
    let data: unknown
    startProxyServer({
      app: { fetch: vi.fn() },
      events: {
        authorizeUpgrade: vi.fn(async () => ({
          principalId: "principal",
          browserSessionId: "session",
          authorizationExpiresAt: 10_000,
        })),
        open: vi.fn(() => eventSocket),
      },
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
    await fetch(new Request("https://aos.example.test/api/aos/v1/events"), {
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
    expect(eventSocket.close).toHaveBeenCalledOnce()
  })
})
