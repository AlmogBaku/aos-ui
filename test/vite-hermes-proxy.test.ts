import { IncomingMessage } from "node:http"
import { Socket } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"

import viteConfig, { deploymentOriginsAt } from "../vite.config"

afterEach(() => vi.unstubAllEnvs())

/** Vite's configuration as `vite preview` resolves it. */
async function previewConfig() {
  if (typeof viteConfig !== "function") throw new Error("No config function")
  return viteConfig({
    command: "serve",
    mode: "test",
    isSsrBuild: false,
    isPreview: true,
  })
}

describe("Vite development server", () => {
  it("allows explicitly configured preview and development hostnames", async () => {
    vi.stubEnv("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS", "preview.example.test")
    vi.stubEnv(
      "AOS_UI_MCP_APP_STABLE_ORIGINS",
      "http://*.mcp-apps.localhost:3000"
    )
    const config = await previewConfig()

    // The MCP App sandbox's name and the stable origins' domain, with every
    // name below it, join the hosts an operator lists.
    const allowed = [
      "preview.example.test",
      "sandbox.localhost",
      ".mcp-apps.localhost",
    ]
    expect(config.server?.allowedHosts).toEqual(allowed)
    expect(config.preview?.allowedHosts).toEqual(allowed)
  })

  it.each([
    ["the sandbox", "SANDBOX.localhost:3000", false],
    [
      "a stable host, in any case",
      `${"AB".repeat(16)}.MCP-Apps.localhost:3000`,
      false,
    ],
    [
      "any other host below the stable origins' domain",
      `${"ab".repeat(15)}.mcp-apps.localhost:3000`,
      false,
    ],
    ["a lane's own host", "localhost:3000", undefined],
  ] as const)(
    "lets %s reach the gateway only when it is a lane's own host",
    async (_label, host, bypass) => {
      vi.stubEnv("AOS_UI_GATEWAY_TARGET", "http://127.0.0.1:4310")
      vi.stubEnv("AOS_UI_PUBLIC_ORIGIN", "http://localhost:3000")
      vi.stubEnv(
        "AOS_UI_MCP_APP_SANDBOX_ORIGIN",
        "http://sandbox.localhost:3000"
      )
      vi.stubEnv(
        "AOS_UI_MCP_APP_STABLE_ORIGINS",
        "http://*.mcp-apps.localhost:3000"
      )
      const proxy = (await previewConfig()).preview?.proxy?.["/api/v1"]
      if (typeof proxy !== "object") throw new Error("No gateway proxy")
      const request = new IncomingMessage(new Socket())
      request.headers.host = host

      expect(proxy.bypass?.(request, undefined, proxy)).toBe(bypass)
    }
  )

  it.each([
    [
      "every origin it lists, a guest page's too",
      "http://localhost:3000,http://localhost:3001",
      ["http://localhost:3000", "http://localhost:3001"],
    ],
    [
      "loopback names on the port it serves while it is unset",
      undefined,
      ["http://localhost:4200", "http://127.0.0.1:4200"],
    ],
  ] as const)(
    "reads AOS_UI_PUBLIC_ORIGIN as the pages that may frame the sandbox it serves: %s",
    (_label, listed, publicOrigins) => {
      const origins = deploymentOriginsAt({ AOS_UI_PUBLIC_ORIGIN: listed })(
        4200
      )

      expect(origins).toEqual({
        publicOrigins,
        mcpAppSandboxOrigin: "http://sandbox.localhost:4200",
      })
    }
  )
})
