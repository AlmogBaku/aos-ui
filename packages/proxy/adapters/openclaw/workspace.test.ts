import { describe, expect, it } from "vitest"

import type { AgentUpdatePatch } from "../../../protocol"
import { ServerAgentUpdateUnsupportedError } from "../../core/runtime"
import {
  OPENCLAW_CREATOR_AGENT_ID,
  OpenClawWorkspaceOwnershipError,
  OpenClawWorkspaceRevisionConflictError,
  OpenClawWorkspaceUnavailableError,
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

  it("[CL1-WORKSPACE-014] projects a Session's native creation time", async () => {
    const workspace = createOpenClawWorkspace({
      client: gateway({
        "agents.list": {
          defaultId: "agent-a",
          mainKey: "main",
          scope: "global",
          agents: [{ id: "agent-a", kind: "agent" }],
        },
        "sessions.list": {
          sessions: [
            { key: "agent:agent-a:one", agentId: "agent-a", createdAt: 1_000 },
            { key: "agent:agent-a:two", agentId: "agent-a" },
          ],
        },
      }),
    })

    const page = await workspace.listSessions("agent-a", 10, 0)

    expect(page.sessions[0]).toMatchObject({
      createdAt: "1970-01-01T00:00:01.000Z",
    })
    expect(page.sessions[1]).not.toHaveProperty("createdAt")
  })
})

/** Looks like a credential so any leak of the config payload is visible. */
const SECRET = "sk-sentinel-0000-do-not-leak"

type NativeAgent = { id: string; kind: "agent"; identity?: { avatar?: string } }

/**
 * A gateway whose `config.patch` behaves like OpenClaw's: it merges the one
 * Agent entry by id, so a later `agents.list` shows the stored avatar.
 */
function configuredGateway(input: {
  agents: NativeAgent[]
  configured: string[]
  applyPatch?: boolean
  config?: unknown
}) {
  const requests: Array<{ method: string; params: unknown }> = []
  let agents = input.agents
  return {
    requests,
    methods: () => requests.map((request) => request.method),
    request: async (method: string, params: unknown) => {
      requests.push({ method, params })
      if (method === "agents.list")
        return {
          defaultId: "agent-a",
          mainKey: "main",
          scope: "global",
          agents,
        }
      if (method === "config.get")
        return (
          input.config ?? {
            path: `/private/${SECRET}/openclaw.json`,
            exists: true,
            raw: `{ gateway: { auth: { token: "${SECRET}" } } }`,
            valid: true,
            hash: "hash-1",
            sourceConfig: {
              gateway: { auth: { token: SECRET } },
              agents: {
                list: input.configured.map((id) => ({
                  id,
                  identity: { name: SECRET },
                })),
              },
            },
            config: { gateway: { auth: { token: SECRET } } },
          }
        )
      if (method === "config.patch") {
        const patch = JSON.parse((params as { raw: string }).raw) as {
          agents: {
            list: Array<{ id: string; identity: { avatar: string | null } }>
          }
        }
        const entry = patch.agents.list[0]!
        if (input.applyPatch !== false)
          agents = agents.map((agent) =>
            agent.id !== entry.id
              ? agent
              : entry.identity.avatar === null
                ? { id: agent.id, kind: agent.kind }
                : { ...agent, identity: { avatar: entry.identity.avatar } }
          )
        return { ok: true }
      }
      throw new Error(`Unexpected method ${method} ${SECRET}`)
    },
  }
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected a rejection")
}

function leaks(value: unknown) {
  const text =
    value instanceof Error
      ? `${value.name} ${value.message} ${value.stack ?? ""} ${JSON.stringify(value)}`
      : JSON.stringify(value)
  return text.includes(SECRET) || text.includes("hash-1")
}

