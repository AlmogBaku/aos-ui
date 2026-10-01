import { coordinatedRuntime } from "../create-coordinator"
import type { RuntimeServices } from "../create-runtime"
import type { RuntimeInstance } from "../../core/runtime"
import type { RuntimeConfig, RuntimeLimits } from "../../config"
import { readSecretFile } from "../../secrets"
import { withMcpApps } from "../../mcp-apps/annotate"
import { createMcpAppClient } from "../../mcp-apps/client"
import { HermesServerAdapter } from "./adapter"
import {
  HermesGateway,
  type HermesGatewayOptions,
  type HermesRpcTransport,
} from "./gateway"

type HermesRuntimeConfig = RuntimeConfig & { kind: "hermes" }

export type HermesRuntimeFactoryDependencies = RuntimeServices & {
  transportFactory?: (options: HermesGatewayOptions) => HermesRpcTransport
}

/** What the Hermes runtime is composed from, once config and files are read. */
export type HermesRuntimeParts = Pick<
  RuntimeServices,
  "logger" | "mcpServerOverrides"
> &
  Readonly<{ transport: HermesRpcTransport; sessionIdleMs: number }>

/**
 * The Hermes runtime over a resolved transport: what the factory serves and
 * the runtime contract proves.
 */
export function composeHermesRuntime({
  transport,
  logger,
  sessionIdleMs,
  mcpServerOverrides,
}: HermesRuntimeParts) {
  // Eager dial: the gateway owns its redial ladder from here, so a Hermes that
  // is not up yet is retried in the background instead of failing whichever
  // request happens to arrive first.
  if (transport instanceof HermesGateway)
    transport
      .connect()
      .catch((err: unknown) =>
        logger.warn({ err }, "hermes.transport.connect_failed")
      )
  const mcpAppClient = createMcpAppClient({
    servers: mcpServerOverrides,
    logger,
  })
  // Wrapped before the coordinator, which runs turns through `runtime.turns`.
  const runtime = withMcpApps(
    new HermesServerAdapter(transport, {
      sessionIdleMs,
      log: logger,
      mcp: { client: mcpAppClient, logger },
    })
  )
  return {
    runtime,
    async close() {
      await runtime.close()
      await mcpAppClient.close()
    },
  }
}

export async function createHermesRuntime(
  config: HermesRuntimeConfig,
  limits: RuntimeLimits,
  dependencies: HermesRuntimeFactoryDependencies
): Promise<RuntimeInstance> {
  const { logger, credentials } = dependencies
  // Registered, so the log masks every value it reads, a rotated token too.
  const readToken = credentials.register(readSecretFile, (value) => [value])
  // Read once up front: a missing or unreadable token file fails the boot.
  await readToken(config.tokenFile)
  const transportFactory =
    dependencies.transportFactory ??
    ((options: HermesGatewayOptions) => new HermesGateway(options))
  // One log for the whole runtime: the gateway reports transport outages, the
  // attachment registry reports rebinding failures, and the native run
  // boundary reports the code of every authoritative Hermes rejection.
  const transport = transportFactory({
    baseUrl: config.baseUrl,
    // Re-read on every dial and call, so a rotated token needs no restart.
    credentials: async () => ({
      "X-Hermes-Session-Token": await readToken(config.tokenFile),
    }),
    log: logger,
  })
  return coordinatedRuntime(
    config.id,
    composeHermesRuntime({
      transport,
      logger,
      sessionIdleMs: config.sessionIdleMs,
      mcpServerOverrides: dependencies.mcpServerOverrides,
    }),
    limits,
    logger
  )
}
