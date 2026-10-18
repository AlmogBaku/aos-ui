import { afterEach, describe, expect, it, vi } from "vitest"

import viteConfig from "../vite.config"

afterEach(() => vi.unstubAllEnvs())

describe("Vite development server", () => {
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

    // The MCP App sandbox's name joins the hosts an operator lists.
    const allowed = ["anakin.tail33f954.ts.net", "sandbox.localhost"]
    expect(config.server?.allowedHosts).toEqual(allowed)
    expect(config.preview?.allowedHosts).toEqual(allowed)
  })
})
