import { describe, expect, it } from "vitest"

import { sandboxPolicyOrigins } from "./mcp-app-sandbox"

describe("sandboxPolicyOrigins", () => {
  const SANDBOX = "http://sandbox.localhost:3000"
  const KEY = "0123456789abcdef0123456789abcdef"
  const origins = {
    publicOrigins: ["http://localhost:3000"],
    mcpAppSandboxOrigin: SANDBOX,
    mcpAppFrameAncestors: ["http://localhost:3000"],
    mcpAppStableOrigins: "http://*.mcp-apps.localhost:3000",
  }

  it.each([
    ["is below another domain", `${KEY}.other.localhost`],
    [
      "has a key that is not 32 hex digits",
      `${KEY.slice(1)}.mcp-apps.localhost`,
    ],
  ])(
    "builds a view whose domain %s a policy for the shared sandbox",
    (_case, domain) => {
      expect(sandboxPolicyOrigins(origins, domain).sandboxOrigin).toBe(SANDBOX)
    }
  )
})
