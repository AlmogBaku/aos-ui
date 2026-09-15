import { SessionCoordinator } from "../../core/session-coordinator"
import type { RuntimeInstance, ServerRunEngine } from "../../core/runtime"
import type { RuntimeLimits } from "../../config"
import { readSecretFile } from "../../secrets"
import { createOpenCodeClient, type OpenCodeClientOptions } from "./client"
import { OpenCodeServerAdapter, type OpenCodeAdapterClient } from "./adapter"

/**
 * Provider-local configuration until the central runtime union admits OpenCode.
 * Credentials are resolved server-side and never reach browser-facing config.
 */
export type OpenCodeRuntimeConfig = Readonly<{
  kind: "opencode"
  id: string
  baseUrl: string
  directory: string
  username: string
  passwordFile: string
}>

export type OpenCodeRuntimeFactoryDependencies = Readonly<{
  clientFactory?: (options: OpenCodeClientOptions) => OpenCodeAdapterClient
  /** Supplied by OC2; this factory never adds coordinator/run state itself. */
  runs: ServerRunEngine
  creatorAgentId?: string
}>

export async function createOpenCodeRuntime(
  config: OpenCodeRuntimeConfig,
  limits: RuntimeLimits,
  dependencies: OpenCodeRuntimeFactoryDependencies
): Promise<RuntimeInstance> {
  const password = await readSecretFile(config.passwordFile)
  const client = (dependencies.clientFactory ?? createOpenCodeClient)({
    baseUrl: config.baseUrl,
    directory: config.directory,
    username: config.username,
    password,
  })
  const runtime = new OpenCodeServerAdapter({
    client,
    runs: dependencies.runs,
    creatorAgentId: dependencies.creatorAgentId,
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
