import { describe, expect, it } from "vitest"

import { parseArtifactDescriptor } from "@/artifacts/artifacts"
import { classifyArtifactPreview } from "@/components/artifacts/artifact-renderers"

import {
  FIXTURE_ARTIFACT_CATALOG,
  createFixtureArtifactAdapter,
} from "./fixture-artifacts"

describe("fixture artifact adapter", () => {
  it("resolves deterministic inline UTF-8 and base64 artifacts", async () => {
    const adapter = createFixtureArtifactAdapter()
    const signal = new AbortController().signal

    const text = await adapter.resolve({
      artifact: {
        id: "notes",
        filename: "notes.txt",
        mimeType: "text/plain",
        source: { type: "inline", encoding: "utf8", data: "Fixture notes" },
      },
      agentId: "agent-aster",
      threadId: "thread-aster-market",
      signal,
    })
    const binary = await adapter.resolve({
      artifact: {
        id: "pixel",
        filename: "pixel.bin",
        source: { type: "inline", encoding: "base64", data: "AAEC" },
      },
      agentId: "agent-aster",
      threadId: "thread-aster-market",
      signal,
    })

    expect(await text.text()).toBe("Fixture notes")
    expect([...new Uint8Array(await binary.arrayBuffer())]).toEqual([0, 1, 2])
  })

  it("catalogs one deterministic example for every renderer kind", () => {
    expect(
      Object.values(FIXTURE_ARTIFACT_CATALOG.examples).map((artifact) =>
        classifyArtifactPreview(artifact.mimeType, artifact.filename)
      )
    ).toEqual([
      "markdown",
      "text",
      "code",
      "json",
      "csv",
      "image",
      "pdf",
      "audio",
      "video",
      "html",
      "unsupported",
    ])
    expect(
      Object.values(FIXTURE_ARTIFACT_CATALOG.examples).every(
        (artifact) => parseArtifactDescriptor(artifact) !== null
      )
    ).toBe(true)
  })

  it("catalogs malformed, unavailable-provider, and oversized cases", async () => {
    expect(
      parseArtifactDescriptor(FIXTURE_ARTIFACT_CATALOG.malformedDescriptor)
    ).toBeNull()
    expect(
      parseArtifactDescriptor(FIXTURE_ARTIFACT_CATALOG.missingProviderReference)
    ).not.toBeNull()
    expect(
      FIXTURE_ARTIFACT_CATALOG.oversizedDescriptor.sizeBytes
    ).toBeGreaterThan(25 * 1024 * 1024)

    await expect(
      createFixtureArtifactAdapter().resolve({
        artifact: FIXTURE_ARTIFACT_CATALOG.missingProviderReference,
        agentId: "agent-aster",
        threadId: "thread-aster-market",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("Fixture artifact reference is unavailable")
  })
})
