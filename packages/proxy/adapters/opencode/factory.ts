import { createCoordinator } from "../create-coordinator"
import type { RuntimeServices } from "../create-runtime"
import type { RuntimeInstance, ServerTurnEngine } from "../../core/runtime"
import type { RuntimeLimits } from "../../config"
import { readSecretFile } from "../../secrets"
import { withMcpApps } from "../../mcp-apps/annotate"
import { createMcpAppClient } from "../../mcp-apps/client"
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

export type OpenCodeRuntimeFactoryDependencies = RuntimeServices &
  Readonly<{
    clientFactory?: (options: OpenCodeClientOptions) => OpenCodeAdapterClient
    /** Test-only override; production builds exactly one native turn engine. */
    turns?: ServerTurnEngine
    creatorAgentId?: string
  }>

export async function createOpenCodeRuntime(
  config: OpenCodeRuntimeConfig,
  limits: RuntimeLimits,
  dependencies: OpenCodeRuntimeFactoryDependencies
): Promise<RuntimeInstance> {
  const { logger, credentials } = dependencies
  // Basic auth sends the password inside `user:password` in base64, a spelling
  // of it that could leak on its own.
  const readPassword = credentials.register(readSecretFile, (value) => [
    value,
    Buffer.from(`${config.username}:${value}`, "utf8").toString("base64"),
  ])
  // Read for every request, so a rotated file applies without a restart; read
  // once here so a missing or malformed file still fails the start.
  const password = () => readPassword(config.passwordFile)
  await password()
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
    createOpenCodeMcpCatalog(() => catalog.config!(), mcpAppClient, logger)
  const turns =
    dependencies.turns ??
    new OpenCodeTurnEngine(client, {
      logger,
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
  const sessions = createCoordinator(runtime, limits, logger)
  let closePromise: Promise<void> | undefined
  return {
    id: config.id,
    runtime,
    sessions,
    close() {
      closePromise ??= Promise.resolve().then(async () => {
        sessions.close()
        if (turns instanceof OpenCodeTurnEngine) turns.close()
        await runtime.close()
        await mcpAppClient?.close()
      })
      return closePromise
    },
  }
}
