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
      agentUpdates: false,
      todos: false,
      agentCreation: false,
      activityEvents: false,
      sessionReadState: false,
      sessionRename: false,
      sessionArchival: false,
      sessionDeletion: false,
      sessionPin: false,
    })

    expect(
      getWorkspaceCapabilities(
        {
          ...minimumAdapter,
          updateAgent: async () => undefined,
          listAgentCatalog: async () => [],
          subscribeTodos: () => () => undefined,
          subscribeActivity: () => () => undefined,
        },
        [{ kind: "ready", id: "creator", name: "Creator", role: "creator" }]
      )
    ).toEqual({
      agentCatalog: true,
      agentUpdates: true,
      todos: true,
      agentCreation: true,
      activityEvents: true,
      sessionReadState: false,
      sessionRename: false,
      sessionArchival: false,
      sessionDeletion: false,
      sessionPin: false,
    })
  })

  it("offers only the Session actions the runtime declares", () => {
    expect(
      getWorkspaceCapabilities(minimumAdapter, [], {
        rename: true,
        archive: true,
        delete: false,
        pin: true,
      })
    ).toMatchObject({
      sessionRename: true,
      sessionArchival: true,
      sessionDeletion: false,
      sessionPin: true,
    })
  })
})

describe("Session-scoped Todos", () => {
  it("keeps Todos with the Session that owns them", () => {
    const store = new WorkspaceArtifactStore()

    expect(store.getTodos("thread-1")).toEqual([])

    store.setTodos("thread-1", [
      { id: "todo-1", label: "Confirm audience", status: "pending" },
    ])
    expect(store.getTodos("thread-1")).toEqual([
      { id: "todo-1", label: "Confirm audience", status: "pending" },
    ])
    expect(store.getTodos("thread-2")).toEqual([])
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
