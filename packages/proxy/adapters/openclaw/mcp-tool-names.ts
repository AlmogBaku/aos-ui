import {
  ToolsEffectiveParamsSchema,
  ToolsEffectiveResultSchema,
} from "@openclaw/gateway-protocol/schema"
import { Value } from "typebox/value"

import {
  canonicalAosToolName,
  type McpToolNameResolver,
} from "../../core/aos-tool-names"
import {
  createMcpServerCache,
  type McpServerCache,
} from "../../core/mcp-server-cache"
import type { OpenClawGatewayClient } from "./client"
import { OpenClawNativePayloadError } from "./native-schemas"

/**
 * One MCP name `tools.effective` reports for a Session: a listed tool under
 * its model-facing name (`id`), or a configured server whose tools the
 * Session has not listed yet (no `id`).
 */
export type OpenClawMcpName = Readonly<
  { server: string } & ({ id: string; tool: string } | { id?: undefined })
>

/** The MCP names in one `tools.effective` answer. */
export function openClawMcpNames(value: unknown): OpenClawMcpName[] {
  if (!Value.Check(ToolsEffectiveResultSchema, value))
    throw new OpenClawNativePayloadError()
  const tools = value.groups
    .flatMap((group) => group.tools)
    .flatMap((tool) =>
      tool.source === "mcp" && tool.mcpServer && tool.mcpToolName
        ? [{ id: tool.id, server: tool.mcpServer, tool: tool.mcpToolName }]
        : []
    )
  const servers = (value.notices ?? [])
    .flatMap((notice) => notice.servers ?? [])
    .map((server) => ({ server }))
  return [...tools, ...servers]
}

/**
 * OpenClaw names an MCP tool `<server>__<tool>`: a listed tool resolves
 * exactly, and an unlisted one by its configured server's prefix.
 */
export function openClawMcpResolver(
  names: readonly OpenClawMcpName[]
): McpToolNameResolver {
  return (rawName) => {
    const listed = names.find((name) => name.id === rawName)
    if (listed?.id !== undefined)
      return { server: listed.server, tool: listed.tool }
    const split = rawName.indexOf("__")
    const server = rawName.slice(0, split)
    const tool = rawName.slice(split + 2)
    return split > 0 &&
      tool &&
      names.some((name) => name.id === undefined && name.server === server)
      ? { server, tool }
      : undefined
  }
}

/** A native name that may be an MCP tool outside `aos-ui`. */
export function mayBeMcpToolName(rawName: string) {
  return rawName.includes("__") && canonicalAosToolName(rawName) === undefined
}

export type OpenClawMcpToolNames = Readonly<{
  /** Loads the Session's names, refetching once when one of `expected` misses. Never throws. */
  load(
    agentId: string,
    sessionKey: string,
    expected?: readonly string[]
  ): Promise<void>
  /** Resolves against the last names loaded; a miss refetches in the background. */
  resolver(agentId: string, sessionKey: string): McpToolNameResolver
  /** Frees the Session's names; a fetch still in flight lands on nothing. */
  forget(agentId: string, sessionKey: string): void
  /** How many Sessions hold names. */
  readonly size: number
}>

/** One Session's names: its own cache, and the resolver its last fetch built. */
type SessionNames = {
  cache: McpServerCache<OpenClawMcpName>
  latest?: McpToolNameResolver
}

/** The cache is per Session, so its one entry goes with the Session's record. */
const NAMES = "names"

export function createOpenClawMcpToolNames(
  client: Pick<OpenClawGatewayClient, "request">
): OpenClawMcpToolNames {
  const sessions = new Map<string, SessionNames>()
  const keyOf = (agentId: string, sessionKey: string) =>
    JSON.stringify([agentId, sessionKey])
  const record = (agentId: string, sessionKey: string) => {
    const key = keyOf(agentId, sessionKey)
    const existing = sessions.get(key)
    if (existing) return existing
    const created: SessionNames = {
      cache: createMcpServerCache<OpenClawMcpName>(async () => {
        const params = { agentId, sessionKey }
        if (!Value.Check(ToolsEffectiveParamsSchema, params))
          throw new OpenClawNativePayloadError()
        const names = openClawMcpNames(
          await client.request("tools.effective", params)
        )
        created.latest = openClawMcpResolver(names)
        return names
      }),
    }
    sessions.set(key, created)
    return created
  }
  const settle = (list: Promise<unknown>): void => {
    list.then(
      () => undefined,
      () => undefined
    )
  }
  return {
    async load(agentId, sessionKey, expected = []) {
      const names = record(agentId, sessionKey)
      await settle(names.cache.get(NAMES))
      if (
        expected.some(
          (rawName) => mayBeMcpToolName(rawName) && !names.latest?.(rawName)
        )
      )
        await settle(names.cache.refresh(NAMES))
    },
    resolver(agentId, sessionKey) {
      const names = record(agentId, sessionKey)
      return (rawName) => {
        const hit = names.latest?.(rawName)
        if (!hit && mayBeMcpToolName(rawName))
          settle(names.cache.refresh(NAMES))
        return hit
      }
    },
    forget(agentId, sessionKey) {
      sessions.delete(keyOf(agentId, sessionKey))
    },
    get size() {
      return sessions.size
    },
  }
}
