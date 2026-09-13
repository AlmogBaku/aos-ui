import { readFile } from "node:fs/promises"
import { Command, CommanderError } from "commander"

import {
  createConfiguredProxy,
  type ConfiguredProxyDependencies,
} from "./composition"
import { parseGuestComposerSlashCommandsEnabled } from "./config"
import { redactForLog } from "./redaction"
import { startProxyServer } from "./server"
import { createStaticHandler, type StaticHandler } from "./static"

type ProxyCliDependencies = ConfiguredProxyDependencies & {
  start?: typeof startProxyServer
  staticHandler?: StaticHandler
}

function listenerApp(
  api: {
    fetch(request: Request, server?: unknown): Response | Promise<Response>
  },
  apiPrefix: string,
  staticHandler?: StaticHandler,
  runtimeConfig?: unknown
) {
  return {
    async fetch(request: Request, server?: unknown) {
      const pathname = new URL(request.url).pathname
      if (pathname.startsWith(apiPrefix)) return api.fetch(request, server)
      if (runtimeConfig && pathname === "/runtime-config.json")
        return new Response(JSON.stringify(runtimeConfig), {
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=UTF-8",
          },
        })
      if (pathname.startsWith("/api/") && pathname !== "/api/health")
        return new Response(null, { status: 404 })
      return (
        (await staticHandler?.(request, server)) ??
        new Response(null, { status: 404 })
      )
    },
  }
}

function parseOptions(argv: string[]) {
  const command = new Command()
    .name("aos-runtime-proxy")
    .description("Run the private AOS runtime proxy")
    .requiredOption("--config <path>", "absolute or relative proxy config file")
    .exitOverride()
  try {
    command.parse(argv)
  } catch (error) {
    if (
      error instanceof CommanderError &&
      error.code === "commander.helpDisplayed"
    )
      return undefined
    throw error
  }
  return command.opts<{ config: string }>()
}

export async function runProxyCli(
  argv: string[],
  dependencies: ProxyCliDependencies
) {
  const options = parseOptions(argv)
  if (!options) return undefined
  const { config: configFile } = options
  const input = JSON.parse(await readFile(configFile, "utf8")) as unknown
  const configured = await createConfiguredProxy(input, dependencies)
  const guestComposerSlashCommandsEnabled =
    parseGuestComposerSlashCommandsEnabled(
      process.env.AOS_UI_COMPOSER_SLASH_COMMANDS_ENABLED
    )
  const start = dependencies.start ?? startProxyServer
  const lifecycle = start({
    app: listenerApp(configured.app, "/api/aos/v1", dependencies.staticHandler),
    events: configured.eventService,
    host: configured.config.listen.host,
    port: configured.config.listen.port,
    shutdownGraceMs: configured.config.shutdownGraceMs,
    close: () => configured.hermes.close(),
  })
  const guestLifecycle = configured.guest
    ? start({
        app: listenerApp(
          configured.guest.service.app,
          "/api/guest/v1",
          dependencies.staticHandler,
          {
            surface: "guest",
            basePath: "/api/guest/v1",
            lane: "guest",
            composerSlashCommandsEnabled: guestComposerSlashCommandsEnabled,
          }
        ),
        events: {
          authorizeUpgrade: (request) =>
            configured.guest!.service.authorizeEventUpgrade(request),
          open: (authorization, peer) =>
            configured.guest!.service.openEvents(authorization, peer),
        },
        eventsPath: "/api/guest/v1/events",
        host: configured.config.guest!.listen.host,
        port: configured.config.guest!.listen.port,
        shutdownGraceMs: configured.config.shutdownGraceMs,
        close: () => configured.guest!.hermes.close(),
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
      shutdownPromise ??= Promise.all([
        lifecycle.shutdown(),
        ...(guestLifecycle ? [guestLifecycle.shutdown()] : []),
      ]).then(() => undefined)
      return shutdownPromise
    },
  }
}

const logger = {
  info(value: unknown) {
    console.info(JSON.stringify(redactForLog(value)))
  },
  error(value: unknown) {
    console.error(JSON.stringify(redactForLog(value)))
  },
}

if (import.meta.main) {
  const staticHandler = createStaticHandler({
    root: process.env.AOS_UI_STATIC_ROOT ?? "/app/dist",
    runtimeConfig:
      process.env.AOS_UI_RUNTIME_CONFIG_FILE ??
      "/run/aos-ui/runtime-config.json",
  })
  void runProxyCli(process.argv, {
    logger,
    staticHandler,
  }).catch((error: unknown) => {
    logger.error({ event: "proxy.start_failed", error })
    process.exitCode = 1
  })
}
