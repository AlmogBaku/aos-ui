import { ArtifactMissingError } from "@/artifacts/browser-artifact-adapter"

import type { ArtifactAdapter, ArtifactResolveOptions } from "../contracts"
import { AosClientError } from "./aos-client"

type ArtifactClient = {
  readArtifact(
    threadId: string,
    artifactId: string,
    signal?: AbortSignal
  ): Promise<Blob>
}

/** History binds the opaque id to its Session; the server authorizes the read. */
export class AosArtifactAdapter implements ArtifactAdapter {
  constructor(private readonly client: ArtifactClient) {}

  async resolve({
    artifact,
    threadId,
    signal,
  }: ArtifactResolveOptions): Promise<Blob> {
    signal.throwIfAborted()
    if (
      artifact.source.type !== "provider" ||
      artifact.source.reference !== artifact.id
    )
      throw new Error("AOS artifact reference is invalid")
    try {
      return await this.client.readArtifact(threadId, artifact.id, signal)
    } catch (error) {
      // Pruned bytes are a permanent, presentable state, not a failed request.
      if (error instanceof AosClientError && error.kind === "artifact-missing")
        throw new ArtifactMissingError()
      throw error
    }
  }
}
