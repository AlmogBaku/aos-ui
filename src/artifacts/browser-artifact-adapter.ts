import type {
  ArtifactAdapter,
  ArtifactResolveOptions,
} from "@/runtime-adapters/contracts"

type Fetcher = typeof fetch

type BrowserArtifactAdapterOptions = {
  fetcher?: Fetcher
  /** HTTPS origins admitted by the selected runtime's public configuration. */
  allowedOrigins?: readonly string[]
}

export class ArtifactUnavailableError extends Error {
  constructor(message = "This runtime cannot resolve this artifact") {
    super(message)
    this.name = "ArtifactUnavailableError"
  }
}

/**
 * The receipt outlived the bytes: the provider pruned the artifact it published,
 * so no retry can recover it. Distinct from a transient provider outage.
 */
export class ArtifactMissingError extends Error {
  constructor(message = "The provider no longer has this artifact") {
    super(message)
    this.name = "ArtifactMissingError"
  }
}

function isBlockedHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost")) return true

  const ipv4 = host.split(".").map(Number)
  if (
    ipv4.length === 4 &&
    ipv4.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
  ) {
    const [first, second] = ipv4
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    )
  }

  const ipv6 = host.replace(/^\[|\]$/g, "")
  return (
    ipv6 === "::" ||
    ipv6 === "::1" ||
    ipv6.startsWith("::ffff:") ||
    /^fe[89ab][0-9a-f]:/u.test(ipv6) ||
    /^f[cd][0-9a-f]{2}:/u.test(ipv6) ||
    /^::ffff:(?:127\.0\.0\.1|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(
      ipv6
    )
  )
}

function configuredOrigins(origins: readonly string[]) {
  return new Set(
    origins.flatMap((origin) => {
      try {
        const parsed = new URL(origin)
        return parsed.protocol === "https:" &&
          !parsed.username &&
          !parsed.password &&
          !isBlockedHost(parsed.hostname)
          ? [parsed.origin]
          : []
      } catch {
        return []
      }
    })
  )
}

function assertAllowedArtifactUrl(url: string, origins: ReadonlySet<string>) {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ArtifactUnavailableError("Artifact URL is not allowed")
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    isBlockedHost(parsed.hostname) ||
    !origins.has(parsed.origin)
  ) {
    throw new ArtifactUnavailableError("Artifact URL is not allowed")
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
  allowedOrigins = [],
}: BrowserArtifactAdapterOptions = {}): ArtifactAdapter {
  const origins = configuredOrigins(allowedOrigins)
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

      assertAllowedArtifactUrl(source.url, origins)
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
