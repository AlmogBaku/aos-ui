import { afterEach, describe, expect, it, vi } from "vitest"

import viteConfig from "../vite.config"

afterEach(() => vi.unstubAllEnvs())

describe("Hermes development proxy", () => {
  it("rewrites the upstream Host header to the bound Hermes origin", async () => {
    expect(typeof viteConfig).toBe("function")
    if (typeof viteConfig !== "function") return

    const config = await viteConfig({
      command: "serve",
      mode: "test",
      isSsrBuild: false,
      isPreview: false,
    })

    expect(config.server?.proxy?.["/hermes"]).toMatchObject({
      changeOrigin: true,
    })
    expect(config.server?.proxy?.["/auth"]).toMatchObject({
      changeOrigin: true,
    })
  })

  it("allows explicitly configured preview and development hostnames", async () => {
    vi.stubEnv(
      "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS",
      "anakin.tail33f954.ts.net"
    )
    expect(typeof viteConfig).toBe("function")
    if (typeof viteConfig !== "function") return

    const config = await viteConfig({
      command: "serve",
      mode: "test",
      isSsrBuild: false,
      isPreview: true,
    })

    expect(config.server?.allowedHosts).toEqual(["anakin.tail33f954.ts.net"])
    expect(config.preview?.allowedHosts).toEqual(["anakin.tail33f954.ts.net"])
  })
})
