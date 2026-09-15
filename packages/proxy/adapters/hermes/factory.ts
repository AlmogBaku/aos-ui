import { SessionCoordinator } from "../../core/session-coordinator"
import type { RuntimeInstance } from "../../core/runtime"
import type { RuntimeConfig, RuntimeLimits } from "../../config"
import { readSecretFile } from "../../secrets"
import { HermesServerAdapter, type HermesRpcTransport } from "./adapter"
import {
  HermesWebSocketRpcTransport,
  type HermesWebSocketRpcTransportOptions,
} from "./transport"

type HermesRuntimeConfig = RuntimeConfig & { kind: "hermes" }

export type HermesRuntimeFactoryDependencies = {
  transportFactory?: (
    options: HermesWebSocketRpcTransportOptions
  ) => HermesRpcTransport
}

export async function createHermesRuntime(
  config: HermesRuntimeConfig,
  limits: RuntimeLimits,
  dependencies: HermesRuntimeFactoryDependencies = {}
): Promise<RuntimeInstance> {
  const token = await readSecretFile(config.tokenFile)
  const transportFactory =
    dependencies.transportFactory ??
    ((options: HermesWebSocketRpcTransportOptions) =>
      new HermesWebSocketRpcTransport(options))
  const transport = transportFactory({
    baseUrl: config.baseUrl,
    credentials: async () => ({ "X-Hermes-Session-Token": token }),
  })
  const runtime = new HermesServerAdapter(transport, {
    sessionIdleMs: config.sessionIdleMs,
  })
  const sessions = new SessionCoordinator({
    engine: runtime.runs,
    maxActiveExecutions: limits.activeExecutions,
    maxGuestActiveExecutions: limits.guestActiveExecutions,
    maxSubscriberEvents: limits.subscriberEvents,
    maxSubscriberBytes: limits.subscriberBytes,
    maxReplayEvents: limits.subscriberEvents,
    maxReplayBytes: limits.subscriberBytes,
  })
  let closePromise: Promise<void> | undefined
  return {
    id: config.id,
    runtime,
    sessions,
    close() {
      closePromise ??= Promise.resolve().then(async () => {
        sessions.close()
        await runtime.close()
      })
      return closePromise
    },
  }
}
