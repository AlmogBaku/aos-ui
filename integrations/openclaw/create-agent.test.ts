import { describe, expect, it, vi } from "vitest"

import { createAgent } from "./create-agent.js"

const input = {
  agentId: "analyst",
  name: "Analyst",
  description: "Analyzes supplied evidence.",
  instructions: "Cite every conclusion to inspected evidence.",
  allowedCapabilities: ["structured-presentations"] as const,
}

describe("createAgent", () => {
  it("uses native atomic creation then CAS-protects the generated instructions", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        agents: [{ id: "agent-builder" }, { id: "researcher" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        agentId: "analyst",
        name: "analyst",
        workspace: "/agents/analyst",
      })
      .mockResolvedValueOnce({
        file: {
          name: "AGENTS.md",
          content: "# Existing bootstrap\n",
          hash: "hash-1",
        },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })

    const result = await createAgent(
      { request },
      { agentId: "agent-builder" },
      input,
      "agent-builder"
    )

    expect(request).toHaveBeenNthCalledWith(2, "agents.create", {
      name: "analyst",
    })
    expect(request).toHaveBeenNthCalledWith(
      4,
      "agents.files.set",
      expect.objectContaining({
        agentId: "analyst",
        name: "AGENTS.md",
        expectedHash: "hash-1",
        content: expect.stringContaining("Cite every conclusion"),
      })
    )
    expect(result.details).toMatchObject({
      type: "aos.agent-created",
      agent: { agentId: "analyst", status: "ready" },
    })
  })

  it("never overwrites an existing Agent", async () => {
    const request = vi.fn().mockResolvedValue({
      agents: [{ id: "agent-builder" }, { id: "analyst" }],
    })
    await expect(
      createAgent(
        { request },
        { agentId: "agent-builder" },
        input,
        "agent-builder"
      )
    ).rejects.toThrow(/already exists/i)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("rejects callers other than the configured creator before Gateway access", async () => {
    const request = vi.fn()
    await expect(
      createAgent(
        { request },
        { agentId: "researcher" },
        input,
        "agent-builder"
      )
    ).rejects.toThrow(/Agent Builder/i)
    expect(request).not.toHaveBeenCalled()
  })

  it("reports setup-needed instead of retrying after durable native creation", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ agents: [{ id: "agent-builder" }] })
      .mockResolvedValueOnce({
        ok: true,
        agentId: "analyst",
        name: "analyst",
        workspace: "/agents/analyst",
      })
      .mockRejectedValueOnce(new Error("bootstrap conflict"))

    const result = await createAgent(
      { request },
      { agentId: "agent-builder" },
      input,
      "agent-builder"
    )

    expect(result.details.agent).toMatchObject({
      agentId: "analyst",
      saved: true,
      status: "setup-needed",
    })
    expect(request).toHaveBeenCalledTimes(3)
    expect(result.content[0]?.text).toContain("Do not retry")
  })
})
