import { describe, expect, it, vi } from "vitest"

import { ArtifactMissingError } from "@/artifacts/browser-artifact-adapter"

import { AosArtifactAdapter } from "./aos-artifacts"
import { AosClientError, AosRemoteClient } from "./aos-client"

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

  describe("reading a linked artifact through the lane's own client", () => {
    /** What the Session projector makes of an `artifact://art-1` link. */
    const linked = {
      id: "art-1",
      filename: "notes.md",
      mimeType: "text/markdown",
      source: { type: "provider" as const, reference: "art-1" },
    }
    const fetcher = () =>
      vi.fn<typeof fetch>(
        async () =>
          new Response("# Notes", {
            headers: { "content-type": "text/markdown" },
          })
      )
    const resolve = (client: AosRemoteClient, threadId: string) =>
      new AosArtifactAdapter(client).resolve({
        artifact: linked,
        agentId: "researcher",
        threadId,
        signal: new AbortController().signal,
      })

    it("reads an operator's artifact from its Session with same-origin credentials", async () => {
      const fetch = fetcher()
      const client = new AosRemoteClient({ fetcher: fetch })
      client.adoptSessionOwnership("session-1", "researcher")

      await expect(resolve(client, "session-1")).resolves.toBeInstanceOf(Blob)
      const [input, init] = fetch.mock.calls[0]!
      expect(String(input)).toBe(
        "/api/aos/v1/agents/researcher/sessions/session-1/artifacts/art-1"
      )
      expect(init?.credentials).toBe("same-origin")
      expect(new Headers(init?.headers).has("authorization")).toBe(false)
    })

    it("reads a guest's artifact from its invited Session with its bearer invitation", async () => {
      const fetch = fetcher()
      const client = new AosRemoteClient({
        fetcher: fetch,
        basePath: "/api/guest/v1",
        authorization: "Bearer invitation-token",
      })
      client.adoptSessionOwnership("guest_ref", "researcher")

      await expect(resolve(client, "guest_ref")).resolves.toBeInstanceOf(Blob)
      const [input, init] = fetch.mock.calls[0]!
      expect(String(input)).toBe(
        "/api/guest/v1/agents/researcher/sessions/guest_ref/artifacts/art-1"
      )
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer invitation-token"
      )
    })
  })
})
