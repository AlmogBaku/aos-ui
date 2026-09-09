import type {
  ArtifactAdapter,
  ArtifactResolveOptions,
} from "@/runtime-adapters/contracts"

type Fetcher = typeof fetch

export class ArtifactUnavailableError extends Error {
  constructor(message = "This runtime cannot resolve this artifact") {
    super(message)
    this.name = "ArtifactUnavailableError"
  }
}

const base64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function decodeBase64(value: string) {
  if (!base64Pattern.test(value)) {
    throw new Error("Artifact contains invalid base64 data")
  }
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  } catch {
    throw new Error("Artifact contains invalid base64 data")
  }
}

export function createBrowserArtifactAdapter({
  fetcher = fetch,
}: { fetcher?: Fetcher } = {}): ArtifactAdapter {
  return {
    async resolve({ artifact, signal }: ArtifactResolveOptions) {
      const { source } = artifact
      if (source.type === "provider") {
        throw new ArtifactUnavailableError(
          "This runtime cannot resolve provider artifacts"
        )
      }
      if (source.type === "inline") {
        const content =
          source.encoding === "utf8" ? source.data : decodeBase64(source.data)
        return new Blob([content], {
          type: artifact.mimeType ?? "application/octet-stream",
        })
      }

      const response = await fetcher(source.url, {
        credentials: "omit",
        redirect: "error",
        signal,
      })
      if (!response.ok) {
        throw new Error(
          `Artifact request failed with status ${response.status}`
        )
      }
      const blob = await response.blob()
      if (!artifact.mimeType || blob.type === artifact.mimeType) return blob
      return new Blob([await blob.arrayBuffer()], { type: artifact.mimeType })
    },
  }
}
