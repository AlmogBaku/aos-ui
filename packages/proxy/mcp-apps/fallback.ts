import type { Tool } from "@modelcontextprotocol/sdk/types.js"

import type { CallToolResult } from "../../protocol/mcp-apps"
import { isAosToolName, isAosUiServerName } from "../core/aos-tool-names"
import type {
  LiveMcpToolCall,
  ServerMcpApps,
  SessionScope,
} from "../core/runtime"
import { redactForLog } from "../redaction"
import type { McpAppClient, McpAppEndpoint } from "./client"
import {
  declaredResourceUri,
  isAppVisible,
  isUiResourceUri,
  splitCanonicalMcpName,
} from "./policy"

/**
 * The proxy-side MCP Apps host for a runtime that keeps no UI resources of its
 * own. It reaches the MCP server itself, so it serves only servers the proxy
 * can connect to: one that asks for no credentials, or one the operator
 * configured headers for. An adapter sets `url` for exactly those.
 */

/** One MCP server the runtime's native config registers. */
export type McpAppServer = {
  name: string
  /** A Streamable HTTP endpoint the proxy may connect to; absent otherwise. */
  url?: string
}

/** A tool call as the runtime stored it in the Session's own history. */
export type StoredMcpToolCall = {
  /** Canonical: `mcp__<server>__<tool>`, or a bare `aos-ui` tool. */
  toolName: string
  /** Absent while a running call's arguments are still streaming. */
  input?: Record<string, unknown>
  result?: CallToolResult
}

/** What an adapter answers for; everything else is provider-neutral. */
export type McpAppsSource = {
  servers(scope: SessionScope): Promise<readonly McpAppServer[]>
  /** The call only if this Session's own history holds it. */
  storedCall(
    scope: SessionScope,
    toolCallId: string
  ): Promise<StoredMcpToolCall | undefined>
}

/** Unknown call, another Session's call, or a call with no reachable view. */
export class McpAppNotFoundError extends Error {
  constructor() {
    super("MCP App not found")
    this.name = "McpAppNotFoundError"
  }
}

/** A view asked for a tool or resource outside what its own server grants. */
export class McpAppRefusedError extends Error {
  constructor() {
    super("MCP App request refused")
    this.name = "McpAppRefusedError"
  }
}

type Resolved = { endpoint: McpAppEndpoint; server: string; tool: string }

/** What one view request reached upstream; never its arguments. */
export type McpAppUpstreamLog = (fields: {
  operation: "open" | "tools/call" | "resources/read"
  agentId: string
  sessionId: string
  toolCallId: string
  server: string
  tool?: string
  uri?: string
}) => void

const writeUpstreamLog: McpAppUpstreamLog = (fields) =>
  console.info(
    JSON.stringify(redactForLog({ event: "mcp_app.upstream", ...fields }))
  )

/** Running calls the fallback remembers, across every Session it serves. */
const MAX_LIVE_CALLS = 256

/**
 * The server and tool a canonical name refers to. A bare `aos-ui` tool belongs
 * to whichever configured server is named `aos-ui` (or `aos_ui`).
 */
function splitToolName(
  toolName: string,
  serverNames: readonly string[]
): { server: string; tool: string } | undefined {
  if (!isAosToolName(toolName))
    return splitCanonicalMcpName(toolName, serverNames)
  const server = serverNames.find(isAosUiServerName)
  return server === undefined ? undefined : { server, tool: toolName }
}

