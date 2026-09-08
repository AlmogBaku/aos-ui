import type { AbstractAgent } from "@ag-ui/client"
import { describe, expect, it, vi } from "vitest"

import { AgUiThreadListBridge } from "./ag-ui-thread-list-bridge"
import type { AgUiWorkspaceTransport } from "./ag-ui-workspace"
import { HttpAgent } from "@ag-ui/client"

describe("AgUiThreadListBridge", () => {
  it("clears selection without creating or stopping a native Session", async () => {
    const agent = new HttpAgent({ url: "http://example.test" })
    const createSession = vi.fn()
    const bridge = new AgUiThreadListBridge(agent, {
      listAgents: async () => [],
      listSessions: async () => [
        {
          threadId: "existing",
          agentId: "owner",
          updatedAt: "2026-09-07T00:00:00Z",
          status: "running",
        },
      ],
      createSession,
      loadSession: async () => ({ messages: [] }),
    })
    await bridge.initialize()
    bridge.select(undefined)
    expect(bridge.getSnapshot().activeThreadId).toBeUndefined()
    expect(agent.threadId).toBe("")
    expect(agent.agentId).toBeUndefined()
    expect(createSession).not.toHaveBeenCalled()
    await bridge.refresh()
    expect(bridge.getSnapshot().activeThreadId).toBeUndefined()
    bridge.select("existing")
    expect(agent.threadId).toBe("existing")
    expect(agent.agentId).toBe("owner")
  })

  it("never advertises resume without an attach adapter", async () => {
    const bridge = new AgUiThreadListBridge(
      new HttpAgent({ url: "http://example.test" }),
      {
        listAgents: async () => [],
        listSessions: async () => [
          {
            threadId: "inbound",
            agentId: "owner",
            updatedAt: "2026-09-07T00:00:00Z",
            status: "running",
          },
        ],
        createSession: async () => {
          throw new Error("unexpected create")
        },
        loadSession: async () => ({ messages: [], unstableResume: true }),
      }
    )
    expect(
      (await bridge.historyForThread("inbound").load()).unstable_resume
    ).not.toBe(true)
  })

  it("refreshes an initially empty list without stealing selection", async () => {
    const sessions: Awaited<
      ReturnType<AgUiWorkspaceTransport["listSessions"]>
    >[number][] = []
    const bridge = new AgUiThreadListBridge(
      new HttpAgent({ url: "http://example.test" }),
      {
        listAgents: async () => [],
        listSessions: async () => [...sessions],
        createSession: async () => {
          throw new Error("unexpected create")
        },
        loadSession: async () => ({ messages: [] }),
      }
    )
    await bridge.initialize()
    sessions.push({
      threadId: "inbound",
      agentId: "owner",
      updatedAt: "2026-09-07T00:00:00Z",
      status: "idle",
    })
    await bridge.refresh()
    expect(bridge.getSnapshot().sessions).toHaveLength(1)
    expect(bridge.getSnapshot().activeThreadId).toBeUndefined()
  })
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
