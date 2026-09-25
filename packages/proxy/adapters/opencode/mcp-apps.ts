import { z } from "zod"

import type { SessionMessage } from "../../../protocol"
import { createMcpServerCache } from "../../core/mcp-server-cache"
import type { ServerMcpApps } from "../../core/runtime"
import type { McpAppClient } from "../../mcp-apps/client"
import {
  createMcpAppsFallback,
  type McpAppServer,
  type StoredMcpToolCall,
} from "../../mcp-apps/fallback"
import { mcpServersFromNative } from "../../mcp-apps/discovery"
import { createMcpToolNames, mcpToolCatalog } from "../../mcp-apps/tool-names"
import { OPENCODE_MCP_TOOL_NAMES } from "./tool-names"

/**
 * MCP Apps for OpenCode, which keeps no UI resources of its own: the proxy
 * reaches the project's remote MCP servers itself, and only those it can reach
 * without headers or OAuth, or with headers the operator configured. OpenCode
 * answers one project's configuration, so every Agent reads the same servers.
 */

const OpenCodeMcpEntrySchema = z.object({
  type: z.string().optional(),
  url: z.string().optional(),
  enabled: z.boolean().optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
  oauth: z.unknown().optional(),
})

/**
 * The `mcp` map of `GET /config`, one server per key. A remote server that is
 * on is dialable; headers or OAuth of its own are credentials.
 */
export function openCodeMcpServers(
  config: Record<string, unknown>,
  credentialed?: (name: string) => boolean
): McpAppServer[] {
  const mcp = z.record(z.string(), z.unknown()).safeParse(config.mcp ?? {})
  if (!mcp.success) return []
  const servers = Object.entries(mcp.data).flatMap(([name, value]) => {
    const entry = OpenCodeMcpEntrySchema.safeParse(value)
    if (!name || !entry.success) return []
    const { type, url, enabled, headers, oauth } = entry.data
    return [
      {
        name,
        dialable: type === "remote" && enabled !== false,
        url,
        credentials:
          (headers !== undefined && Object.keys(headers).length > 0) ||
          (oauth !== undefined && oauth !== false),
      },
    ]
  })
  return mcpServersFromNative(servers, credentialed)
}

/**
 * A stored call from the Session's projected history. OpenCode keeps a tool's
 * output as text only, so the view's result is that text; the tool is never
 * called again to recover more.
 */
export function storedOpenCodeToolCall(
  messages: readonly SessionMessage[],
  toolCallId: string
): StoredMcpToolCall | undefined {
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.toolCallId !== toolCallId) continue
      const text =
        part.result === undefined
          ? undefined
          : typeof part.result === "string"
            ? part.result
            : JSON.stringify(part.result)
      return {
        toolName: part.toolName,
        input: part.args,
        ...(text === undefined
          ? {}
          : {
              result: {
                content: [{ type: "text" as const, text }],
                ...(part.isError ? { isError: true } : {}),
              },
            }),
      }
    }
  }
  return undefined
}

/** The project's MCP servers and tool names, shared by the run engine and the adapter. */
export function createOpenCodeMcpCatalog(
  config: () => Promise<Record<string, unknown>>,
  client: McpAppClient
) {
  const servers = createMcpServerCache<McpAppServer>(async () =>
    openCodeMcpServers(await config(), client.credentialed)
  )
  const names = createMcpToolNames(
    OPENCODE_MCP_TOOL_NAMES,
    mcpToolCatalog(servers, client)
  )
  return { servers, names, client }
}

export type OpenCodeMcpCatalog = ReturnType<typeof createOpenCodeMcpCatalog>

export function createOpenCodeMcpApps(
  catalog: OpenCodeMcpCatalog,
  storedCall: (
    agentId: string,
    sessionId: string,
    toolCallId: string
  ) => Promise<StoredMcpToolCall | undefined>
): ServerMcpApps {
  return createMcpAppsFallback(
    {
      servers: (scope) => catalog.servers.get(scope.agentId),
      storedCall: (scope, toolCallId) =>
        storedCall(scope.agentId, scope.sessionId, toolCallId),
    },
    catalog.client
  )
}
