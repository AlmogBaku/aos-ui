import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { MCP_APP_SANDBOX_PATH } from "@harness-gw/sdk/protocol"

import type { LaneOrigins, Surface } from "../shared/lane-origins"
import {
  isSandboxHost,
  lanePageFrameSrc,
  MCP_APP_SANDBOX_SCRIPT_PATH,
  namesSandboxFile,
  sandboxPagePolicy,
  sandboxPolicyOrigins,
  SERVICE_WORKER_HEADER,
  type SandboxPolicyOrigins,
} from "../shared/mcp-app-sandbox"
import { createStaticHandler, requestedFile } from "./static"

export type WebAppOptions = {
  surface: Surface
  /** The built app, `dist`, holding `build-id` beside the assets. */
  root: string
  /** The operator's public runtime configuration; the guest's is generated. */
  runtimeConfigFile: string
  /**
   * The surface's lane: its pages' origins, the MCP App sandbox origin, and
   * every lane's origins, which may frame the sandbox page.
   */
  origins: LaneOrigins
}

/**
 * Paths the guest surface never serves: the operator sign-in, and the
 * installable shell — a guest has no workspace to install and no service
 * worker to register.
 */
const GUEST_RESERVED_PATHS = ["/auth", "/sw.js", "/manifest.webmanifest"]

/** Each surface's page policy: both frame the sandbox origin alone. */
function pageHeaders(
  surface: Surface,
  sandboxOrigin: string
): Record<string, string> {
  const frameSrc = lanePageFrameSrc(sandboxOrigin)
  return surface === "guest"
    ? {
        "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self'; media-src 'self' blob:; font-src 'self' data:; ${frameSrc}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      }
    : { "content-security-policy": frameSrc }
}

/**
 * The MCP App sandbox page, for the view its query names: under that view's
 * own policy, which only the lanes' pages may frame, and never cached, since
 * the policy follows the query.
 */
const sandboxPageHeaders = (
  origins: SandboxPolicyOrigins,
  query: URLSearchParams
) => ({
  "cache-control": "no-store",
  "content-security-policy": sandboxPagePolicy(origins, query),
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
})

/**
 * The path the static handler will resolve, which is what a reservation has to
 * be compared against. A path that cannot be decoded is treated as reserved.
 */
function decodedPath(pathname: string) {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return undefined
  }
}

function guestReserved(pathname: string) {
  const requested = decodedPath(pathname)
  return (
    requested === undefined ||
    GUEST_RESERVED_PATHS.some(
      (reserved) =>
        requested === reserved || requested.startsWith(`${reserved}/`)
    )
  )
}

function withHeaders(response: Response, set: Record<string, string>) {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(set)) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const notFound = () => new Response(null, { status: 404 })

function json(request: Request, body: unknown) {
  const text = JSON.stringify(body)
  return new Response(request.method === "HEAD" ? null : text, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=UTF-8",
    },
  })
}

/** The build this server serves, which a tab running another one reloads for. */
async function readBuildId(root: string) {
  try {
    return (await readFile(join(root, "build-id"), "utf8")).trim() || undefined
  } catch {
    return undefined
  }
}

/** The operator's configuration file, or nothing when it is missing or not an object. */
async function readOperatorConfig(path: string) {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * One surface of the web app: the built pages, the runtime configuration with
 * the served build id and the lane's origins, and the surface's page policy.
 * The gateway answers `/api/v1` beside it, so every other `/api` path is
 * absent here.
 *
 * The sandbox address serves the MCP App sandbox page, which every lane's
 * pages may frame, and its script alone, never as a service worker's script;
 * the lane's own addresses serve neither, by the file a request resolves to
 * and by any path whose last segment names one.
 */
export function createWebApp(options: WebAppOptions) {
  const { origins, root } = options
  const sandboxOrigin = origins.mcpAppSandboxOrigin
  const policyOrigins = sandboxPolicyOrigins(origins)
  const guest = options.surface === "guest"
  const serveStatic = createStaticHandler({ root })
  const headers = pageHeaders(options.surface, sandboxOrigin)
  const page = (response: Response) => withHeaders(response, headers)
  const sandboxPage = requestedFile(root, MCP_APP_SANDBOX_PATH)
  const sandboxFiles = new Set([
    sandboxPage,
    requestedFile(root, MCP_APP_SANDBOX_SCRIPT_PATH),
  ])

  async function runtimeConfig(request: Request) {
    const buildId = await readBuildId(root)
    const config = guest
      ? { surface: "guest" }
      : await readOperatorConfig(options.runtimeConfigFile)
    if (!config)
      return new Response(null, {
        status: 503,
        headers: { "cache-control": "no-store" },
      })
    return json(request, {
      ...config,
      ...origins,
      ...(buildId ? { buildId } : {}),
    })
  }

  async function sandbox(request: Request, file: string | undefined) {
    if (!sandboxFiles.has(file) || request.headers.has(SERVICE_WORKER_HEADER))
      return notFound()
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405 })
    const response = (await serveStatic(request)) ?? notFound()
    return file === sandboxPage && response.ok
      ? withHeaders(
          response,
          sandboxPageHeaders(policyOrigins, new URL(request.url).searchParams)
        )
      : response
  }

  return async (request: Request): Promise<Response> => {
    const { host, pathname } = new URL(request.url)
    const file = requestedFile(root, pathname)
    if (isSandboxHost(sandboxOrigin, host)) return sandbox(request, file)
    if (sandboxFiles.has(file) || namesSandboxFile(pathname))
      return page(notFound())
    if (guest && guestReserved(pathname)) return page(notFound())
    if (request.method !== "GET" && request.method !== "HEAD")
      return page(new Response(null, { status: 405 }))
    if (pathname === "/healthz") return json(request, { status: "ok" })
    if (pathname === "/runtime-config.json")
      return page(await runtimeConfig(request))
    if (pathname === "/api" || pathname.startsWith("/api/"))
      return page(notFound())
    return page((await serveStatic(request)) ?? notFound())
  }
}
