import { describe, expect, it } from "vitest"

import { createGatewayClient } from "./gateway-client"

describe("gateway client", () => {
  it("hands an MCP App view file addresses on the page's own origin", async () => {
    const files = "/api/v1/agents/a1/sessions/s1/tool-calls/c1/app/files"
    const client = createGatewayClient({
      fetcher: async () =>
        Response.json({
          html: "<p>app</p>",
          files: {
            addresses: { path: `${files}/path?pass=synthetic` },
            expiresAt: "2026-09-30T12:10:00.000Z",
          },
        }),
    })
    client.adoptSessionOwnership("s1", "a1")

    const view = await client.openMcpApp("s1", { toolCallId: "c1" })
    expect(view.files?.addresses.path).toBe(
      `${window.location.origin}${files}/path?pass=synthetic`
    )
  })
})
