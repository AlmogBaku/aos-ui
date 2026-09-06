import { describe, expect, it } from "vitest"

import {
  getWorkspaceCapabilities,
  WorkspaceArtifactStore,
  WorkspaceEventCache,
} from "./workspace-state"
import type { WorkspaceAdapter } from "./contracts"

const minimumAdapter: WorkspaceAdapter = {
  listAgents: async () => [],
  refreshAgents: async () => [],
  getSessionMetadata: async () => [],
  createSession: async () => ({ threadId: "thread" }),
}

describe("workspace capabilities", () => {
  it("reports optional features honestly from the adapter surface", () => {
    expect(getWorkspaceCapabilities(minimumAdapter)).toEqual({
      agentCatalog: false,
      agentVisibilityUpdates: false,
      agentUpdates: false,
      todos: false,
      builderChat: false,
      agentDraftDeletion: false,
      agentDraftRetry: false,
      agentLifecycle: false,
      activityEvents: false,
    })

    expect(
      getWorkspaceCapabilities({
        ...minimumAdapter,
        updateAgent: async () => undefined,
        listAgentCatalog: async () => [],
        updateAgentVisibility: async () => undefined,
        subscribeTodos: () => () => undefined,
        openAgentBuilder: async () => ({
          threadId: "builder-thread",
          draftAgentId: "draft:builder-thread",
        }),
        deleteAgentDraft: async () => undefined,
        retryAgentDraft: async () => undefined,
        subscribeAgentLifecycle: () => () => undefined,
        subscribeActivity: () => () => undefined,
      })
    ).toEqual({
      agentCatalog: true,
      agentVisibilityUpdates: true,
      agentUpdates: true,
      todos: true,
      builderChat: true,
      agentDraftDeletion: true,
      agentDraftRetry: true,
      agentLifecycle: true,
      activityEvents: true,
    })
  })
})

describe("Plan and Todo independence", () => {
  it("stores Plans by message and Todos by Session without deriving one from the other", () => {
    const store = new WorkspaceArtifactStore()

    store.setPlan("message-1", {
      id: "plan-1",
      title: "Launch plan",
      steps: [{ id: "step-1", label: "Define scope", status: "active" }],
    })
    expect(store.getTodos("thread-1")).toEqual([])

    store.setTodos("thread-1", [
      { id: "todo-1", label: "Confirm audience", status: "pending" },
    ])
    expect(store.getPlan("message-1")?.title).toBe("Launch plan")
    expect(store.getPlan("thread-1")).toBeUndefined()
  })
})

describe("stale-event isolation", () => {
  it("updates the originating thread cache but never the visible thread", () => {
    const cache = new WorkspaceEventCache()
    cache.select({ agentId: "aster", threadId: "aster-current" })

    cache.apply({
      agentId: "mica",
      threadId: "mica-delayed",
      sequence: 2,
      payload: "delayed provider event",
    })

    expect(cache.eventsFor("mica", "mica-delayed")).toHaveLength(1)
    expect(cache.visibleEvents()).toEqual([])

    cache.apply({
      agentId: "aster",
      threadId: "aster-current",
      sequence: 1,
      payload: "visible event",
    })
    expect(cache.visibleEvents().map(({ payload }) => payload)).toEqual([
      "visible event",
    ])
  })

  it("rejects an event whose Agent does not own the selected thread", () => {
    const cache = new WorkspaceEventCache()
    cache.select({ agentId: "aster", threadId: "same-thread" })
    cache.apply({
      agentId: "mica",
      threadId: "same-thread",
      sequence: 1,
      payload: "wrong owner",
    })

    expect(cache.visibleEvents()).toEqual([])
  })

  it("keeps identical Session IDs isolated by their originating Agent", () => {
    const cache = new WorkspaceEventCache()
    cache.apply({
      agentId: "aster",
      threadId: "shared-session",
      sequence: 1,
      payload: "Aster event",
    })
    cache.apply({
      agentId: "mica",
      threadId: "shared-session",
      sequence: 1,
      payload: "Mica event",
    })

    expect(
      cache.eventsFor("aster", "shared-session").map(({ payload }) => payload)
    ).toEqual(["Aster event"])
    expect(
      cache.eventsFor("mica", "shared-session").map(({ payload }) => payload)
    ).toEqual(["Mica event"])
  })

  it("ignores duplicate or out-of-order event sequences per thread", () => {
    const cache = new WorkspaceEventCache()
    cache.select({ agentId: "aster", threadId: "thread-1" })
    cache.apply({
      agentId: "aster",
      threadId: "thread-1",
      sequence: 2,
      payload: "new",
    })
    cache.apply({
      agentId: "aster",
      threadId: "thread-1",
      sequence: 2,
      payload: "duplicate",
    })
    cache.apply({
      agentId: "aster",
      threadId: "thread-1",
      sequence: 1,
      payload: "old",
    })

    expect(cache.visibleEvents().map(({ payload }) => payload)).toEqual(["new"])
  })
})
