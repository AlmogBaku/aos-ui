import { readFile, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

import {
  FIXTURE_MCP_APP_FILES,
  FIXTURE_MCP_APP_FILES_PATH,
} from "../../shared/presentation/views"

export type StaticHandler = (
  request: Request,
  server?: unknown
) => Response | undefined | Promise<Response | undefined>

export type StaticHandlerOptions = {
  root: string
  runtimeConfig: string
}

const contentTypes: Record<string, string> = {
  css: "text/css; charset=UTF-8",
  html: "text/html; charset=UTF-8",
  js: "application/javascript; charset=UTF-8",
  json: "application/json; charset=UTF-8",
  map: "application/json; charset=UTF-8",
  png: "image/png",
  svg: "image/svg+xml",
  wasm: "application/wasm",
  webmanifest: "application/manifest+json; charset=UTF-8",
}

function contentType(path: string) {
  const extension = path.split(".").pop()?.toLowerCase()
  return (extension && contentTypes[extension]) || "application/octet-stream"
}

function safePath(root: string, pathname: string) {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  if (decoded.includes("\0")) return undefined
  const candidate = resolve(root, `.${decoded}`)
  const outside = relative(root, candidate)
  return outside === "" || (!outside.startsWith("..") && !isAbsolute(outside))
    ? candidate
    : undefined
}

async function isFile(path: string) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function fileResponse(
  path: string,
  request: Request,
  headers: Record<string, string>,
  // The file actually sent, when it is a compressed copy of `path`.
  body = path
) {
  let file
  try {
    file = await readFile(body)
  } catch {
    return undefined
  }
  const responseHeaders = new Headers(headers)
  responseHeaders.set("content-type", contentType(path))
  responseHeaders.set("content-length", String(file.byteLength))
  return new Response(request.method === "HEAD" ? null : file, {
    headers: responseHeaders,
  })
}

/** The build writes these copies beside each text asset, best first. */
const precompressed = [
  { encoding: "br", suffix: ".br" },
  { encoding: "gzip", suffix: ".gz" },
] as const

function acceptedEncodings(request: Request) {
  const accepted = new Set<string>()
  for (const part of (request.headers.get("accept-encoding") ?? "").split(
    ","
  )) {
    const [token = "", ...parameters] = part.toLowerCase().split(";")
    const refused = parameters.some((parameter) =>
      /^\s*q\s*=\s*0(\.0*)?\s*$/u.test(parameter)
    )
    if (token.trim() && !refused) accepted.add(token.trim())
  }
  return accepted
}

/** Serves the best precompressed copy the client accepts, else the file itself. */
async function assetResponse(
  path: string,
  request: Request,
  headers: Record<string, string>
) {
  if (!(await isFile(path))) return undefined
  const accepted = acceptedEncodings(request)
  let hasCopy = false
  for (const { encoding, suffix } of precompressed) {
    if (!(await isFile(`${path}${suffix}`))) continue
    hasCopy = true
    if (!accepted.has(encoding)) continue
    const copy = await fileResponse(
      path,
      request,
      { ...headers, "content-encoding": encoding, vary: "Accept-Encoding" },
      `${path}${suffix}`
    )
    if (copy) return copy
  }
  return fileResponse(
    path,
    request,
    hasCopy ? { ...headers, vary: "Accept-Encoding" } : headers
  )
}

/** The exact paths that must carry `Access-Control-Allow-Origin: null`. */
const FIXTURE_FILE_PATHS = new Set(
  Object.values(FIXTURE_MCP_APP_FILES).map(
    (name) => `${FIXTURE_MCP_APP_FILES_PATH}/${name}`
  )
)

export function createStaticHandler(
  options: StaticHandlerOptions
): StaticHandler {
  const root = resolve(options.root)
  const runtimeConfig = resolve(options.runtimeConfig)
  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return undefined
    const url = new URL(request.url)
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname !== "/api/health") return undefined
      return new Response(
        request.method === "HEAD" ? null : JSON.stringify({ status: "ok" }),
        {
          headers: {
            "cache-control": "no-store",
            "content-length": "15",
            "content-type": "application/json; charset=UTF-8",
          },
        }
      )
    }
    if (url.pathname === "/runtime-config.json") {
      const response = await fileResponse(runtimeConfig, request, {
        "cache-control": "no-store",
      })
      return response
        ? new Response(response.body, {
            status: response.status,
            headers: response.headers,
          })
        : new Response(null, {
            status: 503,
            headers: { "cache-control": "no-store" },
          })
    }
    const path = safePath(root, url.pathname)
    if (!path) return undefined
    const headers: Record<string, string> = {
      "cache-control": url.pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    }
    if (FIXTURE_FILE_PATHS.has(url.pathname))
      headers["access-control-allow-origin"] = "null"
    const requested = await assetResponse(path, request, headers)
    if (requested) return requested
    if (url.pathname.startsWith("/assets/") || url.pathname.includes("."))
      return undefined
    return assetResponse(resolve(root, "index.html"), request, {
      "cache-control": "no-cache",
    })
  }
}