export function createMcpAppsFallback(
  source: McpAppsSource,
  client: McpAppClient,
  log: McpAppUpstreamLog = writeUpstreamLog
): ServerMcpApps {
  /** Flagged calls of running turns, until the runtime stores them. */
  const live = new Map<string, StoredMcpToolCall>()
  const liveKey = (scope: SessionScope, toolCallId: string) =>
    JSON.stringify([scope.agentId, scope.sessionId, toolCallId])

  async function resolveServer(
    scope: SessionScope,
    toolName: string
  ): Promise<Resolved | undefined> {
    const servers = await source.servers(scope)
    const split = splitToolName(
      toolName,
      servers.map(({ name }) => name)
    )
    const url = split && servers.find(({ name }) => name === split.server)?.url
    return split && url
      ? { endpoint: { name: split.server, url }, ...split }
      : undefined
  }

  async function findTool(
    endpoint: McpAppEndpoint,
    name: string
  ): Promise<Tool | undefined> {
    const match = (tools: readonly Tool[]) =>
      tools.find((tool) => tool.name === name)
    return (
      match(await client.tools(endpoint)) ??
      match(await client.refreshTools(endpoint))
    )
  }

  /**
   * Native first: a stored result that names its view is authoritative, and
   * only a result without one falls back to the server's `tools/list`.
   */
  async function viewUri(
    resolved: Resolved,
    result: unknown
  ): Promise<string | undefined> {
    return (
      declaredResourceUri(result) ??
      declaredResourceUri(await findTool(resolved.endpoint, resolved.tool))
    )
  }

  /** The stored call, else the running one this Session's own run reported. */
  async function owned(scope: SessionScope, toolCallId: string) {
    const call =
      (await source.storedCall(scope, toolCallId)) ??
      live.get(liveKey(scope, toolCallId))
    const resolved = call && (await resolveServer(scope, call.toolName))
    if (!call || !resolved) throw new McpAppNotFoundError()
    return { call, resolved }
  }

  function logged(
    scope: SessionScope,
    toolCallId: string,
    resolved: Resolved,
    fields: Pick<Parameters<McpAppUpstreamLog>[0], "operation" | "tool" | "uri">
  ) {
    log({
      agentId: scope.agentId,
      sessionId: scope.threadId,
      toolCallId,
      server: resolved.server,
      ...fields,
    })
  }

  return {
    observe(scope, { toolCallId, ...call }: LiveMcpToolCall) {
      const key = liveKey(scope, toolCallId)
      const known = live.get(key)
      const input = call.input ?? known?.input
      const result = call.result ?? known?.result
      // Re-inserted, so the oldest call is the one dropped past the cap.
      live.delete(key)
      live.set(key, {
        toolName: call.toolName,
        ...(input ? { input } : {}),
        ...(result ? { result } : {}),
      })
      if (live.size > MAX_LIVE_CALLS) live.delete(live.keys().next().value!)
    },
    async describe(scope, call) {
      try {
        const resolved = await resolveServer(scope, call.toolName)
        return Boolean(resolved && (await viewUri(resolved, call.result)))
      } catch {
        return false
      }
    },
    async open(scope, toolCallId) {
      const { call, resolved } = await owned(scope, toolCallId)
      const uri = await viewUri(resolved, call.result)
      if (!uri) throw new McpAppNotFoundError()
      logged(scope, toolCallId, resolved, {
        operation: "open",
        tool: resolved.tool,
        uri,
      })
      const resource = await client.appResource(resolved.endpoint, uri)
      return {
        ...resource,
        ...(call.input ? { toolInput: call.input } : {}),
        ...(call.result ? { toolResult: call.result } : {}),
      }
    },
    async callTool(scope, toolCallId, name, args) {
      const { resolved } = await owned(scope, toolCallId)
      const tool = await findTool(resolved.endpoint, name)
      if (!tool || !isAppVisible(tool)) throw new McpAppRefusedError()
      logged(scope, toolCallId, resolved, {
        operation: "tools/call",
        tool: name,
      })
      return client.callTool(resolved.endpoint, name, args)
    },
    async readResource(scope, toolCallId, uri) {
      const { resolved } = await owned(scope, toolCallId)
      if (!isUiResourceUri(uri)) throw new McpAppRefusedError()
      logged(scope, toolCallId, resolved, { operation: "resources/read", uri })
      return client.readResource(resolved.endpoint, uri)
    },
  }
}
