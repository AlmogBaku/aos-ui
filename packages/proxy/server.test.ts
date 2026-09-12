import { describe, expect, it, vi } from "vitest"

import { startProxyServer } from "./server"

describe("Bun proxy server lifecycle", () => {
  it("stops accepting work and lets active requests drain", async () => {
    const stop = vi.fn(async () => undefined)
    const serve = vi.fn(() => ({ stop }))
    const server = startProxyServer({
      app: { fetch: vi.fn() },
      host: "127.0.0.1",
      port: 4100,
      shutdownGraceMs: 1_000,
      serve,
      installSignalHandlers: false,
    })
    await server.shutdown()
    expect(serve).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "127.0.0.1", port: 4100 })
    )
    expect(stop).toHaveBeenCalledWith(false)
  })
})
