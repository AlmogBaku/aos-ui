import { readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  MCP_APP_SANDBOX_CSP,
  MCP_APP_SANDBOX_PATH,
} from "@harness-gw/sdk/protocol"

import { createStaticHandler } from "./static"

export type WebSurface = "operator" | "guest"

export type WebAppOptions = {
  surface: WebSurface
  /** The built app, `dist`, holding `build-id` beside the assets. */
  root: string
  /** The operator's public runtime configuration; the guest's is generated. */
  runtimeConfigFile: string
}

/**
 * Paths the guest surface never serves: the operator sign-in, and the
 * installable shell — a guest has no workspace to install and no service
 * worker to register.
 */
const GUEST_RESERVED_PATHS = ["/auth", "/sw.js", "/manifest.webmanifest"]

const GUEST_PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self'; media-src 'self' blob:; font-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
}

/**
 * The MCP App sandbox proxy page carries its own policy on every surface, in
 * place of the guest page's: only this origin may frame it.
 */
const SANDBOX_PAGE_HEADERS = {
  "content-security-policy": MCP_APP_SANDBOX_CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
}

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
 * the served build id, and the surface's page policy. The gateway answers
 * `/api/v1` beside it, so every other `/api` path is absent here.
 */
export function createWebApp(options: WebAppOptions) {
  const guest = options.surface === "guest"
  const serveStatic = createStaticHandler({ root: options.root })
  const page = (response: Response) =>
    guest ? withHeaders(response, GUEST_PAGE_HEADERS) : response

  async function runtimeConfig(request: Request) {
    const buildId = await readBuildId(options.root)
    const config = guest
      ? { surface: "guest" }
      : await readOperatorConfig(options.runtimeConfigFile)
    if (!config)
      return new Response(null, {
        status: 503,
        headers: { "cache-control": "no-store" },
      })
    return json(request, { ...config, ...(buildId ? { buildId } : {}) })
  }

  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
    if (guest && guestReserved(pathname)) return page(notFound())
    if (request.method !== "GET" && request.method !== "HEAD")
      return page(new Response(null, { status: 405 }))
    if (pathname === "/healthz") return json(request, { status: "ok" })
    if (pathname === "/runtime-config.json")
      return page(await runtimeConfig(request))
    if (pathname === "/api" || pathname.startsWith("/api/"))
      return page(notFound())
    const response = (await serveStatic(request)) ?? notFound()
    if (pathname === MCP_APP_SANDBOX_PATH && response.ok)
      return withHeaders(response, SANDBOX_PAGE_HEADERS)
    return page(response)
  }
}
