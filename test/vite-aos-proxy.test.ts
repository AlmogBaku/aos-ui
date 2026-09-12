import { afterEach, describe, expect, it, vi } from "vitest"

import viteConfig from "../vite.config"

afterEach(() => vi.unstubAllEnvs())

describe("AOS development proxy", () => {
  it("routes only the normalized AOS prefix to the configured proxy", async () => {
    vi.stubEnv("AOS_UI_PROXY_TARGET", "http://127.0.0.1:4310")
    expect(typeof viteConfig).toBe("function")
    if (typeof viteConfig !== "function") return
    const config = await viteConfig({
      command: "serve",
      mode: "test",
      isSsrBuild: false,
      isPreview: false,
    })
    expect(config.server?.proxy?.["/api/aos/v1"]).toMatchObject({
      target: "http://127.0.0.1:4310",
      changeOrigin: false,
      ws: true,
    })
  })
})
