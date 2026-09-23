const normalizeHttpsOrigins = (values: readonly string[]) => {
  const origins = new Set<string>()
  for (const value of values) {
    try {
      const url = new URL(value)
      if (url.protocol === "https:") origins.add(url.origin)
    } catch {
      // Ignore malformed configuration rather than widening the policy.
    }
  }
  return [...origins]
}

export function buildArtifactHtmlCsp(
  assetOrigins: readonly string[] = []
): string {
  const origins = normalizeHttpsOrigins(assetOrigins)
  const remote = origins.join(" ")
  const remoteOrNone = remote || "'none'"
  const withDataAndBlob = ["data:", "blob:", ...origins].join(" ")
  const withData = ["data:", ...origins].join(" ")

  return [
    "default-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `script-src 'unsafe-inline'${remote ? ` ${remote}` : ""}`,
    `style-src 'unsafe-inline'${remote ? ` ${remote}` : ""}`,
    `img-src ${withDataAndBlob}`,
    `media-src ${withDataAndBlob}`,
    `font-src ${withData}`,
    `connect-src ${remoteOrNone}`,
    `frame-src ${remoteOrNone}`,
  ].join("; ")
}

/**
 * Prepends a CSP meta so the policy governs every script the document holds;
 * `decorate` may adjust the parsed document before it is serialized.
 */
export function injectHtmlCsp(
  html: string,
  policy: string,
  decorate?: (document: Document) => void
): string {
  const document = new DOMParser().parseFromString(html, "text/html")
  const meta = document.createElement("meta")
  meta.httpEquiv = "Content-Security-Policy"
  meta.content = policy
  document.head.prepend(meta)
  decorate?.(document)
  return `<!doctype html>${document.documentElement.outerHTML}`
}

export function injectArtifactHtmlCsp(
  html: string,
  assetOrigins: readonly string[] = []
): string {
  return injectHtmlCsp(html, buildArtifactHtmlCsp(assetOrigins))
}
