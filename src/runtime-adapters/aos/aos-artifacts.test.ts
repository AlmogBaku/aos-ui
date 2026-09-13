import { describe, expect, it, vi } from "vitest"

import { AosArtifactAdapter } from "./aos-artifacts"

describe("AOS artifact resolver", () => {
  it("resolves the history-bound artifact reference directly in its selected Session", async () => {
    const readArtifact = vi.fn(
      async () => new Blob(["pdf"], { type: "application/pdf" })
    )
    const adapter = new AosArtifactAdapter({ readArtifact })

    await expect(
      adapter.resolve({
        artifact: {
          id: "artifact-1",
          filename: "brief.pdf",
          source: { type: "provider", reference: "artifact-1" },
        },
        agentId: "researcher",
        threadId: "session-1",
        signal: new AbortController().signal,
      })
    ).resolves.toBeInstanceOf(Blob)
    expect(readArtifact).toHaveBeenCalledWith(
      "session-1",
      "artifact-1",
      expect.any(AbortSignal)
    )
  })

  it("rejects a provider reference that is not the normalized artifact id", async () => {
    const readArtifact = vi.fn(async () => new Blob())
    const adapter = new AosArtifactAdapter({ readArtifact })

    await expect(
      adapter.resolve({
        artifact: {
          id: "artifact-1",
          filename: "brief.pdf",
          source: { type: "provider", reference: "artifact:artifact-1" },
        },
        agentId: "researcher",
        threadId: "session-1",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("AOS artifact reference is invalid")
    expect(readArtifact).not.toHaveBeenCalled()
  })
})
