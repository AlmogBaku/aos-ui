import { ArtifactMissingError } from "@/artifacts/browser-artifact-adapter"

import type { ArtifactAdapter, ArtifactResolveOptions } from "../contracts"
import { HgwClientError } from "@harness-gw/sdk"

type ArtifactClient = {
  readArtifact(
    sessionId: string,
    artifactId: string,
    signal?: AbortSignal
  ): Promise<Blob>
}

/** History binds the opaque id to its Session; the server authorizes the read. */
export class AosArtifactAdapter implements ArtifactAdapter {
  constructor(private readonly client: ArtifactClient) {}

  async resolve({
    artifact,
    sessionId,
    signal,
  }: ArtifactResolveOptions): Promise<Blob> {
    signal.throwIfAborted()
    if (
      artifact.source.type !== "provider" ||
      artifact.source.reference !== artifact.id
    )
      throw new Error("AOS artifact reference is invalid")
    try {
      return await this.client.readArtifact(sessionId, artifact.id, signal)
    } catch (error) {
      // Pruned bytes are a permanent, presentable state, not a failed request.
      if (error instanceof HgwClientError && error.kind === "artifact-missing")
        throw new ArtifactMissingError()
      throw error
    }
  }
}
