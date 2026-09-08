// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import { startSession } from "./start-session"

function createClient() {
  return {
    app: {
      agents: vi.fn(async () => ({
        data: [
          {
            name: "researcher",
            mode: "primary",
            native: false,
            hidden: false,
          },
        ],
      })),
    },
    session: {
      create: vi.fn(async () => ({
        data: { id: "session-new", agent: "researcher", parentID: undefined },
      })),
      promptAsync: vi.fn(async () => ({ data: undefined })),
    },
  }
}

describe("native start_session", () => {
  it("creates an independently owned root Session without a kickoff", async () => {
    const client = createClient()

    await expect(
      startSession(client, "/external/worktree", "session-caller", {
        agentId: "researcher",
        title: "Background research",
      })
    ).resolves.toEqual({
      version: 1,
      kind: "session-started",
      sessionId: "session-new",
      agentId: "researcher",
      created: true,
      kickoff: "not-requested",
    })
    expect(client.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { directory: "/external/worktree" },
        body: expect.objectContaining({
          title: "Background research",
          agent: "researcher",
          metadata: {
            aos_ui: {
              version: 1,
              kind: "inbound-session",
              agentId: "researcher",
              sourceSessionId: "session-caller",
            },
          },
        }),
        throwOnError: true,
      })
    )
    expect(client.session.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ parentID: expect.anything() }),
      })
    )
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("submits a kickoff exactly once after creation", async () => {
    const client = createClient()

    const result = await startSession(
      client,
      "/external/worktree",
      "session-caller",
      { agentId: "researcher", kickoff: "Investigate the outage." }
    )

    expect(result.kickoff).toBe("accepted")
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: "session-new" },
      query: { directory: "/external/worktree" },
      body: {
        agent: "researcher",
        parts: [{ type: "text", text: "Investigate the outage." }],
      },
      throwOnError: true,
    })
  })

  it("retains and reports the created Session when kickoff acceptance is ambiguous", async () => {
    const client = createClient()
    client.session.promptAsync.mockRejectedValueOnce(
      new Error("connection closed after request")
    )

    await expect(
      startSession(client, "/external/worktree", "session-caller", {
        agentId: "researcher",
        kickoff: "Investigate the outage.",
      })
    ).resolves.toMatchObject({
      sessionId: "session-new",
      created: true,
      kickoff: "unknown",
    })
    expect(client.session.create).toHaveBeenCalledTimes(1)
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
  })

  it("rejects an unavailable target before creating anything", async () => {
    const client = createClient()
    client.app.agents.mockResolvedValueOnce({ data: [] })

    await expect(
      startSession(client, "/external/worktree", "session-caller", {
        agentId: "missing",
      })
    ).rejects.toThrow(/not available/i)
    expect(client.session.create).not.toHaveBeenCalled()
  })

  it("rejects a provider ownership mismatch without sending a kickoff", async () => {
    const client = createClient()
    client.session.create.mockResolvedValueOnce({
      data: { id: "session-new", agent: "other", parentID: undefined },
    })

    await expect(
      startSession(client, "/external/worktree", "session-caller", {
        agentId: "researcher",
        kickoff: "Do work",
      })
    ).rejects.toThrow(/ownership mismatch/i)
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })
})
