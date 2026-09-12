import { readFile } from "node:fs/promises"
import { Command, CommanderError } from "commander"

import {
  createConfiguredProxy,
  type ConfiguredProxyDependencies,
} from "./composition"
import { redactForLog } from "./redaction"
import { startProxyServer, type StartProxyServerOptions } from "./server"

type ProxyLifecycle = ReturnType<typeof startProxyServer>

type ProxyCliDependencies = ConfiguredProxyDependencies & {
  start?: (options: StartProxyServerOptions) => ProxyLifecycle
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
  const lifecycle = (dependencies.start ?? startProxyServer)({
    app: configured.app,
    events: configured.eventService,
    host: configured.config.listen.host,
    port: configured.config.listen.port,
    shutdownGraceMs: configured.config.shutdownGraceMs,
  })
  dependencies.logger.info({
    event: "proxy.started",
    host: configured.config.listen.host,
    port: configured.config.listen.port,
  })
  return lifecycle
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
  void runProxyCli(process.argv, {
    logger,
  }).catch((error: unknown) => {
    logger.error({ event: "proxy.start_failed", error })
    process.exitCode = 1
  })
}
