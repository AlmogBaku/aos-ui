import { SessionCoordinator } from "../../core/session-coordinator"
import type { RuntimeInstance, ServerTurnEngine } from "../../core/runtime"
import type { RuntimeLimits } from "../../config"
import { readSecretFile } from "../../secrets"
import { createOpenCodeClient, type OpenCodeClientOptions } from "./client"
import { OpenCodeServerAdapter, type OpenCodeAdapterClient } from "./adapter"
import { OpenCodeInteractions } from "./interactions"
import { OpenCodeTurnEngine } from "./run"

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
  /** Test-only override; production builds exactly one native turn engine. */
  turns?: ServerTurnEngine
  creatorAgentId?: string
}>

export async function createOpenCodeRuntime(
  config: OpenCodeRuntimeConfig,
  limits: RuntimeLimits,
  dependencies: OpenCodeRuntimeFactoryDependencies = {}
): Promise<RuntimeInstance> {
  const password = await readSecretFile(config.passwordFile)
  const client = (dependencies.clientFactory ?? createOpenCodeClient)({
    baseUrl: config.baseUrl,
    directory: config.directory,
    username: config.username,
    password,
  })
  const interactions = new OpenCodeInteractions({
    questions: client.sessions.questions,
    permissions: client.sessions.permissions,
  })
  const turns =
    dependencies.turns ??
    new OpenCodeTurnEngine(client, { replies: interactions })
  const runtime = new OpenCodeServerAdapter({
    client,
    turns,
    interactions,
    creatorAgentId: dependencies.creatorAgentId,
  })
  const sessions = new SessionCoordinator({
    engine: runtime.turns,
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
