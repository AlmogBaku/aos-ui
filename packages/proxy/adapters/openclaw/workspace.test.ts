import { describe, expect, it } from "vitest"

import {
  OPENCLAW_CREATOR_AGENT_ID,
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
        avatarEditable: false,
        revision: expect.any(String),
      },
    ])
  })

  it("[CL1-WORKSPACE-013] reports the reserved creator Agent as a hidden creator", async () => {
    const workspace = createOpenClawWorkspace({
      client: gateway({
        "agents.list": {
          defaultId: "analyst",
          mainKey: "main",
          scope: "global",
          agents: [
            { id: "analyst", name: "Analyst", kind: "agent" },
            {
              id: OPENCLAW_CREATOR_AGENT_ID,
              name: "Agent Creator",
              kind: "agent",
            },
          ],
        },
      }),
    })

    const result = await workspace.listAgents()

    expect(result.agents).toContainEqual({
      summary: {
        kind: "ready",
        id: OPENCLAW_CREATOR_AGENT_ID,
        name: "Agent Creator",
        visibility: "hidden",
        role: "creator",
      },
      visibility: "hidden",
      selectable: false,
      editable: false,
      avatarEditable: false,
      revision: expect.any(String),
    })
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

  it("[CL1-WORKSPACE-004] advertises a continuation for a full native page", async () => {
    const native = gateway({
      "agents.list": {
        defaultId: "analyst",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "analyst", name: "Analyst", kind: "agent" }],
      },
      "sessions.list": {
        sessions: Array.from({ length: 50 }, (_, index) => ({
          key: `agent:analyst:${index}`,
          agentId: "analyst",
          label: `Session ${index}`,
        })),
      },
    })
    const workspace = createOpenClawWorkspace({ client: native })

    await expect(
      workspace.listSessions("analyst", 50, 0)
    ).resolves.toMatchObject({
      total: 51,
      limit: 50,
      offset: 0,
    })
  })

  it("[CL1-WORKSPACE-005] globally pages beyond each Agent's first 100 Sessions", async () => {
    const native = gateway({
      "agents.list": {
        defaultId: "team.alpha",
        mainKey: "main",
        scope: "global",
        agents: [
          { id: "team.alpha", name: "Alpha", kind: "agent" },
          { id: "team:beta", name: "Beta", kind: "agent" },
        ],
      },
    })
    native.request = async (method: string, params: unknown) => {
      native.requests.push({ method, params })
      if (method === "agents.list")
        return {
          defaultId: "team.alpha",
          mainKey: "main",
          scope: "global",
          agents: [
            { id: "team.alpha", name: "Alpha", kind: "agent" },
            { id: "team:beta", name: "Beta", kind: "agent" },
          ],
        }
      if (
        !params ||
        typeof params !== "object" ||
        !("offset" in params) ||
        !("limit" in params) ||
        !("agentId" in params)
      )
        throw new Error("expected scoped OpenClaw Session params")
      const {
        offset: start,
        limit,
        agentId,
      } = params as {
        offset: number
        limit: number
        agentId: string
      }
      return {
        sessions: Array.from(
          { length: Math.min(limit, 150 - start) },
          (_, index) => ({
            key: `agent:${agentId}:session-${start + index}`,
            agentId,
            label: `${agentId}-${start + index}`,
            updatedAt: 1_000_000 - start - index,
          })
        ),
      }
    }
    const workspace = createOpenClawWorkspace({ client: native })

    const result = await workspace.listAllSessions(10, 210)

    expect(result.sessions).toHaveLength(10)
    expect(
      result.sessions.some((session) => session.id.endsWith("session-105"))
    ).toBe(true)
    expect(native.requests).toContainEqual({
      method: "sessions.list",
      params: expect.objectContaining({ agentId: "team.alpha", offset: 100 }),
    })
    expect(native.requests).toContainEqual({
      method: "sessions.list",
      params: expect.objectContaining({ agentId: "team:beta", offset: 100 }),
    })
  })

  it("[CL1-WORKSPACE-006] retains exact dotted and colon Agent IDs in invitation keys and ownership checks", async () => {
    const native = gateway({
      "agents.list": {
        defaultId: "team:alpha",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "team:alpha", name: "Alpha", kind: "agent" }],
      },
      "sessions.list": {
        sessions: [
          {
            key: "agent:team:alpha:aos-invite:guest_1",
            agentId: "team:alpha",
            label: "Guest",
          },
        ],
      },
    })
    const workspace = createOpenClawWorkspace({ client: native })

    await expect(
      workspace.resolveInvitedSession("team:alpha", "guest_1")
    ).resolves.toEqual({
      sessionId: "agent:team:alpha:aos-invite:guest_1",
      created: false,
    })
  })

  it("[CL1-WORKSPACE-007] opens a Session returned by the global catalog without prior verification", async () => {
    const native = gateway({
      "agents.list": {
        defaultId: "team.alpha",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "team.alpha", name: "Alpha", kind: "agent" }],
      },
      "sessions.list": {
        sessions: [
          {
            key: "agent:team.alpha:main",
            agentId: "team.alpha",
            label: "Global catalog Session",
          },
        ],
      },
    })
    const workspace = createOpenClawWorkspace({ client: native })

    const catalog = await workspace.listAllSessions(1, 0)
    const sessionId = catalog.sessions[0]!.id

    expect(workspace.resolveSessionId("team.alpha", sessionId)).toBe(sessionId)
    await expect(
      workspace.getSession("team.alpha", sessionId)
    ).resolves.toMatchObject({
      id: sessionId,
      agentId: "team.alpha",
    })
  })

  it("[CL1-WORKSPACE-008] resolves a cold direct URL as an opaque key before exact native ownership verification", async () => {
    const agentId = "team:alpha.beta"
    const sessionId = "agent:team:alpha.beta:main"
    const native = gateway({
      "agents.list": {
        defaultId: agentId,
        mainKey: "main",
        scope: "global",
        agents: [{ id: agentId, name: "Alpha", kind: "agent" }],
      },
      "sessions.list": {
        sessions: [{ key: sessionId, agentId, label: "Direct Session" }],
      },
    })
    const workspace = createOpenClawWorkspace({ client: native })

    expect(workspace.resolveSessionId(agentId, sessionId)).toBe(sessionId)
    await expect(
      workspace.getSession(agentId, sessionId)
    ).resolves.toMatchObject({
      id: sessionId,
      agentId,
    })
  })

  it("[CL1-WORKSPACE-009] creates an untitled native Session and verifies its exact owner", async () => {
    const agentId = "team:alpha.beta"
    const sessionId = "agent:team:alpha.beta:created-session"
    const native = gateway({
      "agents.list": {
        defaultId: agentId,
        mainKey: "main",
        scope: "global",
        agents: [{ id: agentId, name: "Alpha", kind: "agent" }],
      },
      "sessions.create": {
        ok: true,
        key: sessionId,
        sessionId: "created-session",
      },
      "sessions.list": {
        sessions: [{ key: sessionId, agentId }],
      },
    })
    const workspace = createOpenClawWorkspace({ client: native })

    await expect(workspace.createSession(agentId)).resolves.toEqual({
      session: { id: sessionId, agentId },
    })
    expect(native.requests).toContainEqual({
      method: "sessions.create",
      params: { agentId, toolOverrides: { mcpServers: { "aos-ui": true } } },
    })
    expect(native.requests.at(-1)).toEqual({
      method: "sessions.list",
      params: expect.objectContaining({ agentId, search: sessionId }),
    })
  })

  it("[CL1-WORKSPACE-010] rejects a newly created Session that cannot be proven to belong to the Agent", async () => {
    const sessionId = "agent:analyst:created-session"
    const native = gateway({
      "agents.list": {
        defaultId: "analyst",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "analyst", name: "Analyst", kind: "agent" }],
      },
      "sessions.create": { ok: true, key: sessionId },
      "sessions.list": {
        sessions: [{ key: sessionId, agentId: "other" }],
      },
    })
    const workspace = createOpenClawWorkspace({ client: native })

    await expect(workspace.createSession("analyst")).rejects.toEqual(
      new OpenClawWorkspaceOwnershipError()
    )
  })

  it("[CL1-WORKSPACE-011] projects native pin state only when a Session row proves it", async () => {
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
            key: "agent:analyst:pinned",
            agentId: "analyst",
            label: "Pinned",
            pinned: true,
            updatedAt: 2,
          },
          {
            key: "agent:analyst:untracked",
            agentId: "analyst",
            label: "Untracked",
            updatedAt: 1,
          },
        ],
      },
    })
    const workspace = createOpenClawWorkspace({ client: native })

    const page = await workspace.listSessions("analyst", 50, 0)

    expect(page.sessions[0]).toMatchObject({
      id: "agent:analyst:pinned",
      pinned: true,
    })
    expect(page.sessions[1]).not.toHaveProperty("pinned")
  })

  it("[CL1-WORKSPACE-012] verifies exact Session ownership before any native mutation", async () => {
    const native = gateway({
      "agents.list": {
        defaultId: "analyst",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "analyst", name: "Analyst", kind: "agent" }],
      },
      "sessions.list": {
        sessions: [{ key: "agent:other:main", agentId: "other" }],
      },
    })
    const workspace = createOpenClawWorkspace({ client: native })

    await expect(
      workspace.updateSession("analyst", "agent:other:main", {
        archived: true,
      })
    ).rejects.toEqual(new OpenClawWorkspaceOwnershipError())
    await expect(
      workspace.deleteSession("analyst", "agent:other:main")
    ).rejects.toEqual(new OpenClawWorkspaceOwnershipError())
    expect(
      native.requests.some(
        (request) =>
          request.method !== "agents.list" && request.method !== "sessions.list"
      )
    ).toBe(false)
  })
})
