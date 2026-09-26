import { createCoordinator } from "../create-coordinator"
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

export async function createHermesRuntime(
  config: HermesRuntimeConfig,
  limits: RuntimeLimits,
  dependencies: HermesRuntimeFactoryDependencies
): Promise<RuntimeInstance> {
  const { logger, credentials } = dependencies
  const token = await credentials.register(readSecretFile, (value) => [value])(
    config.tokenFile
  )
  const transportFactory =
    dependencies.transportFactory ??
    ((options: HermesGatewayOptions) => new HermesGateway(options))
  // One log for the whole runtime: the gateway reports transport outages, the
  // attachment registry reports rebinding failures, and the native run
  // boundary reports the code of every authoritative Hermes rejection.
  const transport = transportFactory({
    baseUrl: config.baseUrl,
    credentials: async () => ({ "X-Hermes-Session-Token": token }),
    log: logger,
  })
  // Eager dial: the gateway owns its redial ladder from here, so a Hermes that
  // is not up yet is retried in the background instead of failing whichever
  // request happens to arrive first.
  if (transport instanceof HermesGateway)
    void transport.connect().catch(() => undefined)
  const mcpAppClient = createMcpAppClient({
    servers: dependencies.mcpServerOverrides,
  })
  // Wrapped before the coordinator, which runs turns through `runtime.runs`.
  const runtime = withMcpApps(
    new HermesServerAdapter(transport, {
      sessionIdleMs: config.sessionIdleMs,
      log: logger,
      mcp: { client: mcpAppClient, logger },
    })
  )
  const sessions = createCoordinator(runtime, limits, logger)
  let closePromise: Promise<void> | undefined
  return {
    id: config.id,
    runtime,
    sessions,
    close() {
      closePromise ??= Promise.resolve().then(async () => {
        sessions.close()
        await runtime.close()
        await mcpAppClient.close()
      })
      return closePromise
    },
  }
}
