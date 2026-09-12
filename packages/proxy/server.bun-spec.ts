import { afterEach, describe, expect, it } from "bun:test"

import { startProxyServer } from "./server"

const lifecycles: Array<ReturnType<typeof startProxyServer>> = []

afterEach(async () => {
  await Promise.all(lifecycles.splice(0).map(({ shutdown }) => shutdown()))
})

describe("real Bun WebSocket upgrade", () => {
  it("authorizes before upgrade, drains frames, and cleans up on peer close", async () => {
    let opened = 0
    let closed = 0
    let resolveClosed!: () => void
    const peerClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    const lifecycle = startProxyServer({
      app: { fetch: () => new Response("not found", { status: 404 }) },
      events: {
        authorizeUpgrade: async (request) =>
          request.headers.get("origin") === "https://aos.example.test" &&
          request.headers.get("cookie") === "session=valid"
            ? {
                principalId: "principal",
                browserSessionId: "browser-session",
                authorizationExpiresAt: Date.now() + 60_000,
              }
            : undefined,
        open: (_authorization, peer) => {
          opened += 1
          peer.send(JSON.stringify({ type: "aos.ready", version: 1 }))
          return {
            async receive(raw) {
              if (raw === "notify")
                peer.send(
                  JSON.stringify({ type: "aos.invalidate", version: 1 })
                )
            },
            drain: () => [],
            close() {
              closed += 1
              resolveClosed()
            },
          }
        },
      },
      host: "127.0.0.1",
      port: 0,
      shutdownGraceMs: 1_000,
      installSignalHandlers: false,
    })
    lifecycles.push(lifecycle)
    const port = (lifecycle.server as unknown as { port: number }).port

    const denied = await fetch(`http://127.0.0.1:${port}/api/aos/v1/events`)
    expect(denied.status).toBe(401)
    expect(opened).toBe(0)

    const frames: unknown[] = []
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/aos/v1/events`, {
      headers: {
        Origin: "https://aos.example.test",
        Cookie: "session=valid",
      },
    })
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        frames.push(JSON.parse(String(event.data)))
        if (frames.length === 1) socket.send("notify")
        if (frames.length === 2) resolve()
      })
      socket.addEventListener("error", reject)
    })

    expect(frames).toEqual([
      { type: "aos.ready", version: 1 },
      { type: "aos.invalidate", version: 1 },
    ])
    expect(opened).toBe(1)
    socket.close()
    await peerClosed
    expect(closed).toBe(1)
  })
})
