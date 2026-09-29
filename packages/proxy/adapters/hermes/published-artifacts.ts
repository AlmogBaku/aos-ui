/**
 * The artifacts this proxy published live, before Hermes saved the row that
 * grants them. An uploaded image's id reaches the browser before its user row
 * persists, and a MEDIA line's id before the assistant row does, so a read in
 * that window finds nothing in history. Publishing is the grant: the proxy saw
 * this Session deliver the path. History stays the authority for anything
 * older; the oldest entries leave once the bound is reached, long after their
 * rows persisted.
 */
import type { HermesMediaArtifact } from "./media-artifacts"

const MAX_PUBLISHED_ARTIFACTS = 1_024

type Scope = { agentId: string; providerSessionId: string }

const keyOf = (scope: Scope, artifactId: string) =>
  JSON.stringify([scope.agentId, scope.providerSessionId, artifactId])

export class HermesPublishedArtifacts {
  readonly #entries = new Map<string, { reference: string; filename: string }>()

  record(scope: Scope, { reference, descriptor }: HermesMediaArtifact) {
    const key = keyOf(scope, descriptor.id)
    this.#entries.delete(key)
    this.#entries.set(key, { reference, filename: descriptor.filename })
    if (this.#entries.size > MAX_PUBLISHED_ARTIFACTS)
      this.#entries.delete(this.#entries.keys().next().value!)
  }

  find(scope: Scope, artifactId: string) {
    return this.#entries.get(keyOf(scope, artifactId))
  }
}
