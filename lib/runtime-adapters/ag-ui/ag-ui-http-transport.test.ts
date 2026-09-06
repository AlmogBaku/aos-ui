import { describe, expect, it, vi } from "vitest"

import { createAgUiHttpWorkspaceTransport } from "./ag-ui-http-transport"

describe("AG-UI HTTP workspace transport", () => {
  it("maps the explicit workspace capability endpoints", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json([
          {
            id: "research",
            name: "Research",
            status: "idle",
            icon: { kind: "symbol", symbol: "compass", tone: "indigo" },
          },
        ])
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            threadId: "thread-research",
            agentId: "research",
            updatedAt: "2026-09-04T08:00:00.000Z",
            status: "running",
          },
        ])
      )
      .mockResolvedValueOnce(
        Response.json({
          threadId: "thread-created",
          agentId: "research",
          updatedAt: "2026-09-04T09:00:00.000Z",
          status: "idle",
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          messages: [
            { id: "message-1", role: "assistant", content: "Restored" },
          ],
          state: { selected: true },
        })
      )
    const transport = createAgUiHttpWorkspaceTransport({
      baseUrl: "https://agents.example/workspace/",
      fetcher,
    })

    await expect(transport.listAgents()).resolves.toHaveLength(1)
    await expect(transport.listSessions()).resolves.toHaveLength(1)
    await expect(
      transport.createSession("research", { title: "שיחה חדשה" })
    ).resolves.toMatchObject({ threadId: "thread-created" })
    await expect(transport.loadSession("thread-created")).resolves.toEqual({
      messages: [{ id: "message-1", role: "assistant", content: "Restored" }],
      state: { selected: true },
    })
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "https://agents.example/workspace/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ agentId: "research", title: "שיחה חדשה" }),
      })
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "https://agents.example/workspace/sessions/thread-created"
    )
  })

  it("rejects malformed provider payloads instead of manufacturing ownership", async () => {
    const transport = createAgUiHttpWorkspaceTransport({
      baseUrl: "https://agents.example/workspace",
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json([
          {
            threadId: "thread-research",
            updatedAt: "not-a-date",
            status: "idle",
          },
        ])
      ),
    })

    await expect(transport.listSessions()).rejects.toThrow(
      "invalid Session metadata"
    )
  })

  it("surfaces non-success responses with endpoint context", async () => {
    const transport = createAgUiHttpWorkspaceTransport({
      baseUrl: "https://agents.example/workspace",
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("down", { status: 503 })),
    })

    await expect(transport.listAgents()).rejects.toThrow(
      "AG-UI workspace request failed (503): /agents"
    )
  })
})
