import type { HttpAgent } from "@ag-ui/client"
import type { AssistantRuntime } from "@assistant-ui/react"
import { renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { getWorkspaceCapabilities } from "../workspace-state"

const { officialRuntime, useAgUiRuntime, useRemoteThreadListRuntime } = vi.hoisted(() => {
  const officialRuntime = {
    thread: {
      getState: () => ({ metadata: { remoteId: undefined } }),
    },
    threads: {
      reload: vi.fn(),
      getLoadThreadsPromise: () => Promise.resolve(),
      switchToThread: vi.fn(),
    },
  } as unknown as AssistantRuntime
  return {
    officialRuntime,
    useAgUiRuntime: vi.fn(() => officialRuntime),
    useRemoteThreadListRuntime: vi.fn(() => officialRuntime),
  }
})

vi.mock("@assistant-ui/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@assistant-ui/react")>()),
  useRemoteThreadListRuntime,
}))

vi.mock("@assistant-ui/react-ag-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@assistant-ui/react-ag-ui")>()),
  useAgUiRuntime,
}))

import { useAgUiRuntimeBundle } from "./use-ag-ui-runtime-bundle"
import { createAgUiWorkspace } from "./ag-ui-workspace"

vi.mock("./ag-ui-activity", () => ({
  createAgUiActivityPublisher: () => ({
    attach: vi.fn(),
    detach: vi.fn(),
    subscribe: vi.fn(),
  }),
}))

describe("useAgUiRuntimeBundle", () => {
  it("initializes discovery even when a concrete workspace bypasses the bridge transport", async () => {
    const agent = {
      threadId: "",
      agentId: undefined,
      clone() {
        return { ...this }
      },
    } as unknown as HttpAgent
    const session = {
      threadId: "inbound",
      agentId: "owner",
      updatedAt: "2026-09-07T00:00:00Z",
      status: "unknown" as const,
    }
    const transport = {
      listAgents: async () => [],
      listSessions: vi.fn(async () => [session]),
      loadSession: async () => ({ messages: [] }),
      createSession: async () => session,
    }
    const workspace = createAgUiWorkspace({ transport })
    renderHook(() =>
      useAgUiRuntimeBundle({ agent, workspaceTransport: transport, workspace })
    )
    await waitFor(() => expect(transport.listSessions).toHaveBeenCalledTimes(1))
    expect(agent.threadId).toBe("inbound")
  })
  it("composes the workspace around the official AG-UI runtime", () => {
    const agent = {
      agentId: "research",
      threadId: "thread-research",
      clone() {
        return { ...this }
      },
    } as unknown as HttpAgent
    const transport = {
      listAgents: async () => [],
      listSessions: async () => [],
      loadSession: async () => ({ messages: [] }),
      createSession: async () => ({
        threadId: "thread-research",
        agentId: "research",
        updatedAt: "2026-09-04T08:00:00.000Z",
        status: "idle" as const,
      }),
    }

    const { result } = renderHook(() =>
      useAgUiRuntimeBundle({ agent, workspaceTransport: transport })
    )

    expect(result.current.assistantRuntime).toBe(officialRuntime)
    expect(
      getWorkspaceCapabilities(result.current.workspace).activityEvents
    ).toBe(true)
    expect(useRemoteThreadListRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: expect.any(Object),
        runtimeHook: expect.any(Function),
      })
    )
    expect(useAgUiRuntime).not.toHaveBeenCalled()
  })
})
