import { isMcpAppCspDomain, type McpUiCsp } from "@aos/protocol/mcp-apps"

/** The declared origins the shared rule admits, lowercased and deduplicated. */
export const acceptedDomains = (
  list: keyof McpUiCsp,
  values: readonly string[] | undefined
) => [
  ...new Set(
    (values ?? [])
      .filter((value) => isMcpAppCspDomain(list, value))
      .map((value) => value.toLowerCase())
  ),
]

const CSP_LISTS = [
  "connectDomains",
  "resourceDomains",
  "frameDomains",
  "baseUriDomains",
] as const satisfies readonly (keyof McpUiCsp)[]

/**
 * The domains the policy actually applies, per list, as the host reports them
 * in `hostCapabilities.sandbox.csp`; `undefined` when it applies none.
 */
export function appliedMcpAppCsp(
  csp: McpUiCsp | undefined
): McpUiCsp | undefined {
  const applied = Object.fromEntries(
    CSP_LISTS.flatMap((list) => {
      const domains = acceptedDomains(list, csp?.[list])
      return domains.length > 0 ? [[list, domains]] : []
    })
  ) as McpUiCsp
  return Object.keys(applied).length > 0 ? applied : undefined
}

const sources = (base: readonly string[], domains: readonly string[]) =>
  [...base, ...domains].join(" ") || "'none'"

/**
 * The MCP Apps default policy (spec 2026-01-26), widened only by the domains
 * the view's resource declared, and never allowing plugins or form posts.
 */
export function buildMcpAppCsp(csp: McpUiCsp | undefined): string {
  const connect = acceptedDomains("connectDomains", csp?.connectDomains)
  const resource = acceptedDomains("resourceDomains", csp?.resourceDomains)
  const frame = acceptedDomains("frameDomains", csp?.frameDomains)
  const baseUri = acceptedDomains("baseUriDomains", csp?.baseUriDomains)
  return [
    "default-src 'none'",
    `script-src ${sources(["'self'", "'unsafe-inline'"], resource)}`,
    `style-src ${sources(["'self'", "'unsafe-inline'"], resource)}`,
    `img-src ${sources(["'self'", "data:"], resource)}`,
    `font-src ${sources(["'self'", "data:"], resource)}`,
    `media-src ${sources(["'self'", "data:"], resource)}`,
    `connect-src ${sources([], connect)}`,
    "worker-src 'self' blob:",
    `frame-src ${sources([], frame)}`,
    `base-uri ${sources([], baseUri)}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ")
}
