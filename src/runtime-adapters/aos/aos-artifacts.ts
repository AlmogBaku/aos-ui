import type { ArtifactAdapter, ArtifactResolveOptions } from "../contracts"

type ArtifactClient = {
  listArtifacts(threadId: string): Promise<
    readonly {
      id: string
      filename: string
      mimeType?: string
      sizeBytes?: number
    }[]
  >
  readArtifact(
    threadId: string,
    artifactId: string,
    signal?: AbortSignal
  ): Promise<Blob>
}

/** A catalog membership check prevents an arbitrary provider reference read. */
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
    const known = (await this.client.listArtifacts(threadId)).find(
      (candidate) => candidate.id === artifact.id
    )
    if (!known || known.filename !== artifact.filename)
      throw new Error("AOS artifact does not belong to the selected Session")
    signal.throwIfAborted()
    return this.client.readArtifact(threadId, known.id, signal)
  }
}
