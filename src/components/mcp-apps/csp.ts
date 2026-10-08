import {
  isMcpAppCspDomain,
  type McpAppFiles,
  type McpUiCsp,
} from "@harness-gw/sdk/protocol"

import { fileLocation } from "./host-handlers"

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
 * the view's resource declared and by the call's own file addresses, each by
 * its exact path, to read and to play, and never allowing plugins or form posts. Views may compile
 * WebAssembly, as a document renderer's decoders do.
 */
export function buildMcpAppCsp(
  csp: McpUiCsp | undefined,
  files?: McpAppFiles
): string {
  // The view reads its files, and plays one that is media, at their addresses.
  const fileLocations = Object.values(files?.addresses ?? {}).flatMap(
    (address) => fileLocation(address) ?? []
  )
  const connect = [
    ...acceptedDomains("connectDomains", csp?.connectDomains),
    ...fileLocations,
  ]
  const resource = acceptedDomains("resourceDomains", csp?.resourceDomains)
  const frame = acceptedDomains("frameDomains", csp?.frameDomains)
  const baseUri = acceptedDomains("baseUriDomains", csp?.baseUriDomains)
  return [
    "default-src 'none'",
    `script-src ${sources(["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"], resource)}`,
    `style-src ${sources(["'self'", "'unsafe-inline'"], resource)}`,
    `img-src ${sources(["'self'", "data:"], resource)}`,
    `font-src ${sources(["'self'", "data:"], resource)}`,
    `media-src ${sources(["'self'", "data:"], [...resource, ...fileLocations])}`,
    `connect-src ${sources([], connect)}`,
    "worker-src 'self' blob:",
    `frame-src ${sources([], frame)}`,
    `base-uri ${sources([], baseUri)}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ")
}
