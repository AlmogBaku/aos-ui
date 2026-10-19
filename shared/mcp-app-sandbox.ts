import {
  isMcpAppPolicyOrigin,
  MCP_APP_SANDBOX_PATH,
  mcpAppSandboxPolicy,
  McpUiDomainSchema,
  type McpUiCsp,
} from "@harness-gw/sdk/protocol"

import type { DeploymentOrigins } from "./lane-origins"

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
 * A stable host's first label: `mcpAppStableOriginKey` (`@harness-gw/sdk/node`)
 * of the URL the gateway dials the view's server at.
 */
const STABLE_KEY = /^[0-9a-f]{32}$/u

/** The optional setting the MCP App stable origins' wildcard is read from. */
export const MCP_APP_STABLE_ORIGINS_SETTING = "AOS_UI_MCP_APP_STABLE_ORIGINS"

/** `<scheme>://*.<domain>[:port]`, as `AOS_UI_MCP_APP_STABLE_ORIGINS` names it. */
const WILDCARD = /^(https?:)\/\/\*\.([^/?#@:]+)(:\d+)?$/u

/** The stable origins' wildcard in parts; `port` is empty when it names none. */
export type StableOrigins = { scheme: string; domain: string; port: string }

/**
 * The parts of `wildcard`, a lowercase `<scheme>://*.<domain>[:port]` whose
 * stable hosts, `<key>.<domain>`, a view's `domain` can name and a sandbox
 * policy can serve: `undefined` for any other value, or none.
 */
export function stableOriginsOf(
  wildcard: string | undefined
): StableOrigins | undefined {
  const [, scheme, domain, port = ""] = WILDCARD.exec(wildcard ?? "") ?? []
  if (scheme === undefined || domain === undefined) return undefined
  const host = `${"0".repeat(32)}.${domain}`
  return McpUiDomainSchema.safeParse(host).success &&
    isMcpAppPolicyOrigin(`${scheme}//${host}${port}`)
    ? { scheme, domain, port }
    : undefined
}

/** Whether a lowercase host name is one key label directly below `domain`. */
const isStableName = (name: string, domain: string) =>
  name.endsWith(`.${domain}`) &&
  STABLE_KEY.test(name.slice(0, -domain.length - 1))

/**
 * The origins one view's sandbox policy is built for, by the server that
 * sends it and the host that reports what it applies: every lane's pages,
 * framing the view's own stable origin when its `domain` names a stable host
 * (the wildcard's scheme, that host, and the wildcard's port), else the one
 * shared sandbox.
 */
export function sandboxPolicyOrigins(
  origins: DeploymentOrigins,
  domain?: string
): SandboxPolicyOrigins {
  const stable = stableOriginsOf(origins.mcpAppStableOrigins)
  const name = domain?.toLowerCase()
  return {
    frameAncestors: origins.publicOrigins,
    sandboxOrigin:
      stable !== undefined &&
      name !== undefined &&
      isStableName(name, stable.domain)
        ? `${stable.scheme}//${name}${stable.port}`
        : origins.mcpAppSandboxOrigin,
  }
}

/**
 * The sandbox a request's `Host` names, as the origins its page's policy is
 * built for: the shared sandbox's host and port, or exactly a stable host with
 * the wildcard's port. Any other host at or below the stable origins' domain
 * is `"refused"`, and any other host is a lane's, `undefined`. Hosts compare
 * case-insensitively, as DNS names do.
 */
export function sandboxAt(
  origins: DeploymentOrigins,
  host: string
): SandboxPolicyOrigins | "refused" | undefined {
  const requested = host.toLowerCase()
  // First, since the sandbox may sit at the stable origins' domain itself.
  if (requested === new URL(origins.mcpAppSandboxOrigin).host)
    return sandboxPolicyOrigins(origins)
  const stable = stableOriginsOf(origins.mcpAppStableOrigins)
  if (stable === undefined) return undefined
  const port = /:\d*$/u.exec(requested)?.[0] ?? ""
  const name = requested.slice(0, requested.length - port.length)
  if (name !== stable.domain && !name.endsWith(`.${stable.domain}`))
    return undefined
  return isStableName(name, stable.domain) && port === stable.port
    ? sandboxPolicyOrigins(origins, name)
    : "refused"
}

/**
 * The sandbox page address for one view, at its sandbox origin with the
 * view's declared lists in the query, from which the server rebuilds the
 * view's policy; `undefined` when it would be longer than
 * `MAX_SANDBOX_PAGE_URL_LENGTH`.
 */
export function sandboxPageUrl(
  sandboxOrigin: string,
  { allow, csp, fileLocations }: SandboxPageView
): string | undefined {
  const query = new URLSearchParams()
  if (allow) query.set("allow", allow)
  for (const list of CSP_LISTS)
    for (const domain of csp?.[list] ?? []) query.append(list, domain)
  for (const location of fileLocations) query.append(FILE_PARAMETER, location)
  const search = query.toString()
  const url = `${sandboxOrigin}${MCP_APP_SANDBOX_PATH}${search ? `?${search}` : ""}`
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

/**
 * A lane page's policy: it frames the shared sandbox, the stable origins'
 * wildcard when it is set, and nothing else.
 */
export const lanePageFrameSrc = ({
  mcpAppSandboxOrigin,
  mcpAppStableOrigins,
}: DeploymentOrigins) =>
  `frame-src ${mcpAppSandboxOrigin}${mcpAppStableOrigins ? ` ${mcpAppStableOrigins}` : ""}`
