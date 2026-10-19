import { describe, expect, it, vi } from "vitest"

import { HgwClientError, McpAppFileReadError } from "@harness-gw/sdk"

import { McpAppResourceReadError } from "../contracts"
import { AosMcpAppAdapter } from "./aos-mcp-apps"

describe("AOS MCP App adapter", () => {
  it("names the reason the gateway gives for refusing a file read, and passes any other failure on as it came", async () => {
    const refused = new McpAppFileReadError(
      "denied",
      "gateway-failure",
      "Refused",
      "forbidden",
      403
    )
    const offline = new HgwClientError("connection-interrupted")
    // Only the SDK's file-read error names a reason; another error that
    // happens to carry one is no refusal of a file read.
    const unknown = Object.assign(new HgwClientError("gateway-failure"), {
      reason: "denied",
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
      updateMcpAppModelContext: vi.fn(),
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
