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

/** The pages a sandbox policy lets frame it, and the origin it is served from. */
export type SandboxPolicyOrigins = {
  frameAncestors: readonly string[]
  sandboxOrigin: string
}

/**
 * The origins every sandbox policy is built for, by the server that sends it
 * and the host that reports what it applies: every lane's pages, framing the
 * one sandbox.
 */
export const sandboxPolicyOrigins = (
  origins: LaneOrigins
): SandboxPolicyOrigins => ({
  frameAncestors: origins.mcpAppFrameAncestors,
  sandboxOrigin: origins.mcpAppSandboxOrigin,
})

/**
 * The sandbox page address for one view, at the sandbox origin with the
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
 * The policy the sandbox page is sent with for the view its query names, which
 * `origins.frameAncestors` may frame. Anyone can ask for the page with any
 * query; `mcpAppSandboxPolicy` checks every value before it writes it.
 */
export function sandboxPagePolicy(
  origins: SandboxPolicyOrigins,
  query: URLSearchParams
): string {
  const csp: McpUiCsp = {}
  for (const list of CSP_LISTS) csp[list] = query.getAll(list)
  return mcpAppSandboxPolicy({
    ...origins,
    csp,
    fileLocations: query.getAll(FILE_PARAMETER),
  })
}

/**
 * The sandbox page's and its script's names, and the stem a server may
 * complete with either extension.
 */
const SANDBOX_FILE_NAMES = new Set(
  [MCP_APP_SANDBOX_PATH, MCP_APP_SANDBOX_SCRIPT_PATH].flatMap((path) => {
    const name = path.slice(1)
    return [name, name.slice(0, name.lastIndexOf("."))]
  })
)

/**
 * Whether a lane address refuses a request path as one that may reach the
 * sandbox page or its script under a spelling a server rewrites, such as
 * `/mcp-app-sandbox`, `/public/mcp-app-sandbox.html`, or `/@fs/…`: its last
 * segment, decoded and lowercased, is one of their names. Any other file, such
 * as a chunk whose name begins like theirs, is the lane's own. A path that
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
  return SANDBOX_FILE_NAMES.has(last.toLowerCase())
}

/**
 * The header a browser sends when it fetches a service worker's script. The
 * sandbox origin answers none, so nothing installs a worker there.
 */
export const SERVICE_WORKER_HEADER = "service-worker"

/** Whether a request's `Host` names the sandbox address. */
export const isSandboxHost = (sandboxOrigin: string, host: string) =>
  host.toLowerCase() === new URL(sandboxOrigin).host

/** A lane page's policy: it frames the sandbox origin and nothing else. */
export const lanePageFrameSrc = (sandboxOrigin: string) =>
  `frame-src ${sandboxOrigin}`
