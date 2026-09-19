import { describe, expect, it, vi } from "vitest"

import { ArtifactMissingError } from "@/artifacts/browser-artifact-adapter"

import { AosArtifactAdapter } from "./aos-artifacts"
import { AosClientError } from "./aos-client"

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

  it("presents bytes the provider pruned apart from a provider outage", async () => {
    const resolveWith = (error: AosClientError) =>
      new AosArtifactAdapter({
        readArtifact: vi.fn(async () => {
          throw error
        }),
      }).resolve({
        artifact: {
          id: "artifact-1",
          filename: "reply.mp3",
          mimeType: "audio/mpeg",
          source: { type: "provider", reference: "artifact-1" },
        },
        agentId: "researcher",
        threadId: "session-1",
        signal: new AbortController().signal,
      })

    await expect(
      resolveWith(new AosClientError("artifact-missing", "Artifact not found"))
    ).rejects.toBeInstanceOf(ArtifactMissingError)
    await expect(
      resolveWith(new AosClientError("provider-unavailable"))
    ).rejects.toBeInstanceOf(AosClientError)
  })
})
