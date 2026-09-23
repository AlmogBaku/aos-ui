import {
  ToolsEffectiveParamsSchema,
  ToolsEffectiveResultSchema,
} from "@openclaw/gateway-protocol/schema"
import { Value } from "typebox/value"

import {
  canonicalAosToolName,
  type McpToolNameResolver,
} from "../../core/aos-tool-names"
import { createMcpServerCache } from "../../core/mcp-server-cache"
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
}>

export function createOpenClawMcpToolNames(
  client: Pick<OpenClawGatewayClient, "request">
): OpenClawMcpToolNames {
  const latest = new Map<string, McpToolNameResolver>()
  const cache = createMcpServerCache<OpenClawMcpName>(async (key) => {
    const [agentId, sessionKey] = JSON.parse(key) as [string, string]
    const params = { agentId, sessionKey }
    if (!Value.Check(ToolsEffectiveParamsSchema, params))
      throw new OpenClawNativePayloadError()
    const names = openClawMcpNames(
      await client.request("tools.effective", params)
    )
    latest.set(key, openClawMcpResolver(names))
    return names
  })
  const settle = (list: Promise<unknown>) =>
    list.then(
      () => undefined,
      () => undefined
    )
  const keyOf = (agentId: string, sessionKey: string) =>
    JSON.stringify([agentId, sessionKey])
  const resolveLatest = (key: string, rawName: string) =>
    latest.get(key)?.(rawName)
  return {
    async load(agentId, sessionKey, expected = []) {
      const key = keyOf(agentId, sessionKey)
      await settle(cache.get(key))
      if (
        expected.some(
          (rawName) => mayBeMcpToolName(rawName) && !resolveLatest(key, rawName)
        )
      )
        await settle(cache.refresh(key))
    },
    resolver(agentId, sessionKey) {
      const key = keyOf(agentId, sessionKey)
      return (rawName) => {
        const hit = resolveLatest(key, rawName)
        if (!hit && mayBeMcpToolName(rawName)) void settle(cache.refresh(key))
        return hit
      }
    },
  }
}
