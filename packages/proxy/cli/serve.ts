import { AOS_ACP_GUEST_PATH, AOS_ACP_OPERATOR_PATH } from "../../protocol/acp"
import {
  MCP_APP_SANDBOX_CSP,
  MCP_APP_SANDBOX_PATH,
} from "../../protocol/mcp-apps"
import { createConfiguredProxy } from "../composition"
import { loadProxyConfig, nodeConfigFileAccess } from "../config-file"
import {
  startProxyServer,
  type ShutdownSettlement,
  type SocketUpgrade,
} from "../server"
import type { StaticHandler } from "../static"
import type { ProxyCliDependencies, ProxyLifecycle } from "./types"

/**
 * Paths the guest surface never serves: the operator sign-in and runtime
 * proxies, and the installable shell — a guest has no workspace to install and
 * no service worker to register.
 */
const GUEST_RESERVED_PATHS = ["/auth", "/sw.js", "/manifest.webmanifest"]

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

const withHeaders = (response: Response, set: Record<string, string>) => {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(set)) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * The MCP App sandbox proxy page carries its own policy on every listener, in
 * place of the guest page's: only this origin may frame it.
 */
const secureSandboxResponse = (response: Response) =>
  withHeaders(response, {
    "content-security-policy": MCP_APP_SANDBOX_CSP,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  })

function listenerApp(
  api: {
    fetch(request: Request, server?: unknown): Response | Promise<Response>
  },
  apiPrefix: string,
  staticHandler?: StaticHandler,
  runtimeConfig?: unknown,
  guestSurface = false
) {
  const secureGuestResponse = (response: Response) =>
    guestSurface
      ? withHeaders(response, {
          "content-security-policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self'; media-src 'self' blob:; font-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        })
      : response
  return {
    async fetch(request: Request, server?: unknown) {
      const pathname = new URL(request.url).pathname
      if (pathname.startsWith(apiPrefix)) return api.fetch(request, server)
      if (guestSurface) {
        const requested = decodedPath(pathname)
        if (
          requested === undefined ||
          GUEST_RESERVED_PATHS.some(
            (reserved) =>
              requested === reserved || requested.startsWith(`${reserved}/`)
          )
        )
          return secureGuestResponse(new Response(null, { status: 404 }))
      }
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
      if (pathname === MCP_APP_SANDBOX_PATH) {
        const page = await staticHandler?.(request, server)
        return page?.ok
          ? secureSandboxResponse(page)
          : secureGuestResponse(page ?? new Response(null, { status: 404 }))
      }
      return secureGuestResponse(
        (await staticHandler?.(request, server)) ??
          new Response(null, { status: 404 })
      )
    },
  }
}

export async function serveProxy(
  { config }: { config?: string },
  dependencies: ProxyCliDependencies
): Promise<ProxyLifecycle> {
  const { getenv } = dependencies
  const input = await loadProxyConfig({
    flag: config,
    getenv,
    discover: true,
    ...nodeConfigFileAccess(dependencies),
  })
  const configured = await createConfiguredProxy(input, dependencies)
  const start = dependencies.start ?? startProxyServer
  const graceMs = configured.config.shutdownGraceMs
  const listenerCount = configured.guest ? 2 : 1
  let runtimeClosed: Promise<void> | undefined
  /** One runtime is shared by every listener, so every shutdown path closes it once. */
  const closeRuntime = () =>
    (runtimeClosed ??= Promise.resolve().then(() => {
      // Push delivery observes the runtime, so it stops before the runtime does.
      configured.push?.dispatcher.close()
      return configured.runtimeInstance.close()
    }))
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
