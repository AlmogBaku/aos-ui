import { describe, expect, it } from "vitest"

import type {
  AgentSummary,
  SessionMetadata,
  WorkspaceAdapter,
} from "../contracts"

export type WorkspaceContractHarness = {
  workspace: WorkspaceAdapter
  expectedAgent: AgentSummary
  expectedSession: SessionMetadata
  createdSession: SessionMetadata
  creationTimeline: string[]
}

export function runWorkspaceAdapterContract(
  name: string,
  createHarness: () => WorkspaceContractHarness
) {
  describe(`${name} workspace contract`, () => {
    it("keeps provider Agent identities authoritative", async () => {
      const { workspace, expectedAgent } = createHarness()

      await expect(workspace.listAgents()).resolves.toContainEqual(
        expectedAgent
      )
      await expect(workspace.refreshAgents()).resolves.toContainEqual(
        expectedAgent
      )
    })

    it("returns only requested Sessions with their provider-owned Agent", async () => {
      const { workspace, expectedSession } = createHarness()

      await expect(
        workspace.getSessionMetadata([expectedSession.threadId, "missing"])
      ).resolves.toEqual([expectedSession])
    })

    it("finishes provider creation and records ownership before selection can continue", async () => {
      const { workspace, createdSession, creationTimeline } = createHarness()

      const created = await workspace.createSession(createdSession.agentId)
      creationTimeline.push(`selected:${created.threadId}`)

      expect(created).toEqual({ threadId: createdSession.threadId })
      expect(creationTimeline).toEqual([
        `creating:${createdSession.agentId}`,
        `created:${createdSession.threadId}`,
        `selected:${createdSession.threadId}`,
      ])
      await expect(
        workspace.getSessionMetadata([createdSession.threadId])
      ).resolves.toEqual([createdSession])
    })

    it("rejects a provider response that assigns the Session to another Agent", async () => {
      const { workspace, expectedAgent } = createHarness()

      await expect(
        workspace.createSession(`${expectedAgent.id}-mismatch`)
      ).rejects.toThrow("Session ownership mismatch")
    })
  })
}
