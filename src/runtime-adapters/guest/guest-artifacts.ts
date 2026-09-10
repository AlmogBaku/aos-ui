import { createBrowserArtifactAdapter } from "@/artifacts/browser-artifact-adapter"
import type {
  ArtifactAdapter,
  ArtifactResolveOptions,
} from "@/runtime-adapters/contracts"
import { GuestClient } from "./guest-client"

export class GuestArtifactAdapter implements ArtifactAdapter {
  readonly #browser = createBrowserArtifactAdapter()

  constructor(private readonly client: GuestClient) {}

  resolve(options: ArtifactResolveOptions): Promise<Blob> {
    const { artifact, signal } = options
    if (artifact.source.type !== "provider") {
      return this.#browser.resolve(options)
    }
    if (artifact.source.reference !== artifact.id) {
      throw new Error("Guest artifact identity is invalid")
    }
    return this.client.artifact(artifact.id, signal)
  }
}
