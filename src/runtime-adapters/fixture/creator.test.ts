import { expect, it } from "vitest"
import { createFixtureWorkspace } from "./fixture-workspace"

it("creates an ordinary creator Session and never promotes its ownership", async () => {
  const workspace = createFixtureWorkspace()
  expect(workspace.agentCreator?.id).toBe("agent-builder")
  const session = await workspace.createSession("agent-builder")
  const before = workspace.listAllSessionMetadata().length
  workspace.completeAgentCreation(session.threadId, {
    kind: "ready",
    id: "new-agent",
    name: "New Agent",
  })
  expect(
    (await workspace.getSessionMetadata([session.threadId]))[0].agentId
  ).toBe("agent-builder")
  expect(workspace.listAllSessionMetadata()).toHaveLength(before)
  expect(
    (await workspace.listAgents()).some(({ id }) => id === "new-agent")
  ).toBe(true)
})
