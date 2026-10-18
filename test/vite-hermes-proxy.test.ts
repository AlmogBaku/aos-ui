import { afterEach, describe, expect, it, vi } from "vitest"

import viteConfig, { laneOriginsAt } from "../vite.config"

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

  it.each([
    ["set", "http://localhost:3001,http://127.0.0.1:3001", true],
    ["unset", undefined, false],
  ] as const)(
    "lets the guest lane's pages frame the sandbox it serves when their origins are %s",
    (_label, guest, framed) => {
      const operator = ["http://localhost:4200", "http://127.0.0.1:4200"]
      const origins = laneOriginsAt({
        AOS_UI_GUEST_PUBLIC_ORIGIN: guest,
      })(4200)

      expect(origins).toEqual({
        publicOrigins: operator,
        mcpAppSandboxOrigin: "http://sandbox.localhost:4200",
        mcpAppFrameAncestors: framed
          ? [...operator, "http://localhost:3001", "http://127.0.0.1:3001"]
          : operator,
      })
    }
  )
})
