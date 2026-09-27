import { z } from "zod"

import type { Logger } from "../../../lifecycle"
import type { CallToolResult } from "../../../protocol/mcp-apps"
import { CallToolResultSchema } from "../../../protocol/mcp-apps"
import { createMcpServerCache } from "../../core/mcp-server-cache"
import type { ServerMcpApps, SessionScope } from "../../core/runtime"
import type { McpAppClient } from "../../mcp-apps/client"
import { mcpServersFromNative } from "../../mcp-apps/discovery"
import {
  createMcpAppsFallback,
  type McpAppServer,
  type StoredMcpToolCall,
} from "../../mcp-apps/fallback"
import {
  createMcpToolNames,
  mcpToolCatalog,
  type McpToolNames,
} from "../../mcp-apps/tool-names"
import { HERMES_MCP_TOOL_NAMES } from "./mcp-tool-names"
import { isRecord, parseJson, trimmedText, unwrappedToolText } from "./native"
import { projectHermesToolCall } from "./tool-data"

/**
 * MCP Apps for Hermes, which keeps no UI resources of its own: the proxy
 * reaches a profile's MCP servers itself, and only those it can reach without
 * credentials or with headers the operator configured. Names are keyed by
 * profile, which is the Agent id.
 */

/** One `/api/mcp/servers` entry, reduced to what decides reachability. */
const HermesMcpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.string(),
  url: z.string().nullish(),
  auth: z.unknown(),
  enabled: z.boolean(),
})

const HermesMcpServersSchema = z.object({ servers: z.array(z.unknown()) })

/**
 * Every readable entry, dialable when it is on and on Streamable HTTP, and
 * credentialed when it carries `auth` of its own.
 */
export function hermesMcpServers(
  payload: unknown,
  credentialed: (name: string) => boolean = () => false
): McpAppServer[] {
  const { servers } = HermesMcpServersSchema.parse(payload)
  return mcpServersFromNative(
    servers.flatMap((entry) => {
      const server = HermesMcpServerSchema.safeParse(entry)
      if (!server.success) return []
      const { name, transport, url, auth, enabled } = server.data
      return [
        {
          name,
          dialable: enabled && transport === "http",
          url,
          credentials: Boolean(auth),
        },
      ]
    }),
    credentialed
  )
}

/**
 * Rebuilds the `CallToolResult` Hermes stored as handler JSON: `{error}` for a
 * failure, else `result` (text, or the structured content when the text was
 * empty) with optional `structuredContent` and `_meta`.
 */
export function storedHermesToolResult(
  stored: unknown,
  isError: boolean
): CallToolResult | undefined {
  const content = unwrappedToolText(stored)
  const parsed = parseJson(content)
  const text = typeof content === "string" ? content : undefined
  if (!isRecord(parsed))
    return text === undefined
      ? undefined
      : { content: [{ type: "text", text }], ...(isError ? { isError } : {}) }
  if (isError || (typeof parsed.error === "string" && !("result" in parsed)))
    return {
      content: [
        {
          type: "text",
          text: typeof parsed.error === "string" ? parsed.error : (text ?? ""),
        },
      ],
      isError: true,
    }
  const result = parsed.result
  const structuredContent = isRecord(parsed.structuredContent)
    ? parsed.structuredContent
    : isRecord(result)
      ? result
      : undefined
  const candidate = {
    content:
      typeof result === "string" && result
        ? [{ type: "text", text: result }]
        : [],
    ...(structuredContent ? { structuredContent } : {}),
    ...(isRecord(parsed._meta) ? { _meta: parsed._meta } : {}),
  }
  const valid = CallToolResultSchema.safeParse(candidate)
  return valid.success ? valid.data : undefined
}

/** The call only if this Session's own rows hold it. */
function storedCall(
  rows: readonly unknown[],
  toolCallId: string,
  resolve: ReturnType<McpToolNames["resolver"]>
): StoredMcpToolCall | undefined {
  let call: StoredMcpToolCall | undefined
  let result: CallToolResult | undefined
  for (const row of rows) {
    if (!isRecord(row)) continue
    if (
      row.role === "tool" &&
      trimmedText(row.tool_call_id ?? row.toolCallId) === toolCallId
    )
      result = storedHermesToolResult(
        row.content ?? row.result,
        row.is_error === true
      )
    if (row.role !== "assistant" || !Array.isArray(row.tool_calls)) continue
    for (const raw of row.tool_calls) {
      const fn = isRecord(raw) && isRecord(raw.function) ? raw.function : {}
      const name = trimmedText(fn.name)
      if (!isRecord(raw) || trimmedText(raw.id) !== toolCallId || !name)
        continue
      // The view receives the arguments the browser already reads, redacted.
      const projected = projectHermesToolCall(name, fn.arguments, resolve)
      call = {
        toolName: projected.toolName,
        input: isRecord(projected.args) ? projected.args : {},
      }
    }
  }
  return call && { ...call, ...(result ? { result } : {}) }
}

export type HermesMcpApps = { mcpApps: ServerMcpApps; names: McpToolNames }

export function createHermesMcpApps(input: {
  servers: (profile: string) => Promise<unknown>
  rawHistory: (scope: SessionScope) => Promise<readonly unknown[]>
  client: McpAppClient
  logger: Logger
}): HermesMcpApps {
  const servers = createMcpServerCache<McpAppServer>(async (profile) =>
    hermesMcpServers(await input.servers(profile), input.client.credentialed)
  )
  const names = createMcpToolNames(
    HERMES_MCP_TOOL_NAMES,
    mcpToolCatalog(servers, input.client)
  )
  const mcpApps = createMcpAppsFallback(
    {
      servers: (scope) => servers.get(scope.agentId),
      async storedCall(scope, toolCallId) {
        const rows = await input.rawHistory(scope)
        const resolve = await names.load(scope.agentId)
        return storedCall(rows, toolCallId, resolve)
      },
    },
    input.client,
    input.logger
  )
  return { mcpApps, names }
}
