import { expect, it } from "vitest"

import type { WorkspaceActivityEvent } from "../contracts"
import { createFixtureWorkspace } from "./fixture-workspace"

it("reports a created Agent as one activity receipt per outcome", async () => {
  const workspace = createFixtureWorkspace()
  const session = await workspace.createSession("agent-builder")
  const events: WorkspaceActivityEvent[] = []
  workspace.subscribeActivity((event) => events.push(event))

  workspace.completeAgentCreation(session.sessionId, {
    kind: "ready",
    id: "ready-agent",
    name: "Ready",
  })
  workspace.failAgentSetup(session.sessionId, "pending-agent", "Pending")

  expect(
    events.map(({ type, agentId, sessionId }) => ({ type, agentId, sessionId }))
  ).toEqual([
    {
      type: "agent-ready",
      agentId: "ready-agent",
      sessionId: session.sessionId,
    },
    {
      type: "agent-activation-failed",
      agentId: "pending-agent",
      sessionId: session.sessionId,
    },
  ])
  const agents = await workspace.listAgents()
  expect(agents.find(({ id }) => id === "pending-agent")?.visibility).toBe(
    "hidden"
  )
})
