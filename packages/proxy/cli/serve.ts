import { readFile } from "node:fs/promises"

import { createConfiguredProxy } from "../composition"
import { startProxyServer } from "../server"
import type { StaticHandler } from "../static"
import type { ProxyCliDependencies, ProxyLifecycle } from "./types"

function listenerApp(
  api: {
    fetch(request: Request, server?: unknown): Response | Promise<Response>
  },
  apiPrefix: string,
  staticHandler?: StaticHandler,
  runtimeConfig?: unknown,
  guestSurface = false
) {
  const secureGuestResponse = (response: Response) => {
    if (!guestSurface) return response
    const headers = new Headers(response.headers)
    headers.set(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self'; media-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    )
    headers.set("referrer-policy", "no-referrer")
    headers.set("x-content-type-options", "nosniff")
    headers.set("x-frame-options", "DENY")
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
  return {
    async fetch(request: Request, server?: unknown) {
      const pathname = new URL(request.url).pathname
      if (pathname.startsWith(apiPrefix)) return api.fetch(request, server)
      if (runtimeConfig && pathname === "/runtime-config.json")
        return secureGuestResponse(
          new Response(JSON.stringify(runtimeConfig), {
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json; charset=UTF-8",
            },
          })
        )
      if (pathname.startsWith("/api/") && pathname !== "/api/health")
        return new Response(null, { status: 404 })
      return secureGuestResponse(
        (await staticHandler?.(request, server)) ??
          new Response(null, { status: 404 })
      )
    },
  }
}

export async function serveProxy(
  configFile: string,
  dependencies: ProxyCliDependencies
): Promise<ProxyLifecycle> {
  const input = JSON.parse(await readFile(configFile, "utf8")) as unknown
  const configured = await createConfiguredProxy(input, dependencies)
  const start = dependencies.start ?? startProxyServer
  const lifecycle = start({
    app: listenerApp(configured.app, "/api/aos/v1", dependencies.staticHandler),
    events: configured.eventService,
    host: configured.config.listen.host,
    port: configured.config.listen.port,
    shutdownGraceMs: configured.config.shutdownGraceMs,
    maxEventPeers: configured.config.limits.operatorEventPeers,
  })
  const guestLifecycle = configured.guest
    ? start({
        app: listenerApp(
          configured.guest.app,
          "/api/guest/v1",
          dependencies.staticHandler,
          {
            surface: "guest",
            basePath: "/api/guest/v1",
            lane: "guest",
          },
          true
        ),
        host: configured.config.guest!.listen.host,
        port: configured.config.guest!.listen.port,
        shutdownGraceMs: configured.config.shutdownGraceMs,
      })
    : undefined

  dependencies.logger.info({
    event: "proxy.started",
    host: configured.config.listen.host,
    port: configured.config.listen.port,
    ...(configured.config.guest
      ? {
          guestHost: configured.config.guest.listen.host,
          guestPort: configured.config.guest.listen.port,
        }
      : {}),
  })

  let shutdownPromise: Promise<void> | undefined
  return {
    server: lifecycle.server,
    ...(guestLifecycle ? { guestServer: guestLifecycle.server } : {}),
    shutdown() {
      shutdownPromise ??= (async () => {
        try {
          await Promise.all([
            lifecycle.shutdown(),
            ...(guestLifecycle ? [guestLifecycle.shutdown()] : []),
          ])
        } finally {
          await configured.runtimeInstance.close()
        }
      })()
      return shutdownPromise
    },
  }
}
