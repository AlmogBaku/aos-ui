import { act, renderHook, waitFor } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import type {
  AgentSummary,
  WorkspaceAdapter,
} from "@/runtime-adapters/contracts"
import { useWorkspaceCatalog } from "./use-workspace-catalog"

it("coalesces discovery signals behind the initial catalog read", async () => {
  let initial!: (agents: AgentSummary[]) => void
  let notify!: () => void
  const discovered: AgentSummary = { kind: "ready", id: "new", name: "New" }
  const workspace: WorkspaceAdapter = {
    listAgents: () =>
      new Promise((resolve) => {
        initial = resolve
      }),
    refreshAgents: vi.fn(async () => [discovered]),
    getSessionMetadata: async () => [],
    createSession: async () => ({ threadId: "unused" }),
    subscribeAgentCatalog: (listener) => {
      notify = listener
      return () => {}
    },
  }
  const { result } = renderHook(() => useWorkspaceCatalog(workspace, 0))
  await act(async () => {
    notify()
    notify()
    notify()
  })
  expect(workspace.refreshAgents).not.toHaveBeenCalled()
  await act(async () => initial([]))
  await waitFor(() => expect(result.current.agents).toEqual([discovered]))
  expect(workspace.refreshAgents).toHaveBeenCalledTimes(1)
  expect(result.current.agents).toEqual([discovered])
  expect(result.current.agentsLoading).toBe(false)
})

it("unsubscribes and ignores delayed reads after unmount", async () => {
  let resolveRead!: (agents: AgentSummary[]) => void
  const unsubscribe = vi.fn()
  const workspace: WorkspaceAdapter = {
    listAgents: () =>
      new Promise((resolve) => {
        resolveRead = resolve
      }),
    refreshAgents: vi.fn(async () => []),
    getSessionMetadata: async () => [],
    createSession: async () => ({ threadId: "unused" }),
    subscribeAgentCatalog: () => unsubscribe,
  }
  const { result, unmount } = renderHook(() =>
    useWorkspaceCatalog(workspace, 0)
  )
  unmount()
  await act(async () =>
    resolveRead([{ kind: "ready", id: "late", name: "Late" }])
  )
  expect(unsubscribe).toHaveBeenCalledTimes(1)
  expect(result.current.agents).toEqual([])
})

it("keeps the last catalog when a refresh fails", async () => {
  let notify!: () => void
  const agent: AgentSummary = { kind: "ready", id: "native", name: "Native" }
  const workspace: WorkspaceAdapter = {
    listAgents: async () => [agent],
    refreshAgents: async () => {
      throw new Error("Native unavailable")
    },
    getSessionMetadata: async () => [],
    createSession: async () => ({ threadId: "unused" }),
    subscribeAgentCatalog: (listener) => {
      notify = listener
      return () => {}
    },
  }
  const { result } = renderHook(() => useWorkspaceCatalog(workspace, 0))
  await waitFor(() => expect(result.current.agents).toEqual([agent]))
  await act(async () => notify())
  await waitFor(() =>
    expect(result.current.agentError?.message).toBe("Native unavailable")
  )
  expect(result.current.agents).toEqual([agent])
})
