import { describe, expect, it } from "vitest"

import {
  OpenClawWorkspaceOwnershipError,
  createOpenClawWorkspace,
} from "./workspace"

function gateway(responses: Record<string, unknown>) {
  const requests: Array<{ method: string; params: unknown }> = []
  return {
    requests,
    request: async (method: string, params: unknown) => {
      requests.push({ method, params })
      return responses[method]
    },
  }
}

describe("OpenClaw workspace reads", () => {
  it("[CL1-WORKSPACE-001] projects only visible primary Agents from the official catalog", async () => {
    const native = gateway({
      "agents.list": {
        defaultId: "analyst",
        mainKey: "main",
        scope: "global",
        agents: [
          { id: "analyst", name: "Analyst", kind: "agent" },
          { id: "creator", name: "Creator", kind: "agent" },
          { id: "system", name: "System", kind: "system" },
          {
            id: "delegated",
            name: "Delegated",
            kind: "agent",
            createdVia: "agent",
            creatorAgentId: "analyst",
          },
        ],
      },
    })
    const workspace = createOpenClawWorkspace({
      client: native,
      hiddenAgentIds: ["creator"],
    })

    const result = await workspace.listAgents()

    expect(result.agents).toEqual([
      {
        summary: { kind: "ready", id: "analyst", name: "Analyst" },
        visibility: "visible",
        selectable: true,
        editable: false,
        revision: expect.any(String),
      },
    ])
  })

  it("[CL1-WORKSPACE-002] rejects a Session row whose key and declared owner disagree", async () => {
    const native = gateway({
      "agents.list": {
        defaultId: "analyst",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "analyst", name: "Analyst", kind: "agent" }],
      },
      "sessions.list": {
        sessions: [
          {
            key: "agent:analyst:main",
            agentId: "other",
            label: "Foreign",
          },
        ],
      },
    })
    const workspace = createOpenClawWorkspace({ client: native })

    await expect(workspace.listSessions("analyst", 50, 0)).rejects.toEqual(
      new OpenClawWorkspaceOwnershipError()
    )
  })

  it("[CL1-WORKSPACE-003] resolves an invited Session only from its exact deterministic owned key", async () => {
    const native = gateway({
      "agents.list": {
        defaultId: "interviewer",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "interviewer", name: "Interviewer", kind: "agent" }],
      },
      "sessions.list": {
        sessions: [
          {
            key: "agent:interviewer:aos-invite:guest_1",
            agentId: "interviewer",
            label: "Guest",
          },
        ],
      },
    })
    const workspace = createOpenClawWorkspace({ client: native })

    await expect(
      workspace.resolveInvitedSession("interviewer", "guest_1")
    ).resolves.toEqual({
      sessionId: "agent:interviewer:aos-invite:guest_1",
      created: false,
    })
    expect(native.requests.at(-1)).toEqual({
      method: "sessions.list",
      params: {
        agentId: "interviewer",
        search: "agent:interviewer:aos-invite:guest_1",
        limit: 100,
        offset: 0,
        sortBy: "updatedAt",
        configuredAgentsOnly: true,
        includeDerivedTitles: true,
      },
    })
  })
})
