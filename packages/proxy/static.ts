import { readFile, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

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

async function fileResponse(
  path: string,
  request: Request,
  headers: Record<string, string>
) {
  let file
  try {
    const details = await stat(path)
    if (!details.isFile()) return undefined
    file = await readFile(path)
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
    const requested = await fileResponse(path, request, {
      "cache-control": url.pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    })
    if (requested) return requested
    if (url.pathname.startsWith("/assets/") || url.pathname.includes("."))
      return undefined
    return fileResponse(resolve(root, "index.html"), request, {
      "cache-control": "no-cache",
    })
  }
}
