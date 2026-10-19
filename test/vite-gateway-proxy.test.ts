import { afterEach, describe, expect, it, vi } from "vitest"

import viteConfig from "../vite.config"

afterEach(() => vi.unstubAllEnvs())

async function devConfig() {
  if (typeof viteConfig !== "function") throw new Error("No config function")
  return viteConfig({
    command: "serve",
    mode: "test",
    isSsrBuild: false,
    isPreview: false,
  })
}

describe("gateway development proxy", () => {
  it("routes only the gateway prefix to the configured gateway", async () => {
    vi.stubEnv("AOS_UI_GATEWAY_TARGET", "http://127.0.0.1:4310")
    const config = await devConfig()
    for (const proxy of [config.server?.proxy, config.preview?.proxy])
      expect(proxy).toEqual({
        "/api/v1": expect.objectContaining({
          target: "http://127.0.0.1:4310",
          changeOrigin: false,
          ws: true,
        }),
      })
  })

  // A gateway on the usual port may be another deployment's, so there is no
  // default to fall back to.
  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])(
    "forwards nothing when the gateway setting is %s",
    async (_label, value) => {
      vi.stubEnv("AOS_UI_GATEWAY_TARGET", value)
      const config = await devConfig()
      expect(config.server?.proxy).toBeUndefined()
      expect(config.preview?.proxy).toBeUndefined()
    }
  )
})
