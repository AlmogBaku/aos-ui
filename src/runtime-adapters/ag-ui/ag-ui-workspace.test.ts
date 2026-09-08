import { describe, expect, it } from "vitest"

import type { SessionMetadata } from "../contracts"
import { getWorkspaceCapabilities } from "../workspace-state"
import {
  createAgUiWorkspace,
  type AgUiWorkspaceTransport,
} from "./ag-ui-workspace"
import { runWorkspaceAdapterContract } from "../workspace-adapter.contract"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createHarness() {
  const creationTimeline: string[] = []
  const sessions: SessionMetadata[] = [
    {
      threadId: "thread-research",
      agentId: "research",
      updatedAt: "2026-09-04T08:00:00.000Z",
      status: "waiting-for-input" as const,
    },
  ]
  const transport: AgUiWorkspaceTransport = {
    listAgents: async () => [
      {
        kind: "ready",
        id: "research",
        name: "Research",
        description: "Synthesizes provider evidence",
      },
    ],
    listSessions: async () => sessions,
    loadSession: async () => ({ messages: [] }),
    createSession: async (agentId) => {
      creationTimeline.push(`creating:${agentId}`)
      const created = {
        threadId: "thread-created",
        agentId: agentId.endsWith("-mismatch") ? "writer" : agentId,
        updatedAt: "2026-09-04T09:00:00.000Z",
        status: "idle" as const,
      }
      creationTimeline.push(`created:${created.threadId}`)
      return created
    },
  }

  return {
    workspace: createAgUiWorkspace({ transport }),
    creationTimeline,
    expectedAgent: {
      kind: "ready" as const,
      id: "research",
      name: "Research",
      description: "Synthesizes provider evidence",
    },
    expectedSession: sessions[0],
    createdSession: {
      threadId: "thread-created",
      agentId: "research",
      updatedAt: "2026-09-04T09:00:00.000Z",
      status: "idle" as const,
    },
  }
}

runWorkspaceAdapterContract("AG-UI", createHarness)

describe("AG-UI capability mapping", () => {
  it("does not advertise workspace features absent from the protocol", () => {
    const { workspace } = createHarness()

    expect(getWorkspaceCapabilities(workspace)).toEqual({
      agentCatalog: true,
      agentVisibilityUpdates: false,
      agentUpdates: false,
      todos: false,
      agentCreation: false,
      activityEvents: false,
    })
  })

  it("keeps reverse-resolved Session requests isolated by requested thread", async () => {
    const first = deferred<readonly SessionMetadata[]>()
    const second = deferred<readonly SessionMetadata[]>()
    let request = 0
    const transport: AgUiWorkspaceTransport = {
      listAgents: async () => [],
      listSessions: () => (request++ === 0 ? first.promise : second.promise),
      loadSession: async () => ({ messages: [] }),
      createSession: async (agentId) => ({
        threadId: `thread-${agentId}`,
        agentId,
        updatedAt: "2026-09-04T10:00:00.000Z",
        status: "idle",
      }),
    }
    const workspace = createAgUiWorkspace({ transport })
    const currentRequest = workspace.getSessionMetadata(["thread-current"])
    const staleRequest = workspace.getSessionMetadata(["thread-stale"])
    const providerSnapshot: readonly SessionMetadata[] = [
      {
        threadId: "thread-current",
        agentId: "research",
        updatedAt: "2026-09-04T10:00:00.000Z",
        status: "running",
      },
      {
        threadId: "thread-stale",
        agentId: "research",
        updatedAt: "2026-09-04T09:00:00.000Z",
        status: "idle",
      },
    ]

    second.resolve(providerSnapshot)
    await expect(staleRequest).resolves.toEqual([providerSnapshot[1]])
    first.resolve(providerSnapshot)
    await expect(currentRequest).resolves.toEqual([providerSnapshot[0]])
  })
})
