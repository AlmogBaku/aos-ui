import { SessionCoordinator } from "../../core/session-coordinator"
import type { RuntimeInstance, ServerTurnEngine } from "../../core/runtime"
import type { RuntimeLimits } from "../../config"
import { readSecretFile } from "../../secrets"
import { withMcpApps } from "../../mcp-apps/annotate"
import {
  createMcpAppClient,
  type McpServerOverrides,
} from "../../mcp-apps/client"
import { createOpenCodeClient, type OpenCodeClientOptions } from "./client"
import { OpenCodeServerAdapter, type OpenCodeAdapterClient } from "./adapter"
import { OpenCodeInteractions } from "./interactions"
import { createOpenCodeMcpCatalog } from "./mcp-apps"
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
  mcpServerOverrides?: McpServerOverrides
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
  const { catalog } = client
  const mcpAppClient = catalog.config
    ? createMcpAppClient({ servers: dependencies.mcpServerOverrides })
    : undefined
  const mcp =
    mcpAppClient &&
    createOpenCodeMcpCatalog(() => catalog.config!(), mcpAppClient)
  const turns =
    dependencies.turns ??
    new OpenCodeTurnEngine(client, {
      replies: interactions,
      ...(mcp ? { mcpToolNames: mcp.names } : {}),
    })
  // Wrapped before the coordinator, which runs turns through `runtime.turns`.
  const runtime = withMcpApps(
    new OpenCodeServerAdapter({
      client,
      turns,
      interactions,
      creatorAgentId: dependencies.creatorAgentId,
      ...(mcp ? { mcp } : {}),
    })
  )
  const sessions = new SessionCoordinator({
    engine: runtime.turns,
    readings: runtime,
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
        await mcpAppClient?.close()
      })
      return closePromise
    },
  }
}
