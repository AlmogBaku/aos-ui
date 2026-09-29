import { describe, expect, it } from "vitest"

import { getWorkspaceCapabilities } from "./workspace-state"
import type { WorkspaceAdapter } from "./contracts"

const minimumAdapter: WorkspaceAdapter = {
  listAgents: async () => [],
  refreshAgents: async () => [],
  getSessionMetadata: async () => [],
  createSession: async () => ({ sessionId: "thread" }),
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
