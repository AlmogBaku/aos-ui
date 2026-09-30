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

/** The server and tool of the tool `names` lists under `rawName`. */
function listedMcpTool(names: readonly OpenClawMcpName[], rawName: string) {
  const listed = names.find((name) => name.id === rawName)
  return listed?.id === undefined
    ? undefined
    : { server: listed.server, tool: listed.tool }
}

/**
 * OpenClaw names an MCP tool `<server>__<tool>`: a listed tool resolves
 * exactly, and an unlisted one by its configured server's prefix.
 */
export function openClawMcpResolver(
  names: readonly OpenClawMcpName[]
): McpToolNameResolver {
  return (rawName) => {
    const listed = listedMcpTool(names, rawName)
    if (listed) return listed
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
  /**
   * The server and tool the Session's names list under `rawName`, refetching
   * once on a miss. A prefix never counts: `a__b__c` could be server `a` or
   * `a__b`. Never throws.
   */
  listed(
    agentId: string,
    sessionKey: string,
    rawName: string
  ): Promise<{ server: string; tool: string } | undefined>
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
  return {
    async load(agentId, sessionKey, expected = []) {
      const names = record(agentId, sessionKey)
      await names.cache.get(NAMES).catch(() => undefined)
      if (
        expected.some(
          (rawName) => mayBeMcpToolName(rawName) && !names.latest?.(rawName)
        )
      )
        await names.cache.refresh(NAMES).catch(() => undefined)
    },
    resolver(agentId, sessionKey) {
      const names = record(agentId, sessionKey)
      return (rawName) => {
        const hit = names.latest?.(rawName)
        if (!hit && mayBeMcpToolName(rawName))
          names.cache.refresh(NAMES).catch(() => undefined)
        return hit
      }
    },
    async listed(agentId, sessionKey, rawName) {
      const names = record(agentId, sessionKey)
      const find = (list?: readonly OpenClawMcpName[]) =>
        list && listedMcpTool(list, rawName)
      return (
        find(await names.cache.get(NAMES).catch(() => undefined)) ??
        find(await names.cache.refresh(NAMES).catch(() => undefined))
      )
    },
    forget(agentId, sessionKey) {
      sessions.delete(keyOf(agentId, sessionKey))
    },
    get size() {
      return sessions.size
    },
  }
}
