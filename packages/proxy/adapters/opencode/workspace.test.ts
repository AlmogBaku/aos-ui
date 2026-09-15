import { describe, expect, it } from "vitest"

import { createOpenCodeWorkspaceOperations } from "./workspace"

const session = (overrides: Record<string, unknown> = {}) => ({
  id: "session-1",
  agent: "research",
  title: "Research notes",
  time: { created: 1_000, updated: 2_000 },
  ...overrides,
})

describe("OpenCode workspace operations", () => {
  it("hides the creator and returns only exact-Agent owned Sessions in stable recent order", async () => {
    const operations = createOpenCodeWorkspaceOperations({
      client: {
        catalog: {
          agents: async () => ({
            data: [
              {
                id: "creator",
                description: "private",
                mode: "primary",
                hidden: false,
                permissions: [],
                request: {},
              },
              {
                id: "research",
                description: "Research",
                mode: "primary",
                hidden: false,
                permissions: [],
                request: {},
              },
            ],
          }),
        },
        sessions: {
          list: async () => ({
            data: [
              session({ id: "older", time: { created: 1, updated: 10 } }),
              session({
                id: "foreign",
                agent: "other",
                time: { created: 1, updated: 90 },
              }),
              session({ id: "newer", time: { created: 1, updated: 90 } }),
              session({
                id: "unowned",
                agent: undefined,
                time: { created: 1, updated: 100 },
              }),
            ],
            cursor: {},
          }),
          get: async () => session(),
          create: async () => session(),
        },
      },
      creatorAgentId: "creator",
    })

    await expect(operations.listAgents()).resolves.toMatchObject({
      agents: [{ summary: { id: "research" } }],
    })
    await expect(operations.listSessions("research", 50, 0)).resolves.toEqual({
      sessions: [
        {
          id: "newer",
          agentId: "research",
          title: "Research notes",
          archived: false,
          updatedAt: "1970-01-01T00:01:30.000Z",
          status: "idle",
        },
        {
          id: "older",
          agentId: "research",
          title: "Research notes",
          archived: false,
          updatedAt: "1970-01-01T00:00:10.000Z",
          status: "idle",
        },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    })
  })

  it("fails closed when an invite title has multiple exact-Agent matches", async () => {
    const operations = createOpenCodeWorkspaceOperations({
      client: {
        catalog: { agents: async () => ({ data: [] }) },
        sessions: {
          list: async () => ({
            data: [
              session({ id: "one", title: "aos-invite:guest-1" }),
              session({ id: "two", title: "aos-invite:guest-1" }),
            ],
            cursor: {},
          }),
          get: async () => session(),
          create: async () => session(),
        },
      },
    })

    await expect(
      operations.resolveInvitedSession("research", "guest-1")
    ).rejects.toMatchObject({ name: "OpenCodeWorkspaceUnavailableError" })
  })

  it("shares an in-flight exact-Agent invite lookup", async () => {
    let reads = 0
    let release: (() => void) | undefined
    const listed = new Promise<void>((resolve) => {
      release = resolve
    })
    const operations = createOpenCodeWorkspaceOperations({
      client: {
        catalog: { agents: async () => ({ data: [] }) },
        sessions: {
          list: async () => {
            reads += 1
            await listed
            return { data: [], cursor: {} }
          },
          get: async () => session(),
          create: async () => session(),
        },
      },
    })

    const first = operations.resolveInvitedSession("research", "guest-3")
    const second = operations.resolveInvitedSession("research", "guest-3")
    await Promise.resolve()
    expect(reads).toBe(1)
    release?.()
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ])
  })

  it("fails closed for a missing invite even when an untrusted title-create callback is offered", async () => {
    let created = false
    const operations = createOpenCodeWorkspaceOperations({
      client: {
        catalog: { agents: async () => ({ data: [] }) },
        sessions: {
          list: async () => ({
            data: created
              ? [session({ id: "invited", title: "aos-invite:guest-2" })]
              : [],
            cursor: {},
          }),
          get: async () => session(),
          create: async () => session(),
        },
      },
      createInvitedSession: async (agentId, title) => {
        created = agentId === "research" && title === "aos-invite:guest-2"
      },
    })

    await expect(
      operations.resolveInvitedSession("research", "guest-2", {
        firstTurnInstruction: "Start safely",
      })
    ).rejects.toMatchObject({ name: "OpenCodeWorkspaceUnavailableError" })
    expect(created).toBe(false)
  })

  it("does not expose a generic Session mutation operation", () => {
    const operations = createOpenCodeWorkspaceOperations({
      client: {
        catalog: { agents: async () => ({ data: [] }) },
        sessions: {
          list: async () => ({ data: [], cursor: {} }),
          get: async () => session({ agent: "other" }),
          create: async () => session(),
        },
      },
    })

    expect(operations).not.toHaveProperty("mutateSession")
  })

  it("advertises native models while retaining only token-accounting context and Todos as unavailable", () => {
    const operations = createOpenCodeWorkspaceOperations({
      client: {
        catalog: { agents: async () => ({ data: [] }) },
        sessions: {
          list: async () => ({ data: [], cursor: {} }),
          get: async () => session(),
          create: async () => session(),
        },
      },
    })

    expect(operations.capabilities()).toMatchObject({
      models: {
        status: "available",
        scope: "attached-session",
        selection: "native-session",
        choices: "provider-reported",
      },
      context: {
        status: "unavailable",
        reason: "native-context-accounting-unavailable",
      },
      todos: { status: "unavailable", reason: "native-todo-read-unavailable" },
    })
  })
})
