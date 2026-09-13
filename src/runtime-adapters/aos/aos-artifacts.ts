import type { ArtifactAdapter, ArtifactResolveOptions } from "../contracts"

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
    return this.client.readArtifact(threadId, artifact.id, signal)
  }
}
