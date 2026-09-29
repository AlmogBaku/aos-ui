import { describe, expect, it } from "vitest"

describe("official runtime clients", () => {
  it("constructs and closes the pinned OpenClaw gateway client", async () => {
    const { GatewayClient } = await import("@openclaw/gateway-client")
    const client = new GatewayClient({ url: "ws://127.0.0.1:18789" })

    await expect(client.stopAndWait()).resolves.toBeUndefined()
  })
})
