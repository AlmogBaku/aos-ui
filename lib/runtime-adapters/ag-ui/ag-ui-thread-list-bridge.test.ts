import type { AbstractAgent } from "@ag-ui/client"
import { describe, expect, it, vi } from "vitest"

import { AgUiThreadListBridge } from "./ag-ui-thread-list-bridge"
import type { AgUiWorkspaceTransport } from "./ag-ui-workspace"

describe("AgUiThreadListBridge", () => {
  it("retries initialization after a transport failure and restores loading state", async () => {
    const sessions = [
      {
        threadId: "thread-recovered",
        agentId: "research",
        title: "Recovered session",
        updatedAt: "2026-09-04T10:00:00.000Z",
        status: "idle" as const,
      },
    ]
    const listSessions = vi
      .fn<AgUiWorkspaceTransport["listSessions"]>()
      .mockRejectedValueOnce(new Error("provider temporarily unavailable"))
      .mockResolvedValueOnce(sessions)
    const transport: AgUiWorkspaceTransport = {
      listAgents: async () => [],
      listSessions,
      createSession: async (agentId) => ({
        threadId: `thread-${agentId}`,
        agentId,
        updatedAt: "2026-09-04T10:00:00.000Z",
        status: "idle",
      }),
      loadSession: async () => ({ messages: [] }),
    }
    const agent = {
      threadId: "",
      agentId: undefined,
    } as unknown as AbstractAgent
    const bridge = new AgUiThreadListBridge(agent, transport)

    await expect(bridge.initialize()).rejects.toThrow(
      "provider temporarily unavailable"
    )
    expect(bridge.getSnapshot().isLoading).toBe(false)

    const retry = bridge.initialize()
    expect(bridge.getSnapshot().isLoading).toBe(true)
    await expect(retry).resolves.toBeUndefined()

    expect(listSessions).toHaveBeenCalledTimes(2)
    expect(bridge.getSnapshot()).toEqual({
      isLoading: false,
      sessions,
      activeThreadId: "thread-recovered",
    })
    expect(agent.threadId).toBe("thread-recovered")
    expect(agent.agentId).toBe("research")
  })
})
