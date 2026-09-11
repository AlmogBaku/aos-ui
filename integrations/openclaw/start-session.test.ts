import { describe, expect, it, vi } from "vitest"

import { startSession } from "./start-session.js"

describe("startSession", () => {
  it("creates a target-owned root Session and submits kickoff atomically", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        agents: [
          { id: "researcher", name: "Researcher" },
          { id: "agent-builder", name: "Agent Builder" },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        key: "agent:researcher:aos-1",
        sessionId: "aos-1",
        runStarted: true,
      })

    const result = await startSession(
      { request },
      { agentId: "source", sessionKey: "agent:source:main" },
      { agentId: "researcher", title: "Investigate", kickoff: "Start here" },
      () => "operation-1",
      "agent-builder"
    )

    expect(request).toHaveBeenNthCalledWith(2, "sessions.create", {
      agentId: "researcher",
      displayName: "Investigate",
      titleSource: "Investigate",
      task: "Start here",
      idempotencyKey: "operation-1",
    })
    expect(result.details).toMatchObject({
      type: "aos.session-started",
      session: {
        sessionId: "aos-1",
        agentId: "researcher",
        sourceSessionKey: "agent:source:main",
        kickoff: "accepted",
      },
    })
  })

  it("does not target absent, system, or creator Agents", async () => {
    for (const agentId of ["missing", "openclaw", "agent-builder"]) {
      const request = vi.fn().mockResolvedValue({
        agents: [
          { id: "openclaw", name: "System" },
          { id: "agent-builder", name: "Agent Builder" },
        ],
      })
      await expect(
        startSession(
          { request },
          { agentId: "source", sessionKey: "agent:source:main" },
          { agentId },
          () => "operation-1",
          "agent-builder"
        )
      ).rejects.toThrow(/not available/i)
      expect(request).toHaveBeenCalledTimes(1)
    }
  })

  it("requires a cross-Agent target", async () => {
    const request = vi.fn().mockResolvedValue({ agents: [{ id: "source" }] })
    await expect(
      startSession(
        { request },
        { agentId: "source", sessionKey: "agent:source:main" },
        { agentId: "source" },
        () => "operation-1",
        "agent-builder"
      )
    ).rejects.toThrow(/another Agent/i)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("reports unknown kickoff acceptance without retrying", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ agents: [{ id: "researcher" }] })
      .mockResolvedValueOnce({
        ok: true,
        key: "agent:researcher:aos-2",
        sessionId: "aos-2",
        runStarted: false,
        runError: "timeout",
      })
    const result = await startSession(
      { request },
      { agentId: "source", sessionKey: "agent:source:main" },
      { agentId: "researcher", kickoff: "Start here" },
      () => "operation-2",
      "agent-builder"
    )

    expect(result.details.session.kickoff).toBe("unknown")
    expect(request).toHaveBeenCalledTimes(2)
  })
})
