import { readFile } from "node:fs/promises"

import { createConfiguredProxy } from "../composition"
import { parseGuestComposerSlashCommandsEnabled } from "../config"
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
  const guestReservedPaths = ["/auth", "/hermes"]
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
      if (
        guestSurface &&
        guestReservedPaths.some(
          (reserved) =>
            pathname === reserved || pathname.startsWith(`${reserved}/`)
        )
      )
        return secureGuestResponse(new Response(null, { status: 404 }))
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
  const getenv = dependencies.getenv ?? ((name: string) => process.env[name])
  const guestComposerSlashCommandsEnabled =
    parseGuestComposerSlashCommandsEnabled(
      getenv("AOS_UI_COMPOSER_SLASH_COMMANDS_ENABLED")
    )
  const start = dependencies.start ?? startProxyServer
  const lifecycle = start({
    app: listenerApp(configured.app, "/api/aos/v1", dependencies.staticHandler),
    events: configured.eventService,
    host: configured.config.listen.host,
    port: configured.config.listen.port,
    shutdownGraceMs: configured.config.shutdownGraceMs,
    maxEventPeers: configured.config.limits.operatorEventPeers,
    installSignalHandlers: false,
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
            ...(guestComposerSlashCommandsEnabled
              ? { composerSlashCommandsEnabled: true }
              : {}),
          },
          true
        ),
        host: configured.config.guest!.listen.host,
        port: configured.config.guest!.listen.port,
        shutdownGraceMs: configured.config.shutdownGraceMs,
        installSignalHandlers: false,
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
  const shutdown = () => {
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
  }

  // A signal has to close the runtime, not only the listeners: the native
  // transport socket, its heartbeat and every attachment timer outlive a stopped
  // listener, so a process that only stopped serving keeps running until the
  // service manager kills it. This whole lifecycle owns the signal, so the
  // individual listeners do not install handlers of their own.
  const install =
    dependencies.onShutdownSignal ??
    ((handler: () => void) => {
      process.once("SIGINT", handler)
      process.once("SIGTERM", handler)
    })
  const exit = dependencies.exit ?? ((code: number) => process.exit(code))
  install(() => {
    // Last resort, logged: the listeners get their full drain grace, and a
    // native handle that outlives close() cannot hold the unit open after it.
    // The deadline is unref'd, so a clean shutdown still exits on its own.
    const forced = setTimeout(() => {
      dependencies.logger.error({ event: "proxy.shutdown_forced" })
      exit(0)
    }, configured.config.shutdownGraceMs * 2)
    if (typeof forced !== "number") forced.unref()
    void shutdown().catch((error: unknown) => {
      dependencies.logger.error({ event: "proxy.shutdown_failed", error })
    })
  })

  return {
    server: lifecycle.server,
    ...(guestLifecycle ? { guestServer: guestLifecycle.server } : {}),
    shutdown,
  }
}