describe("OpenClaw Agent avatars", () => {
  it("[CL1-WORKSPACE-015] reads only a token avatar and lets only a configured non-creator Agent edit it", async () => {
    const native = configuredGateway({
      agents: [
        { id: "agent-a", kind: "agent", identity: { avatar: "ring/blue" } },
        { id: "agent-b", kind: "agent", identity: { avatar: "avatars/b.png" } },
        { id: "main", kind: "agent" },
        {
          id: OPENCLAW_CREATOR_AGENT_ID,
          kind: "agent",
          identity: { avatar: "ring/green" },
        },
      ],
      // The implicit default `main` has no entry of its own.
      configured: ["agent-a", "agent-b", OPENCLAW_CREATOR_AGENT_ID],
    })
    const workspace = createOpenClawWorkspace({ client: native })

    const catalog = await workspace.listAgents()

    expect(
      catalog.agents.map((agent) => ({
        id: agent.summary.id,
        avatar:
          agent.summary.kind === "ready" ? agent.summary.avatar : undefined,
        avatarEditable: agent.avatarEditable,
      }))
    ).toEqual([
      { id: "agent-a", avatar: "ring/blue", avatarEditable: true },
      { id: "agent-b", avatar: undefined, avatarEditable: true },
      {
        id: OPENCLAW_CREATOR_AGENT_ID,
        avatar: "ring/green",
        avatarEditable: false,
      },
      { id: "main", avatar: undefined, avatarEditable: false },
    ])
    expect(leaks(catalog)).toBe(false)
  })

  it("[CL1-WORKSPACE-016] keeps the catalog readable and non-editable when the config read fails or is unusable", async () => {
    for (const config of [
      { valid: false, hash: "hash-1", raw: SECRET, sourceConfig: {} },
      {
        hash: "hash-1",
        sourceConfig: { agents: { list: [{ name: SECRET }] } },
      },
      { sourceConfig: { agents: { list: SECRET } } },
      SECRET,
    ]) {
      const workspace = createOpenClawWorkspace({
        client: configuredGateway({
          agents: [{ id: "agent-a", kind: "agent" }],
          configured: ["agent-a"],
          config,
        }),
      })
      const catalog = await workspace.listAgents()
      expect(catalog.agents.map((agent) => agent.avatarEditable)).toEqual([
        false,
      ])
      expect(leaks(catalog)).toBe(false)
    }

    const failing = createOpenClawWorkspace({
      client: {
        request: async (method: string) => {
          if (method === "config.get") throw new Error(`denied ${SECRET}`)
          return {
            defaultId: "agent-a",
            mainKey: "main",
            scope: "global",
            agents: [{ id: "agent-a", kind: "agent" }],
          }
        },
      },
    })
    const catalog = await failing.listAgents()
    expect(catalog.agents.map((agent) => agent.avatarEditable)).toEqual([false])
    expect(leaks(catalog)).toBe(false)
  })

  it("[CL1-WORKSPACE-017] writes exactly one Agent's avatar against the read config hash and confirms it", async () => {
    const native = configuredGateway({
      agents: [
        { id: "agent-a", kind: "agent", identity: { avatar: "ring/blue" } },
        { id: "agent-b", kind: "agent" },
      ],
      configured: ["agent-a", "agent-b"],
    })
    const workspace = createOpenClawWorkspace({ client: native })
    const before = await workspace.listAgents()
    native.requests.length = 0

    const result = await workspace.updateAgent(
      "agent-a",
      { avatar: "ring/green" },
      before.agents[0]!.revision
    )

    expect(native.methods()).toEqual([
      "agents.list",
      "config.get",
      "config.patch",
      "agents.list",
      "config.get",
    ])
    expect(native.requests[2]!.params).toEqual({
      raw: JSON.stringify({
        agents: {
          list: [{ id: "agent-a", identity: { avatar: "ring/green" } }],
        },
      }),
      baseHash: "hash-1",
    })
    expect(result.agent).toMatchObject({
      summary: { id: "agent-a", avatar: "ring/green" },
      avatarEditable: true,
    })
    expect(result.revision).not.toBe(before.revision)
    expect(leaks(result)).toBe(false)

    native.requests.length = 0
    const cleared = await workspace.updateAgent(
      "agent-a",
      { avatar: null },
      result.agent.revision
    )
    expect(
      JSON.parse((native.requests[2]!.params as { raw: string }).raw)
    ).toEqual({
      agents: { list: [{ id: "agent-a", identity: { avatar: null } }] },
    })
    expect(cleared.agent.summary).not.toHaveProperty("avatar")
  })

  it("[CL1-WORKSPACE-018] refuses an update outside the avatar rule and writes nothing", async () => {
    const native = configuredGateway({
      agents: [
        { id: "agent-a", kind: "agent" },
        { id: "main", kind: "agent" },
        { id: OPENCLAW_CREATOR_AGENT_ID, kind: "agent" },
      ],
      configured: ["agent-a", OPENCLAW_CREATOR_AGENT_ID],
    })
    const workspace = createOpenClawWorkspace({ client: native })
    const catalog = await workspace.listAgents()
    const revisionOf = (id: string) =>
      catalog.agents.find((agent) => agent.summary.id === id)!.revision
    native.requests.length = 0

    // A patch that touches visibility is unsupported as a whole.
    for (const patch of [
      { visibility: "hidden" as const },
      { visibility: "visible" as const, avatar: "ring/blue" },
    ]) {
      const error = await rejection(
        workspace.updateAgent("agent-a", patch, revisionOf("agent-a"))
      )
      expect(error).toBeInstanceOf(ServerAgentUpdateUnsupportedError)
    }
    expect(native.requests).toEqual([])

    for (const id of ["main", OPENCLAW_CREATOR_AGENT_ID]) {
      const error = await rejection(
        workspace.updateAgent(id, { avatar: "ring/blue" }, revisionOf(id))
      )
      expect(error).toBeInstanceOf(ServerAgentUpdateUnsupportedError)
      expect(leaks(error)).toBe(false)
    }
    await expect(
      workspace.updateAgent("agent-z", { avatar: "ring/blue" }, "any")
    ).rejects.toBeInstanceOf(OpenClawWorkspaceOwnershipError)
    expect(native.methods()).not.toContain("config.patch")
  })

  it("[CL1-WORKSPACE-021] sends no native request for a malformed avatar reaching the workspace directly", async () => {
    const native = configuredGateway({
      agents: [{ id: "agent-a", kind: "agent" }],
      configured: ["agent-a"],
    })
    const workspace = createOpenClawWorkspace({ client: native })

    for (const avatar of ["Not A Token", "ring", "ring/blue/extra", 7])
      await expect(
        workspace.updateAgent(
          "agent-a",
          { avatar } as unknown as AgentUpdatePatch,
          "any"
        )
      ).rejects.toBeInstanceOf(ServerAgentUpdateUnsupportedError)
    expect(native.requests).toEqual([])
  })

  it("[CL1-WORKSPACE-019] rejects a stale Agent revision before reading the config", async () => {
    const native = configuredGateway({
      agents: [{ id: "agent-a", kind: "agent" }],
      configured: ["agent-a"],
    })
    const workspace = createOpenClawWorkspace({ client: native })

    const error = await rejection(
      workspace.updateAgent("agent-a", { avatar: "ring/blue" }, "stale")
    )

    expect(error).toBeInstanceOf(OpenClawWorkspaceRevisionConflictError)
    expect(native.methods()).toEqual(["agents.list"])
  })

  it("[CL1-WORKSPACE-020] reports an unconfirmed or unhashed write as unavailable without leaking the config", async () => {
    const unconfirmed = configuredGateway({
      agents: [{ id: "agent-a", kind: "agent" }],
      configured: ["agent-a"],
      applyPatch: false,
    })
    const workspace = createOpenClawWorkspace({ client: unconfirmed })
    const { agents } = await workspace.listAgents()
    const error = await rejection(
      workspace.updateAgent(
        "agent-a",
        { avatar: "ring/blue" },
        agents[0]!.revision
      )
    )
    expect(error).toBeInstanceOf(OpenClawWorkspaceUnavailableError)
    expect(leaks(error)).toBe(false)

    const unhashed = configuredGateway({
      agents: [{ id: "agent-a", kind: "agent" }],
      configured: ["agent-a"],
      config: {
        valid: true,
        raw: SECRET,
        sourceConfig: { agents: { list: [{ id: "agent-a" }] } },
      },
    })
    const other = createOpenClawWorkspace({ client: unhashed })
    const current = await other.listAgents()
    const missingHash = await rejection(
      other.updateAgent(
        "agent-a",
        { avatar: "ring/blue" },
        current.agents[0]!.revision
      )
    )
    expect(missingHash).toBeInstanceOf(OpenClawWorkspaceUnavailableError)
    expect(leaks(missingHash)).toBe(false)
    expect(unhashed.methods()).not.toContain("config.patch")
  })
})
