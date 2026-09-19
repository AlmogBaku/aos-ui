import { readFile } from "node:fs/promises"

import { AOS_ACP_GUEST_PATH, AOS_ACP_OPERATOR_PATH } from "../../protocol/acp"
import { createConfiguredProxy } from "../composition"
import { parseGuestComposerSlashCommandsEnabled } from "../config"
import {
  startProxyServer,
  type ShutdownSettlement,
  type SocketUpgrade,
} from "../server"
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
  const graceMs = configured.config.shutdownGraceMs
  const listenerCount = configured.guest ? 2 : 1
  let runtimeClosed: Promise<void> | undefined
  /** One runtime is shared by every listener, so every shutdown path closes it once. */
  const closeRuntime = () =>
    (runtimeClosed ??= Promise.resolve().then(() =>
      configured.runtimeInstance.close()
    ))
  let shutdownAnnounced = false
  const announceShutdown = () => {
    if (shutdownAnnounced) return
    shutdownAnnounced = true
    dependencies.logger.info({ event: "proxy.shutdown.started", graceMs })
  }
  const exit = dependencies.exit ?? ((code: number) => process.exit(code))
  let settledListeners = 0
  let forcedShutdown = false
  /**
   * Every listener has stopped and the runtime is closed, so nothing is left to
   * serve: exiting is the only deterministic end for stray provider work that
   * outlived the grace.
   */
  const onSettled = ({ forced }: ShutdownSettlement) => {
    forcedShutdown ||= forced
    settledListeners += 1
    if (settledListeners < listenerCount) return
    if (forcedShutdown)
      dependencies.logger.error({ event: "proxy.shutdown.forced", graceMs })
    dependencies.logger.info({
      event: "proxy.shutdown.completed",
      forced: forcedShutdown,
    })
    exit(forcedShutdown ? 1 : 0)
  }
  const lifecycle = start<SocketUpgrade>({
    app: listenerApp(configured.app, "/api/aos/v1", dependencies.staticHandler),
    sockets: [
      {
        path: AOS_ACP_OPERATOR_PATH,
        service: configured.acpService,
        maxPeers: configured.config.limits.operatorEventPeers,
      },
    ],
    host: configured.config.listen.host,
    port: configured.config.listen.port,
    shutdownGraceMs: graceMs,
    close: closeRuntime,
    onShutdownStarted: announceShutdown,
    onSettled,
  })
  const guestLifecycle = configured.guest
    ? start<SocketUpgrade>({
        sockets: [
          {
            path: AOS_ACP_GUEST_PATH,
            service: configured.guest.acpService,
            maxPeers: configured.config.limits.operatorEventPeers,
          },
        ],
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
        shutdownGraceMs: graceMs,
        close: closeRuntime,
        onShutdownStarted: announceShutdown,
        onSettled,
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
          await closeRuntime()
        }
      })()
      return shutdownPromise
    },
  }
}
