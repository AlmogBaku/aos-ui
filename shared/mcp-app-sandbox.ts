import {
  MCP_APP_SANDBOX_PATH,
  mcpAppSandboxPolicy,
  type McpUiCsp,
} from "@harness-gw/sdk/protocol"

import type { LaneOrigins } from "./lane-origins"

/** The relay script the sandbox page loads. */
export const MCP_APP_SANDBOX_SCRIPT_PATH = "/mcp-app-sandbox.js"

/** The longest sandbox page address the workspace loads. */
export const MAX_SANDBOX_PAGE_URL_LENGTH = 8 * 1024

const CSP_LISTS = [
  "connectDomains",
  "resourceDomains",
  "frameDomains",
  "baseUriDomains",
] as const satisfies readonly (keyof McpUiCsp)[]

/** The query parameter each of the call's file locations travels in. */
const FILE_PARAMETER = "file"

export type SandboxPageView = {
  /** The frame's `allow` features, which the relay hands the view's frame. */
  allow: string
  /** The view's declared `_meta.ui.csp`. */
  csp?: McpUiCsp | undefined
  /** The call's file addresses without their passes. */
  fileLocations: readonly string[]
}

/** What a lane's sandbox policies are framed by and served from. */
export const sandboxPolicyOrigins = (origins: LaneOrigins) => ({
  frameAncestors: origins.publicOrigins,
  sandboxOrigin: origins.mcpAppSandboxOrigin,
})

/**
 * The sandbox page address for one view, at its lane's sandbox origin with the
 * view's declared lists in the query, from which the server rebuilds the
 * view's policy; `undefined` when it would be longer than
 * `MAX_SANDBOX_PAGE_URL_LENGTH`.
 */
export function sandboxPageUrl(
  origins: LaneOrigins,
  { allow, csp, fileLocations }: SandboxPageView
): string | undefined {
  const query = new URLSearchParams()
  if (allow) query.set("allow", allow)
  for (const list of CSP_LISTS)
    for (const domain of csp?.[list] ?? []) query.append(list, domain)
  for (const location of fileLocations) query.append(FILE_PARAMETER, location)
  const search = query.toString()
  const url = `${origins.mcpAppSandboxOrigin}${MCP_APP_SANDBOX_PATH}${search ? `?${search}` : ""}`
  return url.length > MAX_SANDBOX_PAGE_URL_LENGTH ? undefined : url
}

/**
 * The policy the sandbox page is sent with for the view its query names.
 * Anyone can ask for the page with any query; `mcpAppSandboxPolicy` checks
 * every value before it writes it.
 */
export function sandboxPagePolicy(
  origins: LaneOrigins,
  query: URLSearchParams
): string {
  const csp: McpUiCsp = {}
  for (const list of CSP_LISTS) csp[list] = query.getAll(list)
  return mcpAppSandboxPolicy({
    ...sandboxPolicyOrigins(origins),
    csp,
    fileLocations: query.getAll(FILE_PARAMETER),
  })
}

/**
 * Whether a lane address refuses a request path as one that may reach the
 * sandbox page or its script under a spelling a server rewrites, such as
 * `/mcp-app-sandbox`, `/public/mcp-app-sandbox.html`, or `/@fs/…`: its last
 * segment, decoded and lowercased, starts with `mcp-app-sandbox`. A path that
 * cannot be decoded is refused too.
 */
export function namesSandboxFile(pathname: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return true
  }
  const last = decoded.split("/").filter(Boolean).at(-1) ?? ""
  return last.toLowerCase().startsWith("mcp-app-sandbox")
}

/**
 * The header a browser sends when it fetches a service worker's script. The
 * sandbox origin answers none, so nothing installs a worker there.
 */
export const SERVICE_WORKER_HEADER = "service-worker"

/** Whether a request's `Host` names the lane's sandbox address. */
export const isSandboxHost = (origins: LaneOrigins, host: string) =>
  host.toLowerCase() === new URL(origins.mcpAppSandboxOrigin).host

/** A lane page's policy: it frames its own sandbox origin and nothing else. */
export const lanePageFrameSrc = (origins: LaneOrigins) =>
  `frame-src ${origins.mcpAppSandboxOrigin}`
