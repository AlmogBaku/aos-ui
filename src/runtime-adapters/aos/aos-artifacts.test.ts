import { describe, expect, it, vi } from "vitest"

import { AosArtifactAdapter } from "./aos-artifacts"

describe("AOS artifact resolver", () => {
  it("requires the selected Session's authoritative artifact catalog before reading bytes", async () => {
    const listArtifacts = vi.fn(async () => [
      {
        id: "artifact-1",
        filename: "brief.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
      },
    ])
    const readArtifact = vi.fn(
      async () => new Blob(["pdf"], { type: "application/pdf" })
    )
    const adapter = new AosArtifactAdapter({ listArtifacts, readArtifact })

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
    expect(listArtifacts).toHaveBeenCalledWith("session-1")
    expect(readArtifact).toHaveBeenCalledWith(
      "session-1",
      "artifact-1",
      expect.any(AbortSignal)
    )
  })
})
