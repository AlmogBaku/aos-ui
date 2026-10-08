import { afterEach, describe, expect, it, vi } from "vitest"

import viteConfig from "../vite.config"

afterEach(() => vi.unstubAllEnvs())

describe("gateway development proxy", () => {
  it("routes only the gateway prefix to the configured gateway", async () => {
    vi.stubEnv("AOS_UI_GATEWAY_TARGET", "http://127.0.0.1:4310")
    expect(typeof viteConfig).toBe("function")
    if (typeof viteConfig !== "function") return
    const config = await viteConfig({
      command: "serve",
      mode: "test",
      isSsrBuild: false,
      isPreview: false,
    })
    expect(config.server?.proxy?.["/api/v1"]).toMatchObject({
      target: "http://127.0.0.1:4310",
      changeOrigin: false,
      ws: true,
    })
  })
})
