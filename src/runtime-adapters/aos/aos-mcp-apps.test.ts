import { describe, expect, it, vi } from "vitest"

import { HgwClientError } from "@harness-gw/sdk"

import { McpAppResourceReadError } from "../contracts"
import { AosMcpAppAdapter } from "./aos-mcp-apps"

describe("AOS MCP App adapter", () => {
  it("names the reason the gateway gives for refusing a read, and passes any other failure, or a reason it does not know, on as it came", async () => {
    // The SDK that types the reason is not released yet; its error carries it
    // as this one does.
    const refused = Object.assign(
      new HgwClientError("gateway-failure", "Refused", undefined, 403),
      { reason: "denied" }
    )
    const offline = new HgwClientError("connection-interrupted")
    const unknown = Object.assign(new HgwClientError("gateway-failure"), {
      reason: "quota",
    })
    const readMcpAppResource = vi
      .fn()
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(offline)
      .mockRejectedValueOnce(unknown)
    const adapter = new AosMcpAppAdapter({
      openMcpApp: vi.fn(),
      callMcpAppTool: vi.fn(),
      readMcpAppResource,
      renewMcpAppFiles: vi.fn(),
    })
    const read = () =>
      adapter.readResource({
        agentId: "researcher",
        sessionId: "session-1",
        toolCallId: "t1",
        uri: "https://aos.example.test/api/v1/agents/researcher/sessions/session-1/tool-calls/t1/app/files/path?pass=one",
      })

    const named = await read().catch((error: unknown) => error)
    expect(named).toBeInstanceOf(McpAppResourceReadError)
    expect(named).toMatchObject({ reason: "denied" })
    await expect(read()).rejects.toBe(offline)
    await expect(read()).rejects.toBe(unknown)
  })
})
