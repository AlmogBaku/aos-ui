import type { AbstractAgent } from "@ag-ui/client"
import type { AssistantRuntime } from "@assistant-ui/react"
import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { getWorkspaceCapabilities } from "../workspace-state"

const { officialRuntime, useAgUiRuntime } = vi.hoisted(() => {
  const officialRuntime = {} as AssistantRuntime
  return {
    officialRuntime,
    useAgUiRuntime: vi.fn(() => officialRuntime),
  }
})

vi.mock("@assistant-ui/react-ag-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@assistant-ui/react-ag-ui")>()),
  useAgUiRuntime,
}))

import { useAgUiRuntimeBundle } from "./use-ag-ui-runtime-bundle"

describe("useAgUiRuntimeBundle", () => {
  it("composes the workspace around the official AG-UI runtime", () => {
    const agent = {
      agentId: "research",
      threadId: "thread-research",
    } as AbstractAgent
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
    expect(useAgUiRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        agent,
        unstable_enableMessageQueue: true,
      })
    )
  })
})
